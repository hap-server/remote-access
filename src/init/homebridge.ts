/// <reference types="@hap-server/hap-server/types/homebridge" />

import {API as HomebridgeAPI, PlatformInstance} from 'homebridge/lib/api';

import TunnelClient, {TunnelState} from '../client';
import {ServiceConnection} from '../client/connection';
import {MessageType, ServiceType, AddHostStatus} from '../common/message-types';
import * as net from 'net';
import * as tls from 'tls';
import {promises as fs} from 'fs';
import * as path from 'path';
import * as os from 'os';
import {getSecureContext, AcmeHttp01Service} from './tls';
import uuid = require('uuid/v4');

export default function initHomebridgePlugin(homebridge: HomebridgeAPI) {
    homebridge.registerPlatform('remote-access', 'TunnelServiceConfiguration', TunnelPlugin.use(homebridge));
}

interface Configuration {
    server: string;
    hostname?: string;
    proxy: ProxyConfiguration;
    certbot_path?: string;
    certbot_data_path?: string;
    certbot_acme_server?: string;
    certbot_agree_tos: boolean;
    certbot_email_address?: string;
}

interface ProxyConfiguration {
    port: number;
    host?: string;
}

export class TunnelPlugin implements PlatformInstance {
    config: any;
    path = path.join(os.homedir(), '.homebridge', 'persist');
    certbot_data_path = path.join(os.homedir(), '.homebridge', 'remote-access-certbot');

    proxy: net.Server | ProxyConfiguration;
    log: import('@hap-server/api/homebridge').Logger | typeof console = console;

    constructor(config: Configuration) {
        this.config = config;
        this.proxy = this.config.proxy;
    }

    static use(homebridge: HomebridgeAPI) {
        return class extends TunnelPlugin implements PlatformInstance {
            path = homebridge.user.persistPath();
            certbot_data_path = path.join(homebridge.user.storagePath(), 'remote-access-certbot');

            constructor(log: import('@hap-server/api/homebridge').Logger, config: any, homebridge_api: HomebridgeAPI) {
                super(config);
                this.log = log;
            }
        };
    }

    readonly tls_server = (() => {
        const tls_server = tls.createServer({
            SNICallback: (servername: string, callback: (err: Error | null, context: tls.SecureContext) => void) => {
                // @ts-ignore
                this.getSecureContext(servername).then(context => (callback(null, context), context), callback);
            },
        });

        tls_server.on('secureConnection', socket => {
            if (this.proxy instanceof tls.Server) {
                this.proxy.emit('secureConnection', socket);
                return;
            }
            if (this.proxy instanceof net.Server) {
                this.proxy.emit('connection', socket);
                return;
            }
            
            if (!('port' in this.proxy)) return;

            const proxy_socket = net.connect({
                port: this.proxy.port,
                host: this.proxy.host ?? '::1',
            });

            proxy_socket.pipe(socket);
            socket.pipe(proxy_socket);

            proxy_socket.on('error', err => socket.destroy(err));
            socket.on('error', err => proxy_socket.destroy(err));
        });

        return tls_server;
    })();
    readonly tunnel_client = (() => {
        const tunnel_client = new TunnelClient();

        tunnel_client.log = this.log;
        tunnel_client.url = 'ts://127.0.0.1:9000';

        tunnel_client.on('service-connection', (service_connection: ServiceConnection) => {
            if (service_connection.options.service_type === ServiceType.ACME_HTTP01_CHALLENGE) {
                this.acme_http01_challenge.handleConnection(service_connection);
            } else {
                this.handleServiceConnection(service_connection);
            }
        });

        return tunnel_client;
    })();

    acme_http01_challenge = new AcmeHttp01Service(this);

    handleServiceConnection(service_connection: ServiceConnection) {
        this.log.info('Handling service connection from %s port %d on server %s port %d',
            service_connection.remoteAddress, service_connection.remotePort,
            service_connection.localAddress, service_connection.localPort);

        this.tls_server.emit('connection', service_connection);
    }

    url: string | null = null;
    hostname: string | null = null;

    async load() {
        if (!this.url) {
            if (typeof this.config.server !== 'string') {
                throw new Error('Invalid configuration - no server URL');
            }

            this.tunnel_client.url = this.url = this.config.server;
        }

        if (!this.hostname && this.config.hostname) {
            this.tunnel_client.connectService(ServiceType.HTTPS, 0, this.hostname = this.config.hostname);
        }

        if (!this.hostname) {
            const server_uuid_path = path.join(this.path, 'TunnelServiceServerUUID');

            let server_uuid: string | null = JSON.parse(await fs.readFile(server_uuid_path, 'utf-8'))?.value || null;
            if (!server_uuid) await fs.writeFile(server_uuid_path, JSON.stringify({
                key: 'TunnelServiceServerUUID',
                value: server_uuid = uuid(),
            }, null, 4) + '\n', 'utf-8');

            const service_path = path.join(this.path, 'TunnelServiceConfiguration.' + server_uuid);

            let service: {
                type: ServiceType;
                identifier: number;
                hostname: string;
            } | null = JSON.parse(await fs.readFile(service_path, 'utf-8'))?.value || null;

            if (!service) {
                await this.tunnel_client.connect();
                const connection = this.tunnel_client.connection!;

                // Get the domains for this tunnel server
                connection.send(MessageType.LIST_DOMAINS, Buffer.alloc(0));
                let [, remaining_domains_data] =
                    await connection.waitForMessage(type => type === MessageType.LIST_DOMAINS);
                const domains: string[] = [];
                while (remaining_domains_data.length) {
                    if (remaining_domains_data.length < 4) continue;
                    const length = remaining_domains_data.readUInt32BE(0);
                    if (remaining_domains_data.length < 4 + length) continue;
                    const domain = remaining_domains_data.slice(4, 4 + length);
                    remaining_domains_data = remaining_domains_data.slice(4 + length);
                    domains.push(domain.toString());
                }
                if (!domains.length) {
                    throw new Error('Tunnel server doesn\'t offer any domains. You need to configure it manually.');
                }
                if (domains.length >= 2) {
                    throw new Error('Tunnel server offers more than one domain. You need to configure it manually.');
                }

                // Register a hostname for this server
                connection.send(MessageType.ADD_HOST, Buffer.from(server_uuid + '.' + domains[0]));
                const [, data] = await connection.waitForMessage(type => type === MessageType.ADD_HOST);
                const status: AddHostStatus = data.readUInt32BE(0);
                
                if (status !== AddHostStatus.SUCCESS) {
                    const error = new Error('Error registering hostname ' + status +
                        (AddHostStatus[status] ? ' (' + AddHostStatus[status] + ')' : ''));
                    // @ts-ignore
                    error.code = status;
                    throw error;
                }

                await fs.writeFile(service_path, JSON.stringify({
                    key: 'TunnelServiceConfiguration.' + server_uuid,
                    value: service = {
                        type: ServiceType.HTTPS,
                        identifier: 0,
                        hostname: server_uuid + '.' + domains[0],
                    },
                }, null, 4), 'utf-8');
            }

            this.tunnel_client.connectService(service.type, service.identifier, this.hostname = service.hostname);
        }

        this.tunnel_client.connectService(ServiceType.ACME_HTTP01_CHALLENGE, 0, this.hostname);

        this.tunnel_client.setTargetState(TunnelState.CONNECTED);
    }
    
    accessories() {
        this.accessories = () => {};
        this.load();
    }

    secure_context: Promise<tls.SecureContext> | null = null;
    secure_context_timeout: NodeJS.Timeout | null = null;

    async getSecureContext(servername: string): Promise<tls.SecureContext> {
        if (!this.hostname || this.hostname !== servername) throw new Error('Invalid servername');

        return this.secure_context || (this.secure_context = this._getSecureContext().catch(err => {
            this.secure_context = null;
            throw err;
        }).then(context => {
            this.secure_context_timeout = setTimeout(() => {
                this.secure_context = null;
                this.secure_context_timeout = null;
            }, 60000);

            return context;
        }));
    }

    async _getSecureContext() {
        return getSecureContext(this);
    }
}

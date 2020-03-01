/// <reference types="@hap-server/hap-server/types/homebridge" />

import {API as HomebridgeAPI, PlatformInstance} from 'homebridge/lib/api';

import TunnelClient, {TunnelState} from '../client';
import {ServiceConnection} from '../client/connection';
import {MessageType, ServiceType, AddHostStatus} from '../common/message-types';
import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import uuid = require('uuid/v4');

export default function initHomebridgePlugin(homebridge: HomebridgeAPI) {
    homebridge.registerPlatform('remote-access', 'TunnelServiceConfiguration', TunnelPlugin.use(homebridge));
}

interface ProxyConfiguration {
    port: number;
    host?: string;
}

export class TunnelPlugin implements PlatformInstance {
    config: any;
    path = path.join(os.homedir(), '.homebridge', 'persist');

    proxy: net.Server | ProxyConfiguration;
    log: import('@hap-server/api/homebridge').Logger | typeof console = console;

    constructor(config: any) {
        this.config = config;
        this.proxy = this.config.proxy;
    }

    static use(homebridge: HomebridgeAPI) {
        return class extends (this.constructor as typeof TunnelPlugin) {
            path = homebridge.user.persistPath();

            constructor(config: any, log: import('@hap-server/api/homebridge').Logger) {
                super(config);
                this.log = log;
            }
        };
    }

    readonly tls_server = (() => {
        const tls_server = tls.createServer({
            // cert: ...,
            // key: ...,
        });

        tls_server.on('secureConnection', socket => {
            if (this.proxy instanceof net.Socket) {
                this.proxy.emit('connection', socket);
            }
            
            if (!('port' in this.proxy)) return;

            const proxy_socket = net.createConnection({
                port: this.proxy.port,
                host: this.proxy.host,
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
            const data = service_connection.read(1);
            if (!data) return service_connection.once('readable', () => tunnel_client.emit('service-connection', service_connection));
            const first_byte = data[0];
            service_connection.unshift(data);
            if (first_byte < 32 || first_byte >= 127) {
                this.tls_server.emit('connection', service_connection);
            } else {
                this.tls_server.emit('secureConnection', service_connection);
            }
        });

        return tunnel_client;
    })();

    url: string | null = null;
    hostname: string | null = null;

    async load() {
        if (!this.url) {
            if (typeof this.config.server !== 'string') {
                throw new Error('Invalid configuration - no server URL');
            }

            this.tunnel_client.url = this.url = this.config.server;
        }

        if (!this.hostname) {
            const server_uuid_path = path.join(this.path, 'TunnelServiceServerUUID');

            let server_uuid: string | null =
                JSON.parse(await fs.promises.readFile(server_uuid_path, 'utf-8'))?.value || null;
            if (!server_uuid) await fs.promises.writeFile(server_uuid_path, JSON.stringify({
                key: 'TunnelServiceServerUUID',
                value: server_uuid = uuid(),
            }, null, 4) + '\n', 'utf-8');

            const service_path = path.join(this.path, 'TunnelServiceConfiguration.' + server_uuid);

            let service: {
                type: ServiceType;
                identifier: number;
                hostname: string;
            } | null = JSON.parse(
                await fs.promises.readFile(service_path, 'utf-8')
            )?.value || null;

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

                await fs.promises.writeFile(service_path, JSON.stringify({
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

        this.tunnel_client.setTargetState(TunnelState.CONNECTED);
    }
    
    accessories() {
        this.accessories = () => {};
        this.load();
    }
}

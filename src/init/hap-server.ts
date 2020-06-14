import hapserver, {ServerPlugin, log} from '@hap-server/api';
import storage from '@hap-server/api/storage';
import TunnelClient, {TunnelState} from '../client';
import {ServiceConnection} from '../client/connection';
import {MessageType, ServiceType, AddHostStatus} from '../common/message-types';
import * as tls from 'tls';
import * as path from 'path';
import {getSecureContext, AcmeHttp01Service} from './tls';
import uuid = require('uuid/v4');

log.info('Loading tunnel plugin');

export class TunnelPlugin extends ServerPlugin {
    certbot_data_path: string;

    constructor(server: import('@hap-server/hap-server/server').Server, config: any) {
        super(server, config || (config = require('@hap-server/api/plugin-config')?.['server-plugins']?.['*'] || {}));

        // TODO: add some way of getting a path to store data in for plugins instead of using node-persist
        this.certbot_data_path =
            path.join(hapserver.plugin.plugin_manager.storage_path, hapserver.plugin.name, 'certbot');
    }

    readonly https_server = (() => {
        const https_server = this.server.createSecureServer({
            // @ts-ignore
            SNICallback: (servername: string, callback: (err: Error | null, context?: tls.SecureContext) => void) => {
                this.getSecureContext(servername).then(context => (callback(null, context), context), callback);
            },
        });

        return https_server;
    })();
    readonly tunnel_client = (() => {
        const tunnel_client = new TunnelClient();

        tunnel_client.log = log;
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
        log.info('Handling service connection from %s port %d on server %s port %d',
            service_connection.remoteAddress, service_connection.remotePort,
            service_connection.localAddress, service_connection.localPort);

        this.https_server.emit('connection', service_connection);
    }

    url: string | null = null;
    hostname: string | null = null;

    async load() {
        log.info('Loading tunnel server plugin', this);

        if (!this.url) {
            if (typeof this.config.server !== 'string') {
                log.error('Invalid configuration - no server URL');
                return;
            }

            this.tunnel_client.url = this.url = this.config.server;
        }

        if (!this.hostname && this.config.hostname) {
            this.tunnel_client.connectService(ServiceType.HTTPS, 0, this.hostname = this.config.hostname);
        }

        if (!this.hostname) {
            let server_uuid: string | null = await this.server.storage.getItem('TunnelServiceServerUUID') || null;
            if (!server_uuid) await this.server.storage.setItem('TunnelServiceServerUUID', server_uuid = uuid());

            let service: {
                type: ServiceType;
                identifier: number;
                hostname: string;
            } | null = await storage.getItem('ServiceConfiguration.' + server_uuid) || null;

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

                await storage.setItem('ServiceConfiguration.' + server_uuid, service = {
                    type: ServiceType.HTTPS,
                    identifier: 0,
                    hostname: server_uuid + '.' + domains[0],
                });
            }

            this.tunnel_client.connectService(service.type, service.identifier, this.hostname = service.hostname);
        }

        this.tunnel_client.connectService(ServiceType.ACME_HTTP01_CHALLENGE, 0, this.hostname);

        this.tunnel_client.setTargetState(TunnelState.CONNECTED);
    }

    async unload() {
        this.tunnel_client.setTargetState(TunnelState.DISCONNECTED);

        clearTimeout(this.secure_context_timeout!);
        this.secure_context = null;
        this.secure_context_timeout = null;
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

hapserver.registerServerPlugin(TunnelPlugin);

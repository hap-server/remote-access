import hapserver, {ServerPlugin, log} from '@hap-server/api';
import storage from '@hap-server/api/storage';
import TunnelClient, {TunnelState} from '../client';
import {ServiceConnection} from '../client/connection';
import {MessageType, ServiceType} from '../common/message-types';
import * as https from 'https';
import * as fs from 'fs';
import uuid = require('uuid/v4');

log.info('Loading tunnel plugin');

export class TunnelPlugin extends ServerPlugin {
    readonly https_server = (() => {
        const https_server = this.server.createSecureServer({
            // cert: ...,
            // key: ...,
        });

        return https_server;
    })();
    readonly tunnel_client = (() => {
        const tunnel_client = new TunnelClient();

        tunnel_client.url = 'ts://127.0.0.1:9000';

        tunnel_client.on('service-connection', (service_connection: ServiceConnection) => {
            const data = service_connection.read(1);
            if (!data) return service_connection.once('readable', () => tunnel_client.emit('service-connection', service_connection));
            const first_byte = data[0];
            service_connection.unshift(data);
            if (first_byte < 32 || first_byte >= 127) {
                this.https_server.emit('connection', service_connection);
            } else {
                this.https_server.emit('secureConnection', service_connection);
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
                connection?.send(MessageType.LIST_DOMAINS, Buffer.alloc(0));
                let [, remaining_domains_data] = await connection!.waitForMessage(type => type === MessageType.LIST_DOMAINS);
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
                await storage.setItem('ServiceConfiguration.' + server_uuid, service = {
                    type: ServiceType.HTTPS,
                    identifier: 0,
                    hostname: server_uuid + '.' + domains[0],
                });
            }

            this.tunnel_client.connectService(service.type, service.identifier, this.hostname = service.hostname);
        }

        this.tunnel_client.setTargetState(TunnelState.CONNECTED);
    }

    async unload() {
        this.tunnel_client.setTargetState(TunnelState.DISCONNECTED);
    }
}

hapserver.registerServerPlugin(TunnelPlugin);

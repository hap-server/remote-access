import TunnelClient, {TunnelState} from '../client';
import {ServiceConnection} from '../client/connection';
import {MessageType, RegisterState, ServiceType} from '../common/message-types';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';

const client = new TunnelClient();

(async () => {
    client.url = 'ts://127.0.0.1:9000';

    console.log('Connecting to', client.url);
    await client.connect();

    if (process.argv[3] === 'service') {
        // bin/tunnelctl $AUTH service $TYPE $IDENTIFIER $HOSTNAME
        // bin/tunnelctl - service HTTP 0 localhost
        // bin/tunnelctl - service HTTPS 0 localhost
        // bin/tunnelctl - service HTTP_HTTPS 0 localhost

        const [,, auth,, _service_type, _service_identifier, hostname] = process.argv;
        const service_type: ServiceType =
            parseInt(_service_type) || ServiceType[_service_type as keyof typeof ServiceType];
        const service_identifier = parseInt(_service_identifier);

        const status = await client.connectService(service_type, service_identifier, hostname);

        client.on('service-connection', (service_connection: ServiceConnection) => {
            console.log('New connection from %s port %d, server %s port %d',
                service_connection.remoteAddress, service_connection.remotePort,
                service_connection.localAddress, service_connection.localPort);
            (service_type === ServiceType.HTTP ? http_server :
                service_type === ServiceType.HTTPS ? https_server :
                service_type === ServiceType.HTTP_HTTPS ? http_https_server :
                null)!.emit('connection', service_connection);
        });

        const http_server = http.createServer((req, res) => {
            res.end('It works!\n');
        });
        const https_server = https.createServer({
            // cert: ...,
            // key: ...,
        }, (req, res) => {
            res.end('It works!\n');
        });
        const http_https_server: net.Server = net.createServer(connection => {
            const data = connection.read(1);
            if (!data) return connection.once('readable', () => http_https_server.emit('connection', connection));
            const first_byte = data[0];
            connection.unshift(data);
            if (first_byte < 32 || first_byte >= 127) {
                https_server.emit('connection', connection);
            } else {
                http_server.emit('connection', connection);
            }
        });
    }
})();

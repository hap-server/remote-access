import TunnelServer, {Service} from './index';
import Connection from './connection';
import {ConnectServiceStatus, DisconnectServiceStatus} from '../common/message-types';
import * as net from 'net';
import isTlsClientHello = require('is-tls-client-hello');
import extractSni = require('sni');

export default class HttpService implements Service {
    readonly tunnel_server_connections = new Map<string, Connection>();
    readonly connections: (net.Socket & {service_hostname?: string;})[] = [];

    hostname_regex: RegExp | null = null;

    constructor(readonly tunnel_server: TunnelServer, readonly server: net.Server) {
        //
    }

    checkHostnameSupported(hostname: string) {
        if (!this.hostname_regex) return true;
        return this.hostname_regex.test(hostname);
    }

    connect(hostname: string, connection: Connection) {
        if (this.tunnel_server_connections.has(hostname)) return ConnectServiceStatus.OTHER_CLIENT_CONNECTED;
        this.tunnel_server_connections.set(hostname, connection);
        console.log('Connecting default HTTPS service for %s to %s port %d',
            hostname, connection.socket.remoteAddress, connection.socket.remotePort);
        return ConnectServiceStatus.SUCCESS;
    }

    disconnect(hostname: string, connection: Connection, disconnected: boolean) {
        if (this.tunnel_server_connections.get(hostname) !== connection) return DisconnectServiceStatus.WASNT_CONNECTED;
        this.tunnel_server_connections.delete(hostname);
        console.log('Disconnecting default HTTPS service for %s from %s port %d',
            hostname, connection.socket.remoteAddress, connection.socket.remotePort);
        for (const socket of this.connections) {
            if (socket.service_hostname !== hostname) continue;
            socket.destroy();
        }
        return DisconnectServiceStatus.SUCCESS;
    }

    static async create(tunnel_server: TunnelServer, options?: net.ListenOptions) {
        const server = net.createServer(socket => {
            service.handleConnection(socket);
        });

        await new Promise<void>((resolve, reject) => {
            const onlistening = () => {
                resolve();

                server.removeListener('listening', onlistening);
                server.removeListener('error', onerror);
            };
            const onerror = (err: Error) => {
                reject(err);

                server.removeListener('listening', onlistening);
                server.removeListener('error', onerror);
            };

            server.on('listening', onlistening);
            server.on('error', onerror);

            server.listen(options);
        });

        const service = new this(tunnel_server, server);
        return service;
    }

    handleConnection(socket: net.Socket & {service_hostname?: string;}) {
        this.connections.push(socket);

        let hostname: string | null = null;
        let buffer = Buffer.alloc(0);

        const ondata = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            // Make sure we have enough data to get at least the record length
            // (ContentType + ProtocolVersion + length)
            if (buffer.length < 5) return;

            // Verify protocol version is > 3.0 && <= 3.3
            if (buffer[1] !== 3) return;
            if (buffer[2] < 1 || buffer[2] > 3) return;

            // Verify we have enough data to parse the record
            var length = buffer[3] << 8 | buffer[4];
            if (buffer.length < 5 + length) return;

            socket.removeListener('data', ondata);

            if (!isTlsClientHello(buffer)) {
                // Invalid TLS Client Hello
                console.warn('Invalid TLS Client Hello');
                socket.destroy();
                return;
            }

            const sni = extractSni(buffer);

            if (!sni) {
                // No TLS Server Name Indication extension
                console.warn('No TLS Server Name Indication extension');
                socket.destroy();
                return;
            }

            socket.service_hostname = hostname = sni;

            // Get the tunnel server connection for this service hostname
            const connection = this.tunnel_server_connections.get(hostname);

            if (!connection) {
                // No client is connected to this service for the hostname
                console.warn('Service %s not connected', hostname);
                socket.destroy();
                return;
            }

            const tunnel_socket = connection.createServiceConnection(this, hostname, {
                local_address: socket.localAddress,
                local_port: socket.localPort,
                remote_address: socket.remoteAddress!,
                remote_port: socket.remotePort!,
            });

            tunnel_socket.write(buffer);

            socket.pipe(tunnel_socket);
            tunnel_socket.pipe(socket);

            socket.on('close', () => tunnel_socket.destroy());
            tunnel_socket.on('close', () => socket.destroy());
        };
        const onclose = () => {
            this.connections.splice(this.connections.indexOf(socket), 1);
            socket.removeListener('data', ondata);
            socket.removeListener('close', onclose);
        };

        socket.on('data', ondata);
        socket.on('close', onclose);
    }
}

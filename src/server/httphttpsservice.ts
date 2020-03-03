import TunnelServer, {Service} from './index';
import Connection from './connection';
import {ConnectServiceStatus, DisconnectServiceStatus} from '../common/message-types';
import * as net from 'net';
import isTlsClientHello = require('is-tls-client-hello');
import extractSni = require('sni');
import httpHeaders = require('http-headers');

type DefaultResponseData = Buffer | string | {
    raw: Buffer | string;
    close?: boolean;
} | {
    code?: number;
    status?: string;
    headers?: Record<string, string | string[]>;
    body: Buffer | string;
    close?: boolean;
};

export default class HttpHttpsService implements Service {
    readonly tunnel_server_connections = new Map<string, Connection>();
    readonly connections: (net.Socket & {service_hostname?: string;})[] = [];

    hostname_regex: RegExp | null = null;
    default_response:
        DefaultResponseData | ((socket: net.Socket, request: httpHeaders.HttpRequest) => DefaultResponseData) =
        `Service not connected\n`;

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
        console.log('Connecting default HTTP/HTTPS service for %s to %s port %d',
            hostname, connection.socket.remoteAddress, connection.socket.remotePort);
        return ConnectServiceStatus.SUCCESS;
    }

    disconnect(hostname: string, connection: Connection, disconnected: boolean) {
        if (this.tunnel_server_connections.get(hostname) !== connection) return DisconnectServiceStatus.WASNT_CONNECTED;
        this.tunnel_server_connections.delete(hostname);
        console.log('Disconnecting default HTTP/HTTPS service for %s from %s port %d',
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

        let type: 'http' | 'tls' | null = null;
        let hostname: string | null = null;
        let buffer = Buffer.alloc(0);

        const ondata = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            if (buffer.length < 1) return;
            type = buffer[0] < 32 || buffer[0] >= 127 ? 'tls' : 'http';

            if (type === 'tls') {
                // Make sure we have enough data to get at least the record length
                // (ContentType + ProtocolVersion + length)
                if (buffer.length < 5) return;

                // Verify protocol version is > 3.0 && <= 3.3
                if (buffer[1] !== 3) return;
                if (buffer[2] < 1 || buffer[2] > 3) return;

                // Verify we have enough data to parse the record
                var length = buffer[3] << 8 | buffer[4];
                if (buffer.length < 5 + length) return;
            } else {
                const index = buffer.indexOf('\r\n\r\n');
                // Haven't received headers yet
                if (index < 0) return;
            }

            socket.removeListener('data', ondata);

            const request = type === 'http' ?
                httpHeaders(buffer.slice(0, buffer.indexOf('\r\n\r\n'))) as httpHeaders.HttpRequest : null;
            if (request && (typeof request.version === 'string' || !('url' in request))) {
                const response = 'Service unavailable\n';
                socket.end(`HTTP/1.1 400 Bad Request\r\n` +
                    `Date: ${new Date()}\r\n` +
                    `Connection: close\r\n` +
                    `Content-Type: text/plain\r\n` +
                    `Content-Length: ${response.length}\r\n` +
                    `\r\n` + response);
            }

            if (type === 'tls') {
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
            } else {
                const index = buffer.indexOf('\r\n\r\n');
                socket.service_hostname = hostname = request!.headers.host;

                // If the hostname includes a port number remove this
                // TLS SNI values don't include port numbers, but HTTP Host headers do if not 80/443
                if (hostname.match(/\:\d+$/)) {
                    socket.service_hostname = hostname = hostname.substr(0, hostname.lastIndexOf(':'));
                }
            }

            // Get the tunnel server connection for this service hostname
            const connection = this.tunnel_server_connections.get(hostname);

            if (!connection) {
                // No client is connected to this service for the hostname
                if (type === 'tls') {
                    console.warn('Service %s not connected', hostname);
                    socket.destroy();
                } else {
                    const response = typeof this.default_response === 'function' ?
                        this.default_response.call(undefined, socket, request!) : this.default_response;
                    const raw_response = typeof response === 'object' && !(response instanceof Buffer) ?
                        'raw' in response ? response.raw :
                        Buffer.concat([
                            Buffer.from(`HTTP/1.1 ${response.code || 502} ${response.status || 'Proxy Error'}\r\n`),
                            this.buildHttpResponseHeaders({
                                'Date': '' + new Date(), 
                                'Connection': 'close',
                                'Content-Type': 'text/plain',
                                'Content-Length': '' + response.body.length,
                            }, response.headers || {}),
                            Buffer.from('\r\n'),
                            response.body instanceof Buffer ? response.body : Buffer.from(response.body),
                        ]) :
                        `HTTP/1.1 502 Proxy Error\r\n` +
                        `Date: ${new Date()}\r\n` +
                        `Connection: close\r\n` +
                        `Content-Type: text/plain\r\n` +
                        `Content-Length: ${response.length}\r\n` +
                        `\r\n` + response;
                    socket.write(raw_response);
                    if (typeof response !== 'object' || !('close' in response) || response.close) socket.end();
                }
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

            socket.on('error', err => {
                console.error('Error in default HTTP/HTTPS service %s connection from %s port %d',
                    hostname, socket.remoteAddress, socket.remotePort, err);
            });
            tunnel_socket.on('error', err => {
                console.error('Error in default HTTP/HTTPS service %s tunnel connection from %s port %d',
                    hostname, socket.remoteAddress, socket.remotePort, err);
            });
        };
        const onclose = () => {
            this.connections.splice(this.connections.indexOf(socket), 1);
            socket.removeListener('data', ondata);
            socket.removeListener('close', onclose);
        };

        socket.on('data', ondata);
        socket.on('close', onclose);
    }

    private buildHttpResponseHeaders(...all_headers: Record<string, string | string[]>[]) {
        const headers = {} as Record<string, string[]>;

        for (const all_headers2 of all_headers) {
            for (const [key, value] of Object.entries(all_headers2)) {
                headers[key] = value instanceof Array ? value : [value];
            }
        }

        let data = '';

        for (const [name, values] of Object.entries(headers)) {
            for (const value of values) {
                data += `${name}: ${value}\r\n`;
            }
        }

        return Buffer.from(data);
    }
}

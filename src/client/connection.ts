import BaseConnection from '../common/connection';
import * as net from 'net';
import * as tls from 'tls';
import {promises as dns, SrvRecord} from 'dns';
import {parse as parseUrl, UrlWithStringQuery} from 'url';
import {parse as parseQueryString, ParsedUrlQuery} from 'querystring';
import * as stream from 'stream';
import {
    MessageType, ServiceType, ConnectServiceStatus, DisconnectServiceStatus, CloseConnectionStatus,
} from '../common/message-types';

export enum ConnectionProtocol {
    TUNNEL = 'ts:',
    SECURE_TUNNEL = 'tss:',
}

export interface ServerTlsInfo {
    sni: string;
    context?: tls.SecureContext;
}

export interface ServerDiscoveryInfo {
    srv: SrvRecord[];
    txt: string[][];
}

export interface ServerInfo {
    urldata: UrlWithStringQuery;
    hashdata: ParsedUrlQuery;
    host: string;
    port: number;
    tls: ServerTlsInfo | null;
    dnssd: ServerDiscoveryInfo | null;
}

export default class Connection extends BaseConnection {
    readonly url: string;
    readonly socket: net.Socket | tls.TLSSocket;
    readonly services: string[] = [];
    readonly service_connections = new Map<number, ServiceConnection>();

    constructor(url: string, socket: net.Socket) {
        super();

        this.url = url;
        this.socket = socket;

        socket.on('data', (data: Buffer) => {
            this.handleData(data);
        });

        socket.on('end', () => {
            this.emit('close');
        });
    }

    close() {
        this.socket.end();
    }

    protected _write(data: Buffer) {
        this.socket.write(data);
    }

    handleMessage(type: MessageType, data: Buffer) {
        this.emit('message', type, data);

        console.warn('Received message', type, MessageType[type], data);

        if (type === MessageType.CONNECTION) {
            this.handleServiceConnection(data);
        }
        if (type === MessageType.MESSAGE) {
            const connection_id = data.readUInt16BE(0);
            this.service_connections.get(connection_id)?.push(data.slice(2));
        }
        if (type === MessageType.CLOSE_CONNECTION) {
            const connection_id = data.readUInt16BE(0);
            this.service_connections.get(connection_id)?.destroy();
        }
    }

    private handleServiceConnection(data: Buffer) {
        const connection_id = data.readUInt16BE(0);
        const service_name_length = data.readUInt16BE(2);

        const options = {
            service_type: data.readUInt16BE(4),
            service_identifier: data.readUInt16BE(6),
            hostname: data.slice(10, 4 + service_name_length).toString(),

            // TODO: read server/remote client IP addresses
            server_address: data.slice(4 + service_name_length, 20 + service_name_length).toString('hex'),
            server_port: data.readUInt16BE(20 + service_name_length),
            remote_address: data.slice(22 + service_name_length, 38 + service_name_length).toString('hex'),
            remote_port: data.readUInt16BE(38 + service_name_length),
        };

        const service_connection = new ServiceConnection(this, connection_id, options);
        this.emit('service-connection', service_connection);
    }

    private getServiceName(type: ServiceType, identifier: number, hostname: string) {
        const header = Buffer.alloc(6);
        header.writeUInt16BE(type, 0);
        header.writeUInt32BE(identifier, 2);

        return Buffer.concat([header, Buffer.from(hostname)]);
    }

    connectService(type: ServiceType, identifier: number, hostname: string) {
        const service = this.getServiceName(type, identifier, hostname);

        if (this.services.includes(service.toString())) return;

        this.send(MessageType.CONNECT_SERVICE, service);
        this.services.push(service.toString());

        return this.waitForMessage(type => type === MessageType.CONNECT_SERVICE).then(([, data]) => {
            if (data.length !== 1) throw new Error('Invalid response');
            return data.readUInt8(0) as ConnectServiceStatus;
        });
    }

    disconnectService(type: ServiceType, identifier: number, hostname: string) {
        const service = this.getServiceName(type, identifier, hostname);

        if (!this.services.includes(service.toString())) return;

        this.send(MessageType.DISCONNECT_SERVICE, service);
        this.services.splice(this.services.indexOf(service.toString()), 1);

        return this.waitForMessage(type => type === MessageType.DISCONNECT_SERVICE).then(([, data]) => {
            if (data.length !== 1) throw new Error('Invalid response');
            return data.readUInt8(0) as DisconnectServiceStatus;
        });
    }

    /**
     * Connect to a tunnel server.
     *
     * @param {string} url Tunnel server URL
     * @param {number} [timeout=10000]
     */
    static async connect(url: string, timeout = 10000) {
        const serverinfo = await this.resolveServiceUrl(url);

        const socket = await new Promise<net.Socket | tls.TLSSocket>((rs, rj) => {
            const onconnect = () => {
                rs(socket);
                socket.removeListener(serverinfo.tls ? 'secureConnect' : 'connect', onconnect);
                socket.removeListener('error', onerror);
            };
            const onerror = (err: Error) => {
                rj(err);
                socket.removeListener(serverinfo.tls ? 'secureConnect' : 'connect', onconnect);
                socket.removeListener('error', onerror);
            };

            const socket: net.Socket | tls.TLSSocket = serverinfo.tls ? tls.connect({
                host: serverinfo.host, port: serverinfo.port, timeout,

                servername: serverinfo.tls.sni,
                secureContext: serverinfo.tls.context,
                // checkServerIdentity: (_host, cert) => {
                //     return this.checkServerIdentity(url, serverinfo, socket, _host, cert);
                // },
            }, onconnect) : net.createConnection({
                host: serverinfo.host, port: serverinfo.port, timeout,
            }, onconnect);

            socket.on('error', onerror);
        });

        const connection = new Connection(url, socket);

        return connection;
    }

    static async resolveServiceUrl(url: string): Promise<ServerInfo> {
        const urldata = parseUrl(url);

        if (!urldata.hostname) throw new Error('Missing host');

        if (!urldata.protocol) {
            const hashdata = parseQueryString(urldata.hash ? urldata.hash.substr(1) : '');

            // DNS service discovery
            const resolver = new dns.Resolver();

            if (hashdata.resolver) {
                resolver.setServers(([] as string[]).concat(hashdata.resolver).join(',').split(','));
            }

            const [srv, txt] = await Promise.all([
                resolver.resolve(urldata.hostname, 'SRV').then(srv => srv.sort((a, b) => {
                    if (a.priority > b.priority) return 1;
                    if (b.priority < a.priority) return -1;

                    // TODO: random sort using weight
                    return 0;
                })),
                resolver.resolve(urldata.hostname, 'TXT'),
            ]);

            let tlsinfo: ServerTlsInfo | null = null;

            for (const txtrecord of txt) {
                if (!txtrecord[0] || txtrecord[0] !== 'hap-server/tunnel') continue;

                if (txtrecord[1] && txtrecord[1] === 'tls') {
                    tlsinfo = {
                        sni: ([] as string[]).concat(hashdata.sni)[0] || urldata.hostname,
                        context: tls.createSecureContext({
                            //
                        }),
                    };
                }
            }

            return {
                urldata,
                hashdata,
                host: srv[0].name,
                port: srv[0].port,
                tls: tlsinfo,
                dnssd: {srv, txt},
            };
        }

        if (!urldata.port) throw new Error('Missing port');

        if (urldata.protocol === ConnectionProtocol.TUNNEL) {
            return {
                urldata,
                hashdata: parseQueryString(urldata.hash ? urldata.hash.substr(1) : ''),
                host: urldata.hostname,
                port: parseInt(urldata.port),
                tls: null,
                dnssd: null,
            };
        } else if (urldata.protocol === ConnectionProtocol.SECURE_TUNNEL) {
            const hashdata = parseQueryString(urldata.hash ? urldata.hash.substr(1) : '');

            return {
                urldata,
                hashdata,
                host: urldata.hostname,
                port: parseInt(urldata.port),
                tls: {
                    sni: ([] as string[]).concat(hashdata.sni)[0] || urldata.hostname,
                },
                dnssd: null,
            };
        } else {
            throw new Error('Unsupported protocol');
        }
    }

    static checkServerIdentity(
        url: string, data: ServerInfo, socket: net.Socket | tls.TLSSocket, host: string, cert: tls.PeerCertificate
    ): Error | undefined {
        console.log('Checking tunnel server identity', url, socket, host, cert);
        return undefined;
    }
}

export interface ServiceConnectionOptions {
    service_type: ServiceType;
    service_identifier: number;
    hostname: string;

    server_address: string;
    server_port: number;
    remote_address: string;
    remote_port: number;
}

export class ServiceConnection extends stream.Duplex {
    bytesRead = 0;
    bytesWritten = 0;

    constructor(
        readonly connection: Connection, readonly connection_id: number,
        readonly options: ServiceConnectionOptions
    ) {
        super();

        const onconnectionclose = () => {
            this.destroy(new Error('Disconnected'));
        };

        const onend = () => {
            connection.service_connections.delete(this.connection_id);

            connection.removeListener('close', onconnectionclose);
            this.removeListener('close', onend);
        };

        connection.on('close', onconnectionclose);
        this.on('close', onend);

        connection.service_connections.set(this.connection_id, this);
    }

    _write(chunk: Buffer | string, encoding: string, callback: (err?: Error | null) => void) {
        if (!(chunk instanceof Buffer)) chunk = Buffer.from(chunk);

        const header = Buffer.alloc(2);
        header.writeUInt16BE(this.connection_id, 0);

        this.connection.send(MessageType.MESSAGE, Buffer.concat([header, chunk]));
        this.bytesWritten += chunk.length;
        callback();
    }

    _read(size: number) {
    }

    push(chunk: Buffer | string, encoding?: string) {
        this.bytesRead += chunk.length;
        return super.push(chunk, encoding);
    }

    async _destroy(err: Error | null, callback: (err: Error | null) => void) {
        const status = !err ? CloseConnectionStatus.CLOSED_BY_REMOTE_CLIENT :
            err.message === 'Disconnected' ? CloseConnectionStatus.CLOSED_BY_CLIENT :
            CloseConnectionStatus.ERROR;

        if (!err || err.message !== 'Disconnected') {
            const data = Buffer.alloc(3);
            data.writeUInt16BE(this.connection_id, 0);
            data.writeUInt8(status, 0);

            this.connection.send(MessageType.CLOSE_CONNECTION, data);
        }

        callback(null);
    }

    connect() {}
    setTimeout() {}
    setNoDelay() {}
    setKeepAlive() {}
    ref() {}
    unref() {}

    get bufferSize() {
        return this.connection.socket.bufferSize;
    }

    get connecting() {
        return false;
    }

    address() {
        return {
            port: this.options.remote_port,
            family: 'IPv6',
            address: '::ffff:0.0.0.0',
        };
    }

    get localAddress() {
        // return this.options.server_address;
        return '::ffff:0.0.0.0';
    }

    get localPort() {
        return this.options.server_port;
    }

    get remoteAddress() {
        // return this.options.remote_address;
        return '::ffff:0.0.0.0';
    }

    get remotePort() {
        return this.options.remote_port;
    }
}

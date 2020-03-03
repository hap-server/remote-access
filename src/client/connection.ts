import {SERVICE_NAME} from '../constants';
import BaseConnection from '../common/connection';
import {
    MessageType, ServiceType, ConnectServiceStatus, DisconnectServiceStatus, CloseConnectionStatus,
} from '../common/message-types';
import {ipaddrFromBuffer} from '../common/util';

import * as net from 'net';
import * as tls from 'tls';
import {promises as dns, SrvRecord} from 'dns';
import {parse as parseUrl, UrlWithStringQuery} from 'url';
import {parse as parseQueryString, ParsedUrlQuery} from 'querystring';
import {promises as fs} from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import * as nacl from 'tweetnacl';

interface ConnectionOptions {
    log?: typeof import('@hap-server/api').log | import('@hap-server/api/homebridge').Logger | typeof console;
}

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
    signing_key: Buffer | null;
}

export interface ServerInfo {
    urldata: UrlWithStringQuery;
    hashdata: ParsedUrlQuery;
    host: string;
    port: number;
    tls: ServerTlsInfo | null;
    dnssd: ServerDiscoveryInfo | null;
}
export interface MultipleHostServerInfo {
    urldata: UrlWithStringQuery;
    hashdata: ParsedUrlQuery;
    hosts: {host: string; port: number}[];
    tls: ServerTlsInfo | null;
    dnssd: ServerDiscoveryInfo | null;
}

export default class Connection extends BaseConnection {
    readonly url: string;
    readonly socket: net.Socket | tls.TLSSocket;
    readonly services: string[] = [];
    readonly service_connections = new Map<number, ServiceConnection>();

    private last_received_data = Date.now();
    private _sendPing = this.send.bind(this, MessageType.PING, Buffer.alloc(0));
    private send_ping_timeout = setTimeout(this._sendPing, 30000);
    private _handleConnectionTimeout = this.handleConnectionTimeout.bind(this);
    private connection_timeout = setTimeout(this._handleConnectionTimeout, 60000);

    log: typeof import('@hap-server/api').log | import('@hap-server/api/homebridge').Logger | typeof console = console;

    constructor(url: string, socket: net.Socket, options?: ConnectionOptions) {
        super();

        this.url = url;
        this.socket = socket;
        this.log = options?.log || console;

        socket.on('data', (data: Buffer) => {
            this.handleData(data);

            this.last_received_data = Date.now();
            clearTimeout(this.send_ping_timeout);
            this.send_ping_timeout = setTimeout(this._sendPing, 30000);
            clearTimeout(this.connection_timeout);
            this.connection_timeout = setTimeout(this._handleConnectionTimeout, 60000);
        });

        socket.on('close', () => {
            this.emit('close');

            clearTimeout(this.send_ping_timeout);
            clearTimeout(this.connection_timeout);
        });
    }

    close() {
        this.socket.end();
    }

    protected _write(data: Buffer) {
        this.socket.write(data);

        clearTimeout(this.send_ping_timeout);
        this.send_ping_timeout = setTimeout(this._sendPing, 30000);
        clearTimeout(this.connection_timeout);
        this.connection_timeout = setTimeout(this._handleConnectionTimeout, 60000);
    }

    handleMessage(type: MessageType, data: Buffer) {
        this.emit('message', type, data);

        this.log[this.log === console ? 'warn' : 'debug']('Received message', type, MessageType[type], data);

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

    handleConnectionTimeout() {
        this.log.error('Connection timed out');

        this.socket.destroy();
    }

    private handleServiceConnection(data: Buffer) {
        const connection_id = data.readUInt16BE(0);
        const service_name_length = data.readUInt16BE(2);
        const server_address = ipaddrFromBuffer(data.slice(4 + service_name_length, 20 + service_name_length));
        const remote_address = ipaddrFromBuffer(data.slice(22 + service_name_length, 38 + service_name_length));

        const options = {
            service_type: data.readUInt16BE(4),
            service_identifier: data.readUInt16BE(6),
            hostname: data.slice(10, 4 + service_name_length).toString(),

            server_address: server_address.toString({format: server_address.kind() === 'ipv4' ? 'v4-mapped' : 'v6'}),
            server_port: data.readUInt16BE(20 + service_name_length),
            remote_address: remote_address.toString({format: server_address.kind() === 'ipv4' ? 'v4-mapped' : 'v6'}),
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
    static async connect(url: string, options?: ConnectionOptions): Promise<Connection>
    static async connect(url: string, timeout: number, options?: ConnectionOptions): Promise<Connection>
    static async connect(url: string, _timeout: number | ConnectionOptions = 10000, options?: ConnectionOptions) {
        if (typeof _timeout === 'object') options = _timeout;
        const timeout = typeof _timeout === 'number' ? _timeout : 10000;

        const console = options?.log || global.console;

        const serverinfo = await this.resolveServiceUrl(url);
        const hosts = 'hosts' in serverinfo ? serverinfo.hosts : [serverinfo];

        let last_error: Error = new Error('No services found for URL');

        for (const host of hosts) {
            try {
                console[options?.log ? 'info' : 'warn']('Trying %s port %d', host.host, host.port);

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
                        host: host.host, port: host.port, timeout,

                        servername: serverinfo.tls.sni,
                        secureContext: serverinfo.tls.context,
                    }, onconnect) : net.createConnection({
                        host: host.host, port: host.port, timeout,
                    }, onconnect);

                    socket.on('error', onerror);
                });

                const connection = new Connection(url, socket, options);

                return connection;
            } catch (err) {
                last_error = err;
            }
        }

        throw last_error;
    }

    static async resolveServiceUrl(
        url: string, options?: ConnectionOptions
    ): Promise<ServerInfo | MultipleHostServerInfo> {
        const console = options?.log || global.console;
        const urldata = parseUrl(url);

        if (!urldata.hostname && !urldata.protocol && urldata.pathname) {
            urldata.hostname = urldata.pathname;
            urldata.pathname = null;
        }
        if (!urldata.hostname) throw new Error('Missing host');

        if (!urldata.protocol) {
            const hashdata = parseQueryString(urldata.hash ? urldata.hash.substr(1) : '');

            // DNS service discovery
            const resolver = new dns.Resolver();

            if (hashdata.resolver) {
                resolver.setServers(([] as string[]).concat(hashdata.resolver).join(',').split(','));
            }

            const [srv, txt] = await Promise.all([
                resolver.resolve(SERVICE_NAME + urldata.hostname, 'SRV').then(srv => srv.sort((a, b) => {
                    if (a.priority > b.priority) return 1;
                    if (b.priority < a.priority) return -1;

                    // TODO: random sort using weight
                    return 0;
                })),
                resolver.resolve(SERVICE_NAME + urldata.hostname, 'TXT').catch(err => {
                    if (err.code !== 'ENODATA') throw err;
                    return [] as string[][];
                }),
            ]);

            let enable_tls = false;
            let tls_hostname: string | null = null;
            let tls_ca: Buffer | null = null;
            const signing_key = hashdata.pk ? Buffer.from(([] as string[]).concat(hashdata.pk)[0], 'hex') : null;

            for (const txtrecord of txt) {
                if (!txtrecord[0] || txtrecord[0] !== 'hap-server/tunnel') continue;

                if (txtrecord[1] && txtrecord[1] === 'tls') {
                    enable_tls = true;

                    if (['sni', 'ca'].includes(txtrecord[2]) && signing_key) {
                        if (!txtrecord[4]) throw new Error('Invalid signature');
                        const data = txtrecord[2] === 'ca' ?
                            txtrecord[3] === '-' ?
                                Buffer.concat(txtrecord.slice(5).map(t => Buffer.from(t))) :
                                Buffer.from(txtrecord[3]) :
                            Buffer.from(txtrecord[3]);
                        const signature = Buffer.from(txtrecord[4], 'hex');
                        if (!nacl.sign.detached.verify(Buffer.concat([
                            Buffer.from('tls\0' + txtrecord[2] + '\0'),
                            data,
                        ]), signature, signing_key)) throw new Error('Invalid signature');
                    }

                    if (txtrecord[2] === 'sni' && txtrecord[3]) {
                        tls_hostname = txtrecord[3];
                    }
                    if (txtrecord[2] === 'ca' && txtrecord[3]) {
                        tls_ca = Buffer.from(txtrecord[3] === '-' ?
                            txtrecord.slice(5).join('') : txtrecord[3], 'base64');
                    }
                }
            }

            if (!tls_hostname) tls_hostname = urldata.hostname;

            const ca_file = hashdata.caf ? ([] as string[]).concat(hashdata.caf)[0] : undefined;
            if (hashdata.ca) tls_ca = Buffer.from(([] as string[]).concat(hashdata.ca)[0], 'base64');
            else if (ca_file) tls_ca = await fs.readFile(path.resolve(process.cwd(), ca_file));
            const cert_file = hashdata.cf ? ([] as string[]).concat(hashdata.cf)[0] : undefined;
            const key_file = hashdata.kf ? ([] as string[]).concat(hashdata.cf)[0] : cert_file;
            const cert = hashdata.cert ? Buffer.from(([] as string[]).concat(hashdata.cert)[0], 'base64') :
                cert_file ? await fs.readFile(path.resolve(process.cwd(), cert_file)) : undefined;
            const key = hashdata.key ? Buffer.from(([] as string[]).concat(hashdata.key)[0], 'base64') :
                key_file ? await fs.readFile(path.resolve(process.cwd(), key_file)) : undefined;
            if (tls_hostname || tls_ca || cert || key) enable_tls = true;

            if (!tls_hostname) tls_hostname = ([] as string[]).concat(hashdata.sni)[0] || urldata.hostname;

            const tls_options = enable_tls ? {
                sni: tls_hostname,
                context: tls_ca || cert || key ? tls.createSecureContext({
                    ca: tls_ca || undefined,
                    cert, key,
                }) : undefined,
            } : null;

            return {
                urldata,
                hashdata,
                hosts: srv.map(s => ({host: s.name, port: s.port})),
                tls: tls_options,
                dnssd: {srv, txt, signing_key},
            };
        }

        if (!urldata.port) throw new Error('Missing port');

        if (urldata.protocol === ConnectionProtocol.TUNNEL) {
            const hashdata = parseQueryString(urldata.hash ? urldata.hash.substr(1) : '');

            if (hashdata.sni || hashdata.caf || hashdata.ca || hashdata.cf || hashdata.kf || hashdata.cert ||
                hashdata.key
            ) {
                console.warn('URL uses the ts: protocol but TLS options were included');
            }

            return {
                urldata,
                hashdata,
                host: urldata.hostname,
                port: parseInt(urldata.port),
                tls: null,
                dnssd: null,
            };
        } else if (urldata.protocol === ConnectionProtocol.SECURE_TUNNEL) {
            const hashdata = parseQueryString(urldata.hash ? urldata.hash.substr(1) : '');

            const ca_file = hashdata.caf ? ([] as string[]).concat(hashdata.caf)[0] : undefined;
            const ca = hashdata.ca ? Buffer.from(([] as string[]).concat(hashdata.ca)[0], 'base64') :
                ca_file ? await fs.readFile(path.resolve(process.cwd(), ca_file)) : undefined;
            const cert_file = hashdata.cf ? ([] as string[]).concat(hashdata.cf)[0] : undefined;
            const key_file = hashdata.kf ? ([] as string[]).concat(hashdata.cf)[0] : cert_file;
            const cert = hashdata.cert ? Buffer.from(([] as string[]).concat(hashdata.cert)[0], 'base64') :
                cert_file ? await fs.readFile(path.resolve(process.cwd(), cert_file)) : undefined;
            const key = hashdata.key ? Buffer.from(([] as string[]).concat(hashdata.key)[0], 'base64') :
                key_file ? await fs.readFile(path.resolve(process.cwd(), key_file)) : undefined;

            return {
                urldata,
                hashdata,
                host: urldata.hostname,
                port: parseInt(urldata.port),
                tls: {
                    sni: ([] as string[]).concat(hashdata.sni)[0] || urldata.hostname,
                    context: tls.createSecureContext({
                        ca, cert, key,
                    }),
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
        console.warn('Checking tunnel server identity', url, socket, host, cert);
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

export class ServiceConnection extends stream.Duplex implements net.Socket {
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

        const onclose = () => {
            connection.service_connections.delete(this.connection_id);

            connection.removeListener('close', onconnectionclose);
            this.removeListener('close', onclose);

            connection.emit('close-service-connection', this);
        };

        connection.on('close', onconnectionclose);
        this.on('close', onclose);

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

    _final(callback: (err?: Error) => void) {
        const data = Buffer.alloc(3);
        data.writeUInt16BE(this.connection_id, 0);
        data.writeUInt8(CloseConnectionStatus.CLOSED_BY_CLIENT, 0);

        this.connection.send(MessageType.CLOSE_CONNECTION, data);
        callback();
    }

    _read(size: number) {
    }

    push(chunk: Buffer | string, encoding?: string) {
        this.bytesRead += chunk.length;
        return super.push(chunk, encoding);
    }

    write(buffer: string | Uint8Array, cb?: ((err?: Error | undefined) => void) | undefined): boolean;
    write(str: string | Uint8Array, encoding?: string | undefined, cb?: ((err?: Error | undefined) => void) | undefined): boolean;
    write(buffer: string | Uint8Array, encoding_cb?: string | ((err?: Error) => void), cb?: ((err?: Error) => void)): boolean {
        if (typeof encoding_cb === 'function') cb = encoding_cb, encoding_cb = undefined;

        return super.write(buffer, encoding_cb, cb ? (err?: Error | null) => {
            cb!(err === null ? undefined : err);
        } : undefined);
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

    connect(): this {
        throw new Error('Service connection connect isn\'t supported');
    }
    setTimeout(): this {
        // throw new Error('Service connection timeout isn\'t supported');
        return this;
    }
    setNoDelay(): this {
        throw new Error('Service connection no delay isn\'t supported');
    }
    setKeepAlive(): this {
        throw new Error('Service connection keep alive isn\'t supported');
    }
    ref(): this {
        throw new Error('Service connection ref/unref isn\'t supported');
    }
    unref(): this {
        throw new Error('Service connection ref/unref isn\'t supported');
    }

    get bufferSize() {
        return this.connection.socket.bufferSize;
    }

    get connecting() {
        return false;
    }

    get _sock(): net.AddressInfo {
        const value: net.AddressInfo = {
            port: this.options.server_port,
            family: this.options.server_address.indexOf(':') === -1 ? 'IPv4' : 'IPv6',
            address: this.options.server_address,
        };

        return Object.defineProperty(this, '_sock', {
            configurable: true,
            enumerable: false,
            value,
        })._sock;
    }

    get _peer(): net.AddressInfo {
        const value: net.AddressInfo = {
            port: this.options.remote_port,
            family: this.options.remote_address.indexOf(':') === -1 ? 'IPv4' : 'IPv6',
            address: this.options.remote_address,
        };

        return Object.defineProperty(this, '_peer', {
            configurable: true,
            enumerable: false,
            value,
        })._peer;
    }

    address() {
        return this._sock;
    }

    get localAddress() {
        return this.options.server_address;
    }

    get localFamily() {
        return this.options.server_address.indexOf(':') === -1 ? 'IPv4' : 'IPv6';
    }

    get localPort() {
        return this.options.server_port;
    }

    get remoteAddress() {
        return this.options.remote_address;
    }

    get remoteFamily() {
        return this.options.remote_address.indexOf(':') === -1 ? 'IPv4' : 'IPv6';
    }

    get remotePort() {
        return this.options.remote_port;
    }
}

declare module 'net' {
    interface Socket {
        _getsockname?(): net.AddressInfo | string | undefined;
        _getpeername?(): net.AddressInfo | undefined;
    }
}

/**
 * Patch _getsockname and _getpeername to support getting addresses of service connections when wrapped by Node.js
 * as a JSStreamSocket for TLS sockets.
 */

const socket_getsockname = net.Socket.prototype._getsockname;
net.Socket.prototype._getsockname = function _getsockname(this: net.Socket & {
    _handle?: /* TLSWrap */ {_parentWrap?: /* JSStreamSocket */ {stream?: ServiceConnection | unknown}};
}) {
    if (this._handle?._parentWrap?.stream instanceof ServiceConnection) {
        return {
            address: this._handle._parentWrap?.stream.localAddress,
            family: this._handle._parentWrap?.stream.localFamily,
            port: this._handle._parentWrap?.stream.localPort,
        };
    }

    // @ts-ignore
    return socket_getsockname.apply(this, arguments);
};

const socket_getpeername = net.Socket.prototype._getpeername;
net.Socket.prototype._getpeername = function _getpeername(this: net.Socket & {
    _handle?: /* TLSWrap */ {_parentWrap?: /* JSStreamSocket */ {stream?: ServiceConnection | unknown}};
}) {
    if (this._handle?._parentWrap?.stream instanceof ServiceConnection) {
        return {
            address: this._handle?._parentWrap?.stream.remoteAddress,
            family: this._handle?._parentWrap?.stream.remoteFamily,
            port: this._handle?._parentWrap?.stream.remotePort,
        };
    }

    // @ts-ignore
    return socket_getpeername.apply(this, arguments);
};

import * as net from 'net';
import * as tls from 'tls';
import * as stream from 'stream';
import * as forge from 'node-forge';
import * as ipaddr from 'ip6addr';

import BaseConnection from '../common/connection';
import TunnelServer, {Service} from './index';
import RegisterSession from './registration';
import {
    MessageType, ServiceType,
    ListHostsHostnameType, ListHostsHostnameStatus, AddHostStatus, RemoveHostStatus,
    ConnectServiceStatus, DisconnectServiceStatus, CloseConnectionStatus,
} from '../common/message-types';
import {getCertificateFingerprint} from '../common/util';

export interface ServiceConnectionOptions {
    local_address: string;
    local_port: number;
    remote_address: string;
    remote_port: number;
}

function uint16BE(number: number) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(number, 0);
    return buffer;
}
function uint32BE(number: number) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(number, 0);
    return buffer;
}

export default class Connection extends BaseConnection {
    static readonly PROTOCOL_VERSION = 1;

    readonly server: TunnelServer;
    readonly server_socket: net.Server | tls.Server;
    readonly socket: net.Socket | tls.TLSSocket;

    private last_received_data = Date.now();
    private _handleConnectionTimeout = this.handleConnectionTimeout.bind(this);
    private connection_timeout = setTimeout(this._handleConnectionTimeout, 60000);

    readonly peer_certificate: tls.PeerCertificate | null;
    readonly peer_certificate_forge: forge.pki.Certificate | null;
    readonly peer_fingerprint_sha256: string | null;

    private register_session: RegisterSession | null = null;
    readonly service_listeners: string[] = [];
    readonly service_connections = new Map<number, ServiceConnection>();
    private next_service_connection_id = 0;

    constructor(server: TunnelServer, server_socket: net.Server | tls.Server, socket: net.Socket | tls.TLSSocket) {
        super();

        this.server = server;
        this.server_socket = server_socket;
        this.socket = socket;

        const peer_certificate = this.socket instanceof tls.TLSSocket ?
            this.socket.getPeerCertificate() : null;
        this.peer_certificate = peer_certificate?.raw ? peer_certificate : null;

        if (this.peer_certificate) {
            // Convert an ASN.1 X.509x3 object to a Forge certificate
            const asn1 = forge.asn1.fromDer(this.peer_certificate.raw.toString('binary'));
            this.peer_certificate_forge = forge.pki.certificateFromAsn1(asn1);
            this.peer_fingerprint_sha256 = getCertificateFingerprint(this.peer_certificate_forge);
        } else {
            this.peer_certificate_forge = null;
            this.peer_fingerprint_sha256 = null;
        }

        socket.on('data', (data: Buffer) => {
            this.handleData(data);

            this.last_received_data = Date.now();
            clearTimeout(this.connection_timeout);
            this.connection_timeout = setTimeout(this._handleConnectionTimeout, 60000);
        });

        socket.on('end', () => {
            this.emit('close');

            clearTimeout(this.connection_timeout);

            this.register_session?.handleConnectionClosed();

            for (const service_name of this.service_listeners) {
                const header = Buffer.from(service_name);
                const type = header.readUInt16BE(0);
                const identifier = header.readUInt32BE(2);
                const hostname = header.slice(6).toString();

                const service = this.server.getService(type, identifier);
                service?.disconnect(hostname, this, true);
            }
        });

        (socket as net.Socket).on('error', err => {
            console.error('Socket error for connection from %s port %d:',
                socket.remoteAddress, socket.remotePort, err);

            socket.destroy();
        });
    }

    get encrypted() {
        return this.socket instanceof tls.TLSSocket;
    }

    close() {
        this.socket.end();
    }

    protected _write(data: Buffer) {
        this.socket.write(data);

        clearTimeout(this.connection_timeout);
        this.connection_timeout = setTimeout(this._handleConnectionTimeout, 60000);
    }

    handleMessage(type: MessageType, data: Buffer) {
        this.emit('message', type, data);

        if (type === MessageType.PROTOCOL_VERSION) {
            this.send(MessageType.PROTOCOL_VERSION, uint32BE(Connection.PROTOCOL_VERSION));
        }
        if (type === MessageType.PING) {
            this.send(MessageType.PING, Buffer.alloc(0));
        }

        if (type === MessageType.REGISTER ||
            type === MessageType.UNREGISTER ||
            type === MessageType.RENEW_REGISTRATION ||
            type === MessageType.REVOKE_CERTIFICATE
        ) {
            if (!this.register_session) this.register_session = new RegisterSession(this);

            this.register_session.handleMessage(type, data);
        }

        if (type === MessageType.LIST_HOSTS) {
            this.listHosts();
        }
        if (type === MessageType.ADD_HOST) {
            this.addHost(data.toString());
        }
        if (type === MessageType.REMOVE_HOST) {
            this.removeHost(data.toString());
        }
        if (type === MessageType.LIST_DOMAINS) {
            this.listDomains();
        }

        if (type === MessageType.LIST_SERVICES) {
            this.listServices(data.length ? data.toString() : null);
        }
        if (type === MessageType.CONNECT_SERVICE) {
            const type = data.readUInt16BE(0);
            const identifier = data.readUInt32BE(2);
            const hostname = data.slice(6).toString();
            this.connectService(type, identifier, hostname);
        }
        if (type === MessageType.DISCONNECT_SERVICE) {
            const type = data.readUInt16BE(0);
            const identifier = data.readUInt32BE(2);
            const hostname = data.slice(6).toString();
            this.disconnectService(type, identifier, hostname);
        }

        if (type === MessageType.MESSAGE) {
            const connection_id = data.readUInt16BE(0);
            this.service_connections.get(connection_id)?.push(data.slice(2));
        }
        if (type === MessageType.CLOSE_CONNECTION) {
            const connection_id = data.readUInt16BE(0);
            this.service_connections.get(connection_id)?.push(data.slice(2));
        }
    }

    handleConnectionTimeout() {
        console.warn('Connection from %s port %d timed out', this.socket.remoteAddress, this.socket.remotePort);

        this.socket.destroy();
    }

    async listHosts() {
        for (const client_provider of this.server.client_providers) {
            try {
                const hostnames = await client_provider.getHostnames(this);
                if (hostnames === undefined || hostnames === null) continue;

                const data = Buffer.concat(hostnames.map((hostname, index) => Buffer.concat([
                    ...(index === 0 ? [] : [
                        Buffer.from([ListHostsHostnameType.SEPARATOR]), uint32BE(0),
                    ]),

                    Buffer.from([ListHostsHostnameType.HOSTNAME]), uint32BE(hostname.hostname.length),
                    Buffer.from(hostname.hostname, 'binary'),
                    ...(hostname.domain ? [
                        Buffer.from([ListHostsHostnameType.DOMAIN]), uint32BE(hostname.domain.length),
                        Buffer.from(hostname.domain, 'binary'),
                    ] : []),
                    Buffer.from([ListHostsHostnameType.STATUS]), uint32BE(4),
                    uint32BE(hostname.status ?? this.getHostnameStatus(hostname.hostname + '.' + hostname.domain)),
                ])));

                this.send(MessageType.LIST_HOSTS, data);
                return;
            } catch (err) {
                console.error('Error getting hostnames', err);
            }
        }

        this.send(MessageType.LIST_HOSTS, Buffer.alloc(0));
    }

    private getHostnameStatus(hostname: string) {
        if (this.service_listeners.find(service_name => service_name.substr(6) === hostname)) {
            return ListHostsHostnameStatus.CONNECTED;
        }

        for (const connection of this.server.connections) {    
            if (this.service_listeners.find(service_name => service_name.substr(6) === hostname)) {
                return ListHostsHostnameStatus.OTHER_CLIENT_CONNECTED;
            }
        }

        return ListHostsHostnameStatus.NOT_CONNECTED;
    }

    async addHost(hostname: string) {
        if (this.server.readonly) {
            this.send(MessageType.ADD_HOST, Buffer.from([AddHostStatus.UNKNOWN_ERROR]));
            return;
        }

        for (const client_provider of this.server.client_providers) {
            try {
                const status = await client_provider.addHostname(hostname, this);
                if (status === undefined || status === null) continue;

                this.send(MessageType.ADD_HOST, uint32BE(status));
                return;
            } catch (err) {
                console.error('Error adding hostname', err);
            }
        }

        this.send(MessageType.ADD_HOST, uint32BE(AddHostStatus.INVALID_DOMAIN));
    }

    async removeHost(hostname: string) {
        if (this.server.readonly) {
            this.send(MessageType.REMOVE_HOST, Buffer.from([RemoveHostStatus.UNAUTHORISED]));
            return;
        }

        for (const client_provider of this.server.client_providers) {
            try {
                const status = await client_provider.removeHostname(hostname, this);
                if (status === undefined || status === null) continue;

                this.send(MessageType.REMOVE_HOST, uint32BE(status));
                return;
            } catch (err) {
                console.error('Error removing hostname', err);
            }
        }

        this.send(MessageType.REMOVE_HOST, uint32BE(RemoveHostStatus.UNAUTHORISED));
    }

    async listDomains() {
        const data: Buffer[] = [];

        for (const client_provider of this.server.client_providers) {
            for (const domain of client_provider.domains || []) {
                const buffer = Buffer.alloc(domain.length + 4);

                buffer.writeUInt32BE(domain.length, 0);
                buffer.write(domain, 4);

                data.push(buffer);
            }
        }

        this.send(MessageType.LIST_DOMAINS, Buffer.concat(data));
    }

    async listServices(hostname: string | null) {
        const data: Buffer[] = [];

        for (const [type, services] of this.server.services) {
            for (const [identifier, service] of services) {
                if (hostname && !service.checkHostnameSupported(hostname)) continue;

                const buffer = Buffer.alloc(6);

                buffer.writeUInt16BE(type, 0);
                buffer.writeUInt32BE(identifier, 2);

                data.push(buffer);
            }
        }

        this.send(MessageType.LIST_SERVICES, Buffer.concat(data));
    }

    private getServiceName(type: ServiceType, identifier: number, hostname: string) {
        const header = Buffer.alloc(6);
        header.writeUInt16BE(type, 0);
        header.writeUInt32BE(identifier, 2);

        return Buffer.concat([header, Buffer.from(hostname)]);
    }

    async connectService(type: ServiceType, identifier: number, hostname: string) {
        const service = this.server.getService(type, identifier);
        if (!service) {
            this.send(MessageType.CONNECT_SERVICE, Buffer.from([ConnectServiceStatus.UNSUPPORTED_SERVICE]));
            return;
        }

        if (!await this.server.authoriseConnectService(this, type, identifier, hostname)) {
            console.warn('Client from %s port %d tried to connect as a hostname it is not authorised to connect as',
                this.socket.remoteAddress, this.socket.remotePort);
            this.send(MessageType.CONNECT_SERVICE, Buffer.from([ConnectServiceStatus.UNAUTHORISED]));
            return;
        }

        const status = service.connect(hostname, this);
        if (status === ConnectServiceStatus.SUCCESS) {
            this.service_listeners.push(this.getServiceName(type, identifier, hostname).toString());
        }
        this.send(MessageType.CONNECT_SERVICE, Buffer.from([status]));
    }

    disconnectService(type: ServiceType, identifier: number, hostname: string) {
        const service = this.server.getService(type, identifier);
        if (!service) {
            this.send(MessageType.DISCONNECT_SERVICE, Buffer.from([DisconnectServiceStatus.WASNT_CONNECTED]));
            return;
        }

        const status = service.disconnect(hostname, this, false);
        if (status === DisconnectServiceStatus.SUCCESS) {
            this.service_listeners.splice(this.service_listeners.indexOf(this
                .getServiceName(type, identifier, hostname).toString()), 0);
            
            for (const service_connection of this.service_connections.values()) {
                if (service_connection.service !== service) continue;
                service_connection.destroy(new Error('Service disconnected'));
            }
        }
        this.send(MessageType.DISCONNECT_SERVICE, Buffer.from([status]));
    }

    createServiceConnection(service: Service, hostname: string, options: ServiceConnectionOptions) {
        const connection_id = this.next_service_connection_id++;
        const [service_type, service_identifier] = this.server.getServiceIdentifier(service)!;
        const server_address = ipaddr.parse(options.local_address).toBuffer();
        const remote_address = ipaddr.parse(options.remote_address).toBuffer();

        const data = Buffer.alloc(46 + hostname.length);

        data.writeUInt16BE(connection_id, 0);
        data.writeUInt16BE(6 + hostname.length, 2);
        data.writeUInt16BE(service_type, 4);
        data.writeUInt32BE(service_identifier, 6);
        data.write(hostname, 10);
        server_address.copy(data, 10 + hostname.length, 0, 16);
        data.writeUInt16BE(options.local_port, 26 + hostname.length);
        remote_address.copy(data, 28 + hostname.length, 0, 16);
        data.writeUInt16BE(options.remote_port, 44 + hostname.length);

        this.send(MessageType.CONNECTION, data);
        return new ServiceConnection(this, connection_id, service, hostname, options);
    }
}

class ClosedByClientError extends Error {}

export class ServiceConnection extends stream.Duplex {
    constructor(
        readonly connection: Connection, readonly connection_id: number,
        readonly service: Service, readonly hostname: string, readonly options: ServiceConnectionOptions
    ) {
        super();

        const onconnectionclose = () => {
            this.destroy(new ClosedByClientError('Disconnected'));
        };

        const onclose = () => {
            connection.service_connections.delete(this.connection_id);

            connection.removeListener('close', onconnectionclose);
            this.removeListener('close', onclose);
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
        callback();
    }

    _read(size: number) {}

    async _destroy(err: Error | null, callback: (err: Error | null) => void) {
        const status = !err ? CloseConnectionStatus.CLOSED_BY_REMOTE_CLIENT :
            err instanceof ClosedByClientError ? CloseConnectionStatus.CLOSED_BY_CLIENT :
            CloseConnectionStatus.ERROR;

        if (!err || !(err instanceof ClosedByClientError) || err.message !== 'Disconnected') {
            const data = Buffer.alloc(3);
            data.writeUInt16BE(this.connection_id, 0);
            data.writeUInt8(status, 0);

            this.connection.send(MessageType.CLOSE_CONNECTION, data);
        }

        callback(null);
    }
}

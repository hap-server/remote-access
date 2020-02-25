import BaseConnection from '../common/connection';
import * as net from 'net';
import * as tls from 'tls';
import * as stream from 'stream';

import TunnelServer, {Service} from './index';
import {MessageType, CloseConnectionStatus, ServiceType, ConnectServiceStatus, DisconnectServiceStatus} from '../common/message-types';

export interface ServiceConnectionOptions {
    local_address: string;
    local_port: number;
    remote_address: string;
    remote_port: number;
}

export default class Connection extends BaseConnection {
    readonly server: TunnelServer;
    readonly server_socket: net.Server | tls.Server;
    readonly socket: net.Socket | tls.TLSSocket;

    readonly service_listeners: string[] = [];
    readonly service_connections = new Map<number, ServiceConnection>();
    private next_service_connection_id = 0;

    constructor(server: TunnelServer, server_socket: net.Server | tls.Server, socket: net.Socket | tls.TLSSocket) {
        super();

        this.server = server;
        this.server_socket = server_socket;
        this.socket = socket;

        socket.on('data', (data: Buffer) => {
            this.handleData(data);
        });

        socket.on('end', () => {
            this.emit('close');

            for (const service_name of this.service_listeners) {
                const header = Buffer.from(service_name);
                const type = header.readUInt16BE(0);
                const identifier = header.readUInt32BE(2);
                const hostname = header.slice(6).toString();

                const service = this.server.getService(type, identifier);
                service?.disconnect(hostname, this, true);
            }
        });
    }

    get username() {
        if (this.socket instanceof tls.TLSSocket) {
            return this.socket.getPeerCertificate()?.fingerprint || null;
        }

        return null;
    }

    get encrypted() {
        return this.socket instanceof tls.TLSSocket;
    }

    close() {
        this.socket.end();
    }

    protected _write(data: Buffer) {
        this.socket.write(data);
    }

    handleMessage(type: MessageType, data: Buffer) {
        this.emit('message', type, data);

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

    private getServiceName(type: ServiceType, identifier: number, hostname: string) {
        const header = Buffer.alloc(6);
        header.writeUInt16BE(type, 0);
        header.writeUInt32BE(identifier, 2);

        return Buffer.concat([header, Buffer.from(hostname)]);
    }

    connectService(type: ServiceType, identifier: number, hostname: string) {
        const service = this.server.getService(type, identifier);
        if (!service) {
            this.send(MessageType.CONNECT_SERVICE, Buffer.from([ConnectServiceStatus.UNSUPPORTED_SERVICE]));
            return;
        }

        // TODO: authenticate this

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

        // TODO: authenticate this

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
        const server_address = Buffer.alloc(16);
        const remote_address = Buffer.alloc(16);

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
        callback();
    }

    _read(size: number) {
    }

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

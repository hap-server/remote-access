import {EventEmitter} from 'events';
import * as net from 'net';
import * as tls from 'tls';
import * as stream from 'stream';
import Connection, {ServiceConnectionOptions} from './connection';
import {
    MessageType, ServiceType,
    RegisterStatus, UnregisterStatus,
    ConnectServiceStatus, DisconnectServiceStatus,
} from '../common/message-types';

export interface ClientProvider {
    validateClientCertificate(cert: tls.PeerCertificate): Promise<string | Error>;
    registerClient(csr: any): Promise<Buffer | RegisterStatus>;
    unregisterClient(username: string): Promise<UnregisterStatus>;
}

export interface Service {
    connect(hostname: string, connection: Connection): ConnectServiceStatus;
    disconnect(hostname: string, connection: Connection, disconnected: boolean): DisconnectServiceStatus;
}

export default class TunnelServer extends EventEmitter {
    readonly servers: (net.Server | tls.Server)[] = [];
    readonly connections: Connection[] = [];

    readonly client_providers: ClientProvider[] = [];
    register_client_provider: ClientProvider | null = null;

    readonly services = new Map<ServiceType, Map<number, Service>>();
    readonly service_types = new Map<Service, [ServiceType, number]>();

    createServer(options: net.ListenOptions) {
        const server = net.createServer(socket => {
            this.handleConnection(server, socket);
        });

        return this._createServer(server, options);
    }

    createSecureServer(options: tls.TlsOptions, listen_options: net.ListenOptions) {
        const server = tls.createServer(options, socket => {
            this.handleConnection(server, socket);
        });

        return this._createServer(server, listen_options);
    }

    async _createServer<S extends net.Server | tls.Server>(server: S, options: net.ListenOptions): Promise<S> {
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

        this.servers.push(server);

        server.on('close', () => {
            this.servers.splice(this.servers.indexOf(server), 1);
        });

        return server;
    }

    handleConnection(server: net.Server | tls.Server, socket: net.Socket | tls.TLSSocket) {
        const connection = new Connection(this, server, socket);

        this.connections.push(connection);

        socket.on('end', () => {
            this.connections.splice(this.connections.indexOf(connection), 1);
        });
    }

    addClientProvider(client_provider: ClientProvider) {
        this.client_providers.push(client_provider);
    }

    setDefaultClientProvider(client_provider: ClientProvider) {
        this.register_client_provider = client_provider;
    }

    async addService<S extends Service, A extends any[]>(type: ServiceType, identifier: number, constructor: {
        create(server: TunnelServer, ...args: A): PromiseLike<S>;
    }, ...args: A): Promise<S> {
        if (!this.services.has(type)) this.services.set(type, new Map());
        if (this.services.get(type)!.has(identifier)) {
            throw new Error('A service with this type and identifer already exists');
        }

        const service = await constructor.create(this, ...args);

        this.services.get(type)!.set(identifier, service);
        this.service_types.set(service, [type, identifier]);

        return service;
    }

    getService(type: ServiceType, identifer: number) {
        if (!this.services.has(type)) return null;
        return this.services.get(type)!.get(identifer) || null;
    }

    getServiceIdentifier(service: Service) {
        return this.service_types.get(service) || null;
    }
}

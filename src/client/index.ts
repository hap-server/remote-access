import {EventEmitter} from 'events';
import Connection, {ServiceConnection} from './connection';
import {DEFAULT_SERVER} from '../constants';
import {MessageType, ServiceType} from '../common/message-types';

export enum TunnelState {
    DISCONNECTED,
    CONNECTING,
    RECONNECT,
    CONNECTED,
    DISCONNECTING,
}

export type TargetState = TunnelState.DISCONNECTED | TunnelState.CONNECTED;

export default class TunnelClient extends EventEmitter {
    private _url = DEFAULT_SERVER;
    connection: Connection | null = null;
    old_connections: Connection[] = [];
    state = TunnelState.DISCONNECTED;
    target_state: TargetState = TunnelState.DISCONNECTED;

    get url() {
        return this._url;
    }

    set url(url: string) {
        this._url = url;

        if (this.connection) {
            this.state = TunnelState.RECONNECT;
            this._updateState();
        }
    }

    setTargetState(state: TargetState) {
        this.target_state = state;

        this._updateState();
    }

    private _updating_state = false;

    private async _updateState() {
        if (this._updating_state) return;
        this._updating_state = true;

        while (this.state !== this.target_state) {
            console.warn('Updating state');

            if (this.target_state === TunnelState.CONNECTED) {
                console.warn('Connecting');

                try {
                    if (this.connection && this.connection.url !== this.url) {
                        this.state = TunnelState.DISCONNECTING;
                        await this.connection.close();
                        this.emit('disconnected');
                    }

                    if (!this.connection) {
                        this.state = TunnelState.CONNECTING;
                        const connection = this.connection = await Connection.connect(this.url);

                        for (const service_name of this.services) {
                            const header = Buffer.from(service_name);
                            const type = header.readUInt16BE(0);
                            const identifier = header.readUInt32BE(2);
                            const hostname = header.slice(6).toString();

                            this.connection.connectService(type, identifier, hostname);
                        }

                        this.connection.on('message', (type, data) => {
                            this.handleMessage(type, data, connection);
                        });

                        this.connection.on('service-connection', (service_connection: ServiceConnection) => {
                            this.emit('service-connection', service_connection);
                        });

                        this.connection.on('close', () => {
                            if (this.connection === connection) {
                                this.connection = null;
                                this.state = TunnelState.DISCONNECTED;
                                this._updateState();
                            }

                            const index = this.old_connections.indexOf(connection);
                            if (index !== -1) {
                                this.old_connections.splice(index, 1);
                            }
                        });
                    }

                    this.emit('connected');
                    this.state = TunnelState.CONNECTED;
                } catch (err) {
                    this.emit('connect-error', err);

                    // Try again in 10 seconds
                    this.state = TunnelState.DISCONNECTED;
                    await new Promise(rs => setTimeout(rs, 10000));
                }
            } else if (this.target_state === TunnelState.DISCONNECTED) {
                try {
                    this.state = TunnelState.DISCONNECTING;
                    await this.connection?.close();
                    this.state = TunnelState.DISCONNECTED;
                    this.emit('disconnected');
                } catch (err) {
                    //
                }
            } else {
                this.target_state = TunnelState.DISCONNECTED;
                this.state = TunnelState.DISCONNECTING;
                this.connection?.close();
                this.state = TunnelState.DISCONNECTED;
                this.emit('disconnected');
                throw new Error('Invalid state');
            }
        }

        this._updating_state = false;
    }

    async connect() {
        this.setTargetState(TunnelState.CONNECTED);

        let onconnected: any, onerror: any;

        return Promise.race([
            new Promise<void>((rs, rj) => {
                this.on('connected', onconnected = rs);
                this.on('connect-error', onerror = rj);
            }),
            new Promise<void>((rs, rj) => setTimeout(() => rj(new Error('Timeout')), 10000)),
        ]).then(() => {
            this.removeListener('connected', onconnected);
            this.removeListener('connect-error', onerror);
        }, err => {
            this.setTargetState(TunnelState.DISCONNECTED);
            this.removeListener('connected', onconnected);
            this.removeListener('connect-error', onerror);
            throw err;
        });
    }

    handleMessage(type: MessageType, data: Buffer, connection: Connection) {
        if (type === MessageType.RECONNECT && this.connection === connection) {
            this.old_connections.push(connection);

            this.connection = null;
            this.state = TunnelState.RECONNECT;
            this._updateState();

            // If there are no service connections on this connection it can be closed now
            if (!connection.service_connections.size) connection.close();
        }

        //
    }

    private getServiceName(type: ServiceType, identifier: number, hostname: string) {
        const header = Buffer.alloc(6);
        header.writeUInt16BE(type, 0);
        header.writeUInt32BE(identifier, 2);

        return Buffer.concat([header, Buffer.from(hostname)]);
    }

    readonly services: string[] = [];

    connectService(type: ServiceType, identifier: number, hostname: string) {
        if (this.services.includes(this.getServiceName(type, identifier, hostname).toString())) return;
        this.services.push(this.getServiceName(type, identifier, hostname).toString());
        return this.connection?.connectService(type, identifier, hostname);
    }

    disconnectService(type: ServiceType, identifier: number, hostname: string) {
        if (!this.services.includes(this.getServiceName(type, identifier, hostname).toString())) return;
        this.services.splice(this.services.indexOf(this.getServiceName(type, identifier, hostname).toString()), 1);
        return this.connection?.disconnectService(type, identifier, hostname);
    }
}

import Connection from './connection';
import {
    MessageType, RegisterState, RegisterStatus, UnregisterStatus, RevokeCertificateStatus, RenewRegistrationStatus,
} from '../common/message-types';

type RegisterMessageType = MessageType.REGISTER | MessageType.UNREGISTER |
    MessageType.RENEW_REGISTRATION | MessageType.REVOKE_CERTIFICATE;

export default class RegisterSession {
    constructor(readonly connection: Connection) {
        //
    }

    async handleMessage(type: RegisterMessageType, data: Buffer) {
        try {
            if (type === MessageType.REGISTER) {
                await this.handleRegisterMessage(data[0], data.slice(1));
            }
            if (type === MessageType.UNREGISTER) {
                await this.handleUnregisterMessage(data);
            }
            if (type === MessageType.RENEW_REGISTRATION) {
                await this.handleRenewRegistrationMessage(data);
            }
            if (type === MessageType.REVOKE_CERTIFICATE) {
                await this.handleRevokeCertificateMessage(data);
            }
        } catch (err) {
            console.error('[RegisterSession] Error handling message', MessageType[type], err);
        }
    }

    next_register_state = RegisterState.M1;

    handleRegisterMessage(state: RegisterState, data: Buffer) {
        if (state !== this.next_register_state) {
            // Reset state
            this.next_register_state = RegisterState.M1;

            if (state !== RegisterState.M1) throw new Error('Invalid state');
        }

        if (state === RegisterState.M1) {
            return this.handleRegisterM1(data);
        }

        throw new Error('Invalid state');
    }

    async handleRegisterM1(data: Buffer) {
        if (this.connection.server.readonly || !this.connection.server.register_client_provider) {
            this.connection.send(MessageType.REGISTER, Buffer.concat([
                Buffer.from([RegisterState.M2]),
                Buffer.from([RegisterStatus.NOT_ACCEPTING_REGISTRATIONS]),
            ]));
            return;
        }

        const csr = data.toString('binary');

        try {
            const status = await this.connection.server.register_client_provider.registerClient(csr, this.connection);

            if (status === RegisterStatus.SUCCESS) {
                throw new Error('Client provider returned RegisterStatus.SUCCESS, must return signed certificate if registration was successful');
            } else if (typeof status === 'number') {
                this.connection.send(MessageType.REGISTER, Buffer.concat([
                    Buffer.from([RegisterState.M2]),
                    Buffer.from([status]),
                ]));
            } else if (status instanceof Buffer) {
                this.connection.send(MessageType.REGISTER, Buffer.concat([
                    Buffer.from([RegisterState.M2]),
                    Buffer.from([RegisterStatus.SUCCESS]),
                    status,
                ]));
            } else {
                throw new Error('Client provider returned invalid value');
            }
        } catch (err) {
            console.error('[RegisterSession] Error registering client', err);
        }
    }

    handleUnregisterMessage(data: Buffer) {
        return this.unregister();
    }

    async unregister() {
        if (this.connection.server.readonly) {
            this.connection.send(MessageType.UNREGISTER, Buffer.from([UnregisterStatus.UNAUTHORISED]));
            return;
        }

        for (const client_provider of this.connection.server.client_providers) {
            try {
                const status = await client_provider.unregisterClient(this.connection);
                if (status === undefined || status === null) continue;

                this.connection.send(MessageType.UNREGISTER, Buffer.from([status]));
                return;
            } catch (err) {
                console.error('Error unregistering client', err);
            }
        }

        this.connection.send(MessageType.UNREGISTER, Buffer.from([UnregisterStatus.UNAUTHORISED]));
    }

    handleRenewRegistrationMessage(data: Buffer) {
        return this.renewRegistration();
    }

    async renewRegistration() {
        if (this.connection.server.readonly) {
            this.connection.send(MessageType.RENEW_REGISTRATION, Buffer.from([RenewRegistrationStatus.UNKNOWN_ERROR]));
            return;
        }

        // TODO
    }

    handleRevokeCertificateMessage(data: Buffer) {
        return this.revokeCertificate(data);
    }

    async revokeCertificate(sha256: Buffer) {
        if (this.connection.server.readonly) {
            this.connection.send(MessageType.REVOKE_CERTIFICATE, Buffer.from([RevokeCertificateStatus.UNAUTHORISED]));
            return;
        }

        const fingerprint_sha256 = sha256.toString('hex').replace(/(.{2})(?!$)/g, m => `${m}:`);

        for (const client_provider of this.connection.server.client_providers) {
            try {
                const status = await client_provider.revokeCertificate(fingerprint_sha256, this.connection);
                if (status === undefined || status === null) continue;

                this.connection.send(MessageType.REVOKE_CERTIFICATE, Buffer.from([status]));
                return;
            } catch (err) {
                console.error('Error revoking certificate', err);
            }
        }

        this.connection.send(MessageType.REVOKE_CERTIFICATE, Buffer.from([RevokeCertificateStatus.UNAUTHORISED]));
    }

    handleConnectionClosed() {
        //
    }
}

import {ClientProvider, HostnameDetails} from './index';
import {
    ServiceType, RegisterStatus, UnregisterStatus, AddHostStatus, RemoveHostStatus, RevokeCertificateStatus,
} from '../common/message-types';
import Connection from './connection';
import {CertificateIssuer} from './certificateissuer';
import {getCertificateFingerprint} from '../common/util';

import * as path from 'path';
import * as sqlite from 'sqlite';
import sql from 'sql-template-strings';
import * as forge from 'node-forge';
import {CertificationRequest} from '../types/node-forge';

interface EmailAddressVerifier {
    verifyEmailAddress(email_address: string, connection: Connection, csr: CertificationRequest): Promise<void>;
}

interface ClientRecord {
    id: number;
    /** Client chosen common name of the last issued certificate */
    name: string;
}

interface ClientCertificateRecord {
    client_id: number;
    /** PEM encoded certificate */
    data: string;
    /** SHA256 fingerprint of the certificate */
    fingerprint_sha256: string;
    email_address: string;
    /** Timestamp in milliseconds the certificate is valid from */
    valid_from: number;
    /** Timestamp in milliseconds the certificate is valid until */
    valid_to: number;
    /** Timestamp in milliseconds the certificate was revoked */
    revoked: number | null;
}

interface HostnameRecord {
    client_id: number;
    hostname: string;
    revoked: 0 | 1;
}

export default class SQLiteClientProvider implements ClientProvider {
    issuer: CertificateIssuer | null = null;
    email_verifier: EmailAddressVerifier | null = null;
    verify_issuer: forge.pki.Certificate | null = null;
    /** List of domains offered to clients */
    domains: string[] = [];
    /** Regular expression used to validate client chosen hostnames */
    hostname_regex: RegExp | null = null;

    constructor(readonly database: sqlite.Database) {}

    static async create(database_path: string) {
        const database = await sqlite.open(database_path, {
            verbose: true,
        });

        await database.migrate({
            migrationsPath: path.resolve(__dirname, '..', '..', 'resources', 'sqlite-client-provider-migrations'),
        });

        return new this(database);
    }

    async registerClient(pem: string, connection: Connection): Promise<Buffer | RegisterStatus> {
        if (!this.issuer) return RegisterStatus.NOT_ACCEPTING_REGISTRATIONS;

        const csr = forge.pki.certificationRequestFromPem(pem, true);

        if (!csr.verify()) {
            console.error('Invalid CSR signature');
            return RegisterStatus.INVALID_CSR_DATA;
        }

        console.warn(csr);

        const common_name = csr.subject.getField({name: 'commonName'})?.value;

        if (!common_name) {
            console.error('CSR doesn\'t include a common name');
            return RegisterStatus.INVALID_CSR_DATA;
        }

        const email_attribute = csr.getAttribute({name: 'emailAddress'});
        const email_address = email_attribute?.value;

        if (this.email_verifier) {
            if (!email_address) {
                console.error('CSR doesn\'t include an email address');
                return RegisterStatus.INVALID_CSR_DATA;
            }

            if (csr.subject.getField('emailAddress') !== email_address) {
                console.error('CSR commonName doesn\'t match the email address');
                return RegisterStatus.INVALID_CSR_DATA;
            }

            console.log('Waiting for verification for email address', email_attribute, email_address);

            try {
                await this.email_verifier.verifyEmailAddress(email_address, connection, csr);
            } catch (err) {
                console.error('Error validating email address', email_address);
            }
        } else {
            console.warn('Not checking email address');
        }

        const [cert, ...issuer_chain] = await this.issuer.issueCertificateForRequest(csr);
        const cert_pem = forge.pki.certificateToPem(cert);

        const cert_fingerprint_sha256 = getCertificateFingerprint(cert);

        console.log('Issued certificate', cert_fingerprint_sha256, common_name);

        const client_statement = await this.database.prepare(sql`INSERT INTO clients (name) VALUES (${common_name})`);
        await client_statement.run();
        const client_id = client_statement.lastID;

        await this.database.run(sql`
            INSERT INTO clientcerts
                (client_id, data, fingerprint_sha256, email_address, valid_from, valid_to)
            VALUES
                (${client_id}, ${cert_pem}, ${cert_fingerprint_sha256}, ${email_address}, ${cert.validity.notBefore},
                    ${cert.validity.notAfter})
        `);

        return Buffer.concat([
            Buffer.from(cert_pem, 'binary'),
            ...issuer_chain.map(cert => Buffer.from(forge.pki.certificateToPem(cert), 'binary')),
        ]);
    }

    async unregisterClient(connection: Connection): Promise<UnregisterStatus | null> {
        const client_details = await this.getClientDetails(connection);
        if (!client_details) return null;
        if (!client_details.cert_valid) return UnregisterStatus.UNAUTHORISED;

        if (connection.service_listeners.length) {
            return UnregisterStatus.SERVICES_CONNECTED;
        }
        if (connection.service_connections.size) {
            return UnregisterStatus.SERVICES_CONNECTED;
        }

        const cert_records: Pick<ClientCertificateRecord, 'fingerprint_sha256'>[] =
            await this.database.all(sql`
                SELECT fingerprint_sha256 FROM clientcerts
                WHERE client_id = ${client_details.id} AND revoked NOT NULL
            `);
        const sha256_fingerprints = cert_records.map(c => c.fingerprint_sha256);

        for (const other_connection of connection.server.connections) {
            if (other_connection.peer_fingerprint_sha256 &&
                sha256_fingerprints.includes(other_connection.peer_fingerprint_sha256)
            ) {
                return UnregisterStatus.OTHER_CLIENT_CONNECTED;
            }
        }

        await this.database.run(
            sql`UPDATE clientcerts SET revoked = ${new Date()} WHERE client_id = ${client_details.id}`
        );

        return UnregisterStatus.SUCCESS;
    }

    async revokeCertificate(fingerprint_sha256: string, connection: Connection): Promise<RevokeCertificateStatus | null> {
        const client_details = await this.getClientDetails(connection);
        if (!client_details) return null;
        if (!client_details.cert_valid) return RevokeCertificateStatus.UNAUTHORISED;

        if (fingerprint_sha256 === connection.peer_fingerprint_sha256) return RevokeCertificateStatus.UNAUTHORISED;

        const cert_record: Pick<ClientCertificateRecord, 'client_id' | 'revoked'> | undefined =
            await this.database.get(
                sql`SELECT client_id, revoked FROM clientcerts WHERE fingerprint_sha256 = ${fingerprint_sha256}`);
        if (!cert_record) return RevokeCertificateStatus.UNAUTHORISED;
        if (cert_record.client_id !== client_details.id) return RevokeCertificateStatus.UNAUTHORISED;
        if (cert_record.revoked) return RevokeCertificateStatus.UNAUTHORISED;

        const other_cert_record: Pick<ClientCertificateRecord, 'fingerprint_sha256'> | undefined =
            await this.database.get(sql`
                SELECT fingerprint_sha256 FROM clientcerts
                WHERE client_id = ${client_details.id} AND revoked IS NULL
            `);
        if (!other_cert_record) return RevokeCertificateStatus.NO_OTHER_CERTIFICATES;

        await this.database.run(sql`
            UPDATE clientcerts SET revoked = ${new Date()}
            WHERE client_id = ${client_details.id} AND fingerprint_sha256 = ${fingerprint_sha256} AND revoked is null
        `);

        for (const other_connection of connection.server.connections) {
            if (other_connection.peer_fingerprint_sha256 === fingerprint_sha256) {
                other_connection.socket.destroy();
            }
        }

        return RevokeCertificateStatus.SUCCESS;
    }

    async getHostnames(connection: Connection): Promise<HostnameDetails[] | null> {
        const client_details = await this.getClientDetails(connection);
        if (!client_details) return null;
        if (!client_details.cert_valid) return [];

        const hostnames: HostnameRecord[] =
            await this.database.all(sql`SELECT * FROM hostnames WHERE client_id = ${client_details.id}`);

        return hostnames.map(hostname => {
            const domain = this.domains.sort((a, b) => a.length > b.length ? -1 : b.length > a.length ? 1 : 0)
                .find(d => hostname.hostname.endsWith('.' + d)) || null;

            return {
                hostname: domain ? hostname.hostname.substr(0, hostname.hostname.length - domain.length - 1) :
                    hostname.hostname,
                domain,
            };
        });
    }

    async addHostname(hostname: string, connection: Connection): Promise<AddHostStatus | null> {
        const hostname_record: HostnameRecord | undefined =
            await this.database.get(sql`SELECT * FROM hostnames WHERE hostname = ${hostname}`);

        if (hostname_record?.revoked) return AddHostStatus.PREVIOUSLY_REGISTERED;
        if (hostname_record) return AddHostStatus.ALREADY_REGISTERED;

        const client_details = await this.getClientDetails(connection);
        if (!client_details) return null;
        if (!client_details.cert_valid) return AddHostStatus.UNKNOWN_ERROR;

        // Check this server offers this hostname
        if (this.hostname_regex && !this.hostname_regex.test(hostname)) return AddHostStatus.INVALID_DOMAIN;

        await this.database.run(
            sql`INSERT INTO hostnames (client_id, hostname, revoked) VALUES (${client_details.id}, ${hostname}, false)`
        );
        return AddHostStatus.SUCCESS;
    }

    async removeHostname(hostname: string, connection: Connection): Promise<RemoveHostStatus | null> {
        const hostname_record: HostnameRecord | undefined =
            await this.database.get(sql`SELECT * FROM hostnames WHERE hostname = ${hostname}`);

        if (!hostname_record) return RemoveHostStatus.UNAUTHORISED;

        const client_details = await this.getClientDetails(connection);
        if (!client_details) return null;
        if (!client_details.cert_valid) return RemoveHostStatus.UNAUTHORISED;
        if (client_details.id !== hostname_record.client_id) return RemoveHostStatus.UNAUTHORISED;

        await this.database.run(
            sql`UPDATE hostnames SET revoked = true WHERE hostname = ${hostname}`
        );
        return RemoveHostStatus.SUCCESS;
    }

    /**
     * Verifies a connection's TLS client certificate and gets the client ID if it's valid.
     *
     * @param {Connection} connection
     * @return {(number|false|null)} If a number, the client ID. If false, the client certificate is invalid. If null, the client certificate isn't known.
     */
    async getClientDetails(connection: Connection) {
        if (!connection.peer_certificate_forge) return null;

        if (this.verify_issuer && !this.verify_issuer.verify(connection.peer_certificate_forge)) return null;

        const cert_fingerprint_sha256 = connection.peer_fingerprint_sha256;

        const cert_record: Pick<ClientCertificateRecord, 'client_id' | 'revoked'> | undefined =
            await this.database.get(
                sql`SELECT client_id, revoked FROM clientcerts WHERE fingerprint_sha256 = ${cert_fingerprint_sha256}`);
        if (!cert_record) return null;

        const errors: Error[] = [];

        if (cert_record.revoked) errors.push(new Error('Certificate has been revoked'));

        // Check the certificate is valid yet
        if (connection.peer_certificate_forge.validity.notBefore.getTime() > Date.now()) {
            errors.push(new Error('Certificate is not valid yet'));
        }

        // Check the certificate hasn't expired yet
        if (connection.peer_certificate_forge.validity.notAfter.getTime() < Date.now()) {
            errors.push(new Error('Certificate has expired'));
        }

        for (const extension of connection.peer_certificate_forge.extensions) {
            if (extension.name === 'basicConstraints') {
                //
            } else if (extension.name === 'keyUsage') {
                //
            } else if (extension.name === 'extKeyUsage') {
                // Check certificate is intended to be used for TLS client authentication
                if (!extension.clientAuth) errors.push(new Error('Certificate is not intended for TLS client authentication'));
            } else if (extension.name === 'subjectAltName') {
                //
            } else if (extension.critical) {
                // Extension is critial but we don't support it
                errors.push(new Error('Certificate includes unsupported critical extension ' +
                    extension.id + (extension.name ? ' (' + extension.name + ')' : '')));
            }
        }

        if (errors.length) {
            console.error('Error validating certificate for client from %s port %d',
                connection.socket.remoteAddress, connection.socket.remotePort, errors);
        }

        return {
            id: cert_record.client_id,
            cert_valid: !errors.length,
        };
    }

    async authoriseConnectService(connection: Connection, hostname: string, type: ServiceType, identifier: number) {
        const client_details = await this.getClientDetails(connection);
        if (!client_details) return null;
        if (!client_details.cert_valid) return false;

        console.warn('Checking authorisation of client #%d for hostname %s',
            client_details.id, hostname);

        const hostname_record: HostnameRecord | undefined =
            await this.database.get(sql`SELECT * FROM hostnames WHERE hostname = ${hostname}`);

        console.warn(hostname_record);

        if (!hostname_record) return false;
        if (hostname_record.client_id !== client_details.id) return false;
        
        return true;
    }
}

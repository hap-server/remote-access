import TunnelClient, {TunnelState} from '../client';
import {ServiceConnection} from '../client/connection';
import {MessageType, RegisterState, ServiceType, RegisterStatus, ListHostsHostnameType, AddHostStatus, RemoveHostStatus, ListHostsHostnameStatus} from '../common/message-types';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import {promises as fs} from 'fs';
import * as path from 'path';
import * as querystring from 'querystring';
import * as forge from 'node-forge';
import {CertificationRequest} from '../types/node-forge';

const client = new TunnelClient();

(async () => {
    // client.url = 'ts://127.0.0.1:9000';
    client.url = 'tss://127.0.0.1:9004#sni=hapserver-tunnel.fancy.org.uk&ca=' +
        (await fs.readFile(path.join(__dirname, '..', '..', 'data', 'root-cert.pem'))).toString('base64');

    if ([
        'unregister', 'list-hostnames', 'add-hostname', 'remove-hostname', 'list-services', 'service',
    ].includes(process.argv[3])) {
        client.url = process.argv[2];

        client.url = 'tss://127.0.0.1:9004#' + querystring.stringify({
            sni: 'hapserver-tunnel.fancy.org.uk',
            key: (await fs.readFile(path.join(__dirname, '..', '..', 'data', 'client-privkey.pem'))).toString('base64'),
            ca: (await fs.readFile(path.join(__dirname, '..', '..', 'data', 'root-cert.pem'))).toString('base64'),
        });
    }

    console.log('Connecting to', client.url.substr(0, Math.max(client.url.indexOf('#'), 0) || client.url.length));
    await client.connect();

    if (process.argv[2] === 'register') {
        console.log('Register');

        const email_address = 'user@example.com';

        // Generate a keypair and CSR
        // The CSR must contain a working email address

        const keypair = await generateKeyPair({
            bits: 4096,
        });

        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = keypair.publicKey;
        csr.setSubject([
            {name: 'commonName', value: email_address},
            {name: 'countryName', value: 'GB'},
            {name: 'emailAddress', value: email_address},
        ]);
        csr.setAttributes([
            {name: 'emailAddress', value: email_address},
            {
                name: 'extensionRequest',
                extensions: [],
                ],
            },
        ]);

        csr.sign(keypair.privateKey, forge.md.sha512.create());

        console.log('CSR', csr);

        // Register the keypair on the server
        client.connection!.send(MessageType.REGISTER, Buffer.concat([
            Buffer.from([RegisterState.M1]),
            Buffer.from(forge.pki.certificationRequestToPem(csr), 'binary'),
        ]));

        // Wait for the server to respond with the signed certificate
        const [, state_certificate] = await client.connection!.waitForMessage((type, data) =>
            type === MessageType.REGISTER && data[0] === RegisterState.M2);
        const status: RegisterStatus = state_certificate[1];

        if (status === RegisterStatus.SUCCESS) {
            const certificate_chain_pem = state_certificate.slice(2).toString('binary');

            console.warn('Certificate', certificate_chain_pem);
        } else if (status === RegisterStatus.INVALID_CSR_DATA) {
            const err = new Error('Invalid CSR data');
            // @ts-ignore
            err.code = status;
            throw err;
        } else if (status === RegisterStatus.NOT_ACCEPTING_REGISTRATIONS) {
            const err = new Error('The server is not accepting registrations');
            // @ts-ignore
            err.code = status;
            throw err;
        } else {
            const err = new Error('Unknown error' + (RegisterStatus[status] ? ' (' + RegisterStatus[status] + ')' : ''));
            // @ts-ignore
            err.code = status;
            throw err;
        }
    } else if (process.argv[3] === 'unregister') {
        console.log('Unregister');
    } else if (process.argv[3] === 'list-hostnames') {
        client.connection?.send(MessageType.LIST_HOSTS, Buffer.alloc(0));
        let [, data] = await client.connection!.waitForMessage(type => type === MessageType.LIST_HOSTS);

        const tlv_entries: [ListHostsHostnameType, Buffer][] = [];
        while (data.length) {
            if (data.length < 5) throw new Error('Invalid data - ' + data.length + ' bytes remaining');
            const type = data.readUInt8(0);
            const length = data.readUInt32BE(1);
            if (data.length < 5 + length) throw new Error('Not enough data - expected ' + (data.length - length) + ' bytes');
            const value = data.slice(5, 5 + length);
            tlv_entries.push([type, value]);
            data = data.slice(5 + length);
        }

        type HostnameDetails = Record<ListHostsHostnameType, Buffer | undefined>;
        const entries: HostnameDetails[] = [];
        let current_hostname: HostnameDetails | null = null;
        for (const entry of tlv_entries) {
            if (!current_hostname) entries.push(current_hostname = {} as HostnameDetails);
            if (entry[0] === ListHostsHostnameType.SEPARATOR) current_hostname = null;
            current_hostname![entry[0]] = entry[1];
        }

        const hostnames = entries.map(entry => ({
            hostname: entry[ListHostsHostnameType.HOSTNAME]?.toString(),
            domain: entry[ListHostsHostnameType.DOMAIN]?.toString() || null,
            status: entry[ListHostsHostnameType.STATUS]?.readUInt32BE(0),
            _s: ListHostsHostnameStatus[entry[ListHostsHostnameType.STATUS]?.readUInt32BE(0) ?? -1] || null,
        }));

        console.log('Hostnames', ...hostnames);
    } else if (process.argv[3] === 'add-hostname') {
        const hostname = process.argv[4];
        client.connection?.send(MessageType.ADD_HOST, Buffer.from(hostname));
        const [, data] = await client.connection!.waitForMessage(type => type === MessageType.ADD_HOST);
        const status: AddHostStatus = data.readUInt32BE(0);

        console.log(AddHostStatus[status], status);
    } else if (process.argv[3] === 'remove-hostname') {
        const hostname = process.argv[4];
        client.connection?.send(MessageType.REMOVE_HOST, Buffer.from(hostname));
        const [, data] = await client.connection!.waitForMessage(type => type === MessageType.REMOVE_HOST);
        const status: RemoveHostStatus = data.readUInt32BE(0);

        console.log(RemoveHostStatus[status], status);
    } else if (process.argv[3] === 'list-services') {
        const hostname = process.argv[4] || null;
        client.connection?.send(MessageType.LIST_SERVICES, Buffer.from(hostname || ''));
        const [, data] = await client.connection!.waitForMessage(type => type === MessageType.LIST_SERVICES);
        let remaining_data = data;
        const services: {type: ServiceType, _t: string | null, identifier: number}[] = [];

        while (remaining_data.length) {
            if (remaining_data.length < 6) {
                console.error('Not enough data - expected %d bytes', 6 - remaining_data.length);
                break;
            }

            const type = remaining_data.readUInt16BE(0);
            const identifier = remaining_data.readUInt32BE(2);
            remaining_data = remaining_data.slice(6);

            services.push({type, _t: ServiceType[type] || null, identifier});
        }

        console.log('Services', ...services);
    } else if (process.argv[3] === 'service') {
        // bin/tunnelctl $AUTH service $TYPE $IDENTIFIER $HOSTNAME
        // bin/tunnelctl - service HTTP 0 localhost
        // bin/tunnelctl - service HTTPS 0 localhost
        // bin/tunnelctl - service HTTP_HTTPS 0 localhost

        const [,, auth,, _service_type, _service_identifier, hostname] = process.argv;
        const service_type: ServiceType =
            parseInt(_service_type) || ServiceType[_service_type as keyof typeof ServiceType];
        const service_identifier = parseInt(_service_identifier);

        console.log('Connecting service', {auth, service_type, service_identifier, hostname});
        const status = await client.connectService(service_type, service_identifier, hostname);

        client.on('service-connection', (service_connection: ServiceConnection) => {
            console.log('New connection from %s port %d, server %s port %d',
                service_connection.remoteAddress, service_connection.remotePort,
                service_connection.localAddress, service_connection.localPort);
            (service_type === ServiceType.HTTP ? http_server :
                service_type === ServiceType.HTTPS ? https_server :
                service_type === ServiceType.HTTP_HTTPS ? http_https_server :
                null)!.emit('connection', service_connection);
        });

        const http_server = http.createServer((req, res) => {
            res.end('It works!\n');
        });
        const https_server = https.createServer({
            // cert: ...,
            // key: ...,
        }, (req, res) => {
            res.end('It works!\n');
        });
        const http_https_server: net.Server = net.createServer(connection => {
            const data = connection.read(1);
            if (!data) return connection.once('readable', () => http_https_server.emit('connection', connection));
            const first_byte = data[0];
            connection.unshift(data);
            if (first_byte < 32 || first_byte >= 127) {
                https_server.emit('connection', connection);
            } else {
                http_server.emit('connection', connection);
            }
        });

        return;
    }

    process.exit(0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});

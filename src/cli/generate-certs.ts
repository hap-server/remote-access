
import * as path from 'path';
import * as fs from 'fs';
import * as forge from 'node-forge';
import {SubjectAltNameType} from '../types/node-forge';

function generateKeyPair(options?: forge.pki.rsa.GenerateKeyPairOptions): Promise<forge.pki.rsa.KeyPair> {
    return new Promise((rs, rj) => forge.pki.rsa.generateKeyPair(options, (err, keypair) => {
        // keypair.privateKey, keypair.publicKey
        err ? rj(err) : rs(keypair);
    }));
}

(async ({data_path, server_hostname}) => {
    //
    // Generate root CA keys
    //

    if (!await fs.promises.stat(path.join(data_path, 'root-privkey.pem')).then(stat => true, err => false)) {
        console.log('Generating root CA keypair');
        const keypair = await generateKeyPair({
            bits: 4096,
        });

        const private_key_pem = forge.pki.privateKeyToPem(keypair.privateKey);

        await fs.promises.writeFile(path.join(data_path, 'root-privkey.pem'), private_key_pem, 'utf-8');
    }

    //
    // Generate root CA
    //

    if (!await fs.promises.stat(path.join(data_path, 'root-cert.pem')).then(stat => true, err => false)) {
        console.log('Generating root CA');
        const private_key_pem = await fs.promises.readFile(path.join(data_path, 'root-privkey.pem'), 'utf-8');
        const private_key = forge.pki.privateKeyFromPem(private_key_pem) as forge.pki.rsa.PrivateKey;
        const public_key = forge.pki.rsa.setPublicKey(private_key.n, private_key.e);

        const attrs = [
            {name: 'commonName', value: server_hostname + ' Tunnel Server Root Certificate Authority'},
            {name: 'countryName', value: 'GB'},
            // {shortName: 'ST', value: 'Virginia'},
            // {name: 'localityName', value: 'Blacksburg'}, 
            // {name: 'organizationName', value: 'Test'},
            {shortName: 'OU', value: server_hostname},
        ];

        const cert = forge.pki.createCertificate();
        cert.publicKey = public_key;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + (1000 * 60 * 60 * 24 * 370 * 10));
        cert.setSubject(attrs);
        cert.setIssuer(attrs);

        cert.setExtensions([
            {
                name: 'basicConstraints',
                cA: true,
                critical: true,
            },
            {
                name: 'keyUsage',
                keyCertSign: true,
                digitalSignature: true,
                nonRepudiation: true,
                keyEncipherment: true,
                dataEncipherment: true,
            },
            {
                name: 'extKeyUsage',
                serverAuth: true,
                clientAuth: true,
                codeSigning: true,
                emailProtection: true,
                timeStamping: true,
            },
            {
                name: 'subjectKeyIdentifier',
            },
        ]);

        // Self sign the CA
        cert.sign(private_key);

        const cert_pem = forge.pki.certificateToPem(cert);

        await fs.promises.writeFile(path.join(data_path, 'root-cert.pem'), cert_pem, 'utf-8');
    }

    //
    // Generate intermediate CA keys
    //

    if (!await fs.promises.stat(path.join(data_path, 'intermediate-privkey.pem')).then(stat => true, err => false)) {
        console.log('Generating intermediate CA keypair');
        const keypair = await generateKeyPair({
            bits: 4096,
        });

        const private_key_pem = forge.pki.privateKeyToPem(keypair.privateKey);

        await fs.promises.writeFile(path.join(data_path, 'intermediate-privkey.pem'), private_key_pem, 'utf-8');
    }

    //
    // Generate intermediate CA
    //

    if (!await fs.promises.stat(path.join(data_path, 'intermediate-cert.pem')).then(stat => true, err => false)) {
        console.log('Generating intermediate CA');

        const root_private_key_pem = await fs.promises.readFile(path.join(data_path, 'root-privkey.pem'), 'utf-8');
        const root_private_key = forge.pki.privateKeyFromPem(root_private_key_pem) as forge.pki.rsa.PrivateKey;
        const root_cert_pem = await fs.promises.readFile(path.join(data_path, 'root-cert.pem'), 'utf-8');
        const root_cert = forge.pki.certificateFromPem(root_cert_pem);

        const private_key_pem = await fs.promises.readFile(path.join(data_path, 'intermediate-privkey.pem'), 'utf-8');
        const private_key = forge.pki.privateKeyFromPem(private_key_pem) as forge.pki.rsa.PrivateKey;
        const public_key = forge.pki.rsa.setPublicKey(private_key.n, private_key.e);

        const attrs = [
            {name: 'commonName', value: server_hostname + ' Tunnel Server Certificate Authority'},
            {name: 'countryName', value: 'GB'},
            // {shortName: 'ST', value: 'Virginia'},
            // {name: 'localityName', value: 'Blacksburg'}, 
            // {name: 'organizationName', value: 'Test'},
            {shortName: 'OU', value: server_hostname},
        ];

        const cert = forge.pki.createCertificate();
        cert.publicKey = public_key;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + (1000 * 60 * 60 * 24 * 370 * 10));
        cert.setSubject(attrs);
        cert.setIssuer(root_cert.subject.attributes);

        cert.setExtensions([
            {
                name: 'basicConstraints',
                cA: true,
                pathLenConstraint: 0,
                critical: true,
            },
            {
                name: 'keyUsage',
                keyCertSign: true,
                digitalSignature: true,
                nonRepudiation: true,
                keyEncipherment: true,
                dataEncipherment: true,
            },
            {
                name: 'extKeyUsage',
                serverAuth: true,
                clientAuth: true,
                codeSigning: true,
                emailProtection: true,
                timeStamping: true,
            },
            {
                name: 'subjectKeyIdentifier',
            },
        ]);

        cert.sign(root_private_key);

        const cert_pem = forge.pki.certificateToPem(cert);

        await fs.promises.writeFile(path.join(data_path, 'intermediate-cert.pem'), cert_pem, 'utf-8');
    }

    //
    // Generate server keys
    //

    if (!await fs.promises.stat(path.join(data_path, 'server-privkey.pem')).then(stat => true, err => false)) {
        console.log('Generating server keypair');
        const keypair = await generateKeyPair({
            bits: 4096,
        });

        const private_key_pem = forge.pki.privateKeyToPem(keypair.privateKey);

        await fs.promises.writeFile(path.join(data_path, 'server-privkey.pem'), private_key_pem, 'utf-8');
    }

    //
    // Generate server certificate
    //

    if (!await fs.promises.stat(path.join(data_path, 'server-cert.pem')).then(stat => true, err => false)) {
        console.log('Generating server certificate');

        const intermediate_private_key_pem = await fs.promises.readFile(path.join(data_path, 'intermediate-privkey.pem'), 'utf-8');
        const intermediate_private_key = forge.pki.privateKeyFromPem(intermediate_private_key_pem) as forge.pki.rsa.PrivateKey;
        const intermediate_cert_pem = await fs.promises.readFile(path.join(data_path, 'intermediate-cert.pem'), 'utf-8');
        const intermediate_cert = forge.pki.certificateFromPem(intermediate_cert_pem);

        const private_key_pem = await fs.promises.readFile(path.join(data_path, 'server-privkey.pem'), 'utf-8');
        const private_key = forge.pki.privateKeyFromPem(private_key_pem) as forge.pki.rsa.PrivateKey;
        const public_key = forge.pki.rsa.setPublicKey(private_key.n, private_key.e);

        const attrs = [
            {name: 'commonName', value: server_hostname + ' Tunnel Server'},
            {name: 'countryName', value: 'GB'},
            // {shortName: 'ST', value: 'Virginia'},
            // {name: 'localityName', value: 'Blacksburg'}, 
            // {name: 'organizationName', value: 'Test'},
            {shortName: 'OU', value: server_hostname},
        ];

        const cert = forge.pki.createCertificate();
        cert.publicKey = public_key;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + (1000 * 60 * 60 * 24 * 370 * 10));
        cert.setSubject(attrs);
        cert.setIssuer(intermediate_cert.subject.attributes);

        cert.setExtensions([
            {
                name: 'basicConstraints',
                cA: false,
                critical: true,
            },
            {
                name: 'keyUsage',
                keyCertSign: false,
                digitalSignature: true,
                nonRepudiation: true,
                keyEncipherment: true,
                dataEncipherment: true,
            },
            {
                name: 'extKeyUsage',
                serverAuth: true,
                clientAuth: false,
                codeSigning: false,
                emailProtection: false,
                timeStamping: false,
            },
            {
                name: 'subjectAltName',
                altNames: [
                    // https://tools.ietf.org/html/rfc5280#section-4.2.1.6
                    // URI
                    {type: SubjectAltNameType.DNS_NAME, value: server_hostname},
                ],
                critical: true,
            },
            {
                name: 'subjectKeyIdentifier',
            },
        ]);

        cert.sign(intermediate_private_key);

        const cert_pem = forge.pki.certificateToPem(cert);

        await fs.promises.writeFile(path.join(data_path, 'server-cert.pem'), cert_pem, 'utf-8');
    }

    //
    // Generate client certificate CA keys
    //

    if (!await fs.promises.stat(path.join(data_path, 'issuer-privkey.pem')).then(stat => true, err => false)) {
        console.log('Generating client certificate CA keypair');
        const keypair = await generateKeyPair({
            bits: 4096,
        });

        const private_key_pem = forge.pki.privateKeyToPem(keypair.privateKey);

        await fs.promises.writeFile(path.join(data_path, 'issuer-privkey.pem'), private_key_pem, 'utf-8');
    }

    //
    // Generate client certificate CA
    //

    if (!await fs.promises.stat(path.join(data_path, 'issuer-cert.pem')).then(stat => true, err => false)) {
        console.log('Generating client certificate CA');

        const root_private_key_pem = await fs.promises.readFile(path.join(data_path, 'root-privkey.pem'), 'utf-8');
        const root_private_key = forge.pki.privateKeyFromPem(root_private_key_pem) as forge.pki.rsa.PrivateKey;
        const root_cert_pem = await fs.promises.readFile(path.join(data_path, 'root-cert.pem'), 'utf-8');
        const root_cert = forge.pki.certificateFromPem(root_cert_pem);

        const private_key_pem = await fs.promises.readFile(path.join(data_path, 'issuer-privkey.pem'), 'utf-8');
        const private_key = forge.pki.privateKeyFromPem(private_key_pem) as forge.pki.rsa.PrivateKey;
        const public_key = forge.pki.rsa.setPublicKey(private_key.n, private_key.e);

        const attrs = [
            {name: 'commonName', value: server_hostname + ' Tunnel Server Client Certificate Authority'},
            {name: 'countryName', value: 'GB'},
            // {shortName: 'ST', value: 'Virginia'},
            // {name: 'localityName', value: 'Blacksburg'}, 
            // {name: 'organizationName', value: 'Test'},
            {shortName: 'OU', value: server_hostname},
        ];

        const cert = forge.pki.createCertificate();
        cert.publicKey = public_key;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + (1000 * 60 * 60 * 24 * 370 * 10));
        cert.setSubject(attrs);
        cert.setIssuer(root_cert.subject.attributes);

        cert.setExtensions([
            {
                name: 'basicConstraints',
                cA: true,
                pathLenConstraint: 0,
                critical: true,
            },
            {
                name: 'keyUsage',
                keyCertSign: true,
                digitalSignature: false,
                nonRepudiation: false,
                keyEncipherment: false,
                dataEncipherment: false,
            },
            {
                name: 'extKeyUsage',
                serverAuth: false,
                clientAuth: true,
                codeSigning: false,
                emailProtection: false,
                timeStamping: false,
            },
            {
                name: 'subjectKeyIdentifier',
            },
        ]);

        cert.sign(root_private_key);

        const cert_pem = forge.pki.certificateToPem(cert);

        await fs.promises.writeFile(path.join(data_path, 'issuer-cert.pem'), cert_pem, 'utf-8');
    }
})({
    data_path: path.resolve(process.cwd(), process.argv[2]),
    server_hostname: process.argv[3] || 'hapserver-tunnel.fancy.org.uk',
});

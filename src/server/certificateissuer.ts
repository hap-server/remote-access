
import {promises as fs} from 'fs';
import * as forge from 'node-forge';
import {CertificationRequest, SubjectAltNameType} from '../types/node-forge';

export interface CertificateIssuer {
    issueCertificateForRequest(csr: CertificationRequest): Promise<forge.pki.Certificate[]> | forge.pki.Certificate[];
}

export default class DefaultCertificateIssuer implements CertificateIssuer {
    private_key: forge.pki.PrivateKey;
    issuer: forge.pki.CertificateField[];
    issuer_chain: forge.pki.Certificate[] = [];

    certificate_lifetime = 1000 * 60 * 60 * 24 * 398; // 398 days
    log: fs.FileHandle | null = null;

    constructor(private_key: forge.pki.PrivateKey, issuer: forge.pki.CertificateField[])
    constructor(private_key: forge.pki.PrivateKey, ...chain: forge.pki.Certificate[])
    constructor(private_key: forge.pki.PrivateKey, ...certs: forge.pki.Certificate[] | [forge.pki.CertificateField[]]) {
        this.private_key = private_key;

        if (certs[0] instanceof Array) {
            this.issuer = certs[0];
        } else {
            this.issuer = certs[0].subject.attributes;

            this.issuer_chain.push(...certs as forge.pki.Certificate[]);
        }
    }

    static async createFromFiles(private_key_path: string, ...certs_path: string[]) {
        const [private_key_pem, ...certs_pem] = await Promise.all([
            fs.readFile(private_key_path, 'utf-8'),
            ...certs_path.map(cert_path => fs.readFile(cert_path, 'utf-8')),
        ]);

        return this.createFromPem(private_key_pem, ...certs_pem);
    }

    static createFromPem(private_key_pem: string, ...certs_pem: string[]) {
        const private_key = forge.pki.privateKeyFromPem(private_key_pem);
        const issuer_chain = certs_pem.map(cert_pem => forge.pki.certificateFromPem(cert_pem));

        return new this(private_key, ...issuer_chain);
    }

    async issueCertificateForRequest(csr: CertificationRequest): Promise<forge.pki.Certificate[]> {
        const email_address: string | undefined = csr.getAttribute({name: 'emailAddress'})?.value;

        const cert = forge.pki.createCertificate();
        cert.publicKey = csr.publicKey!;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + this.certificate_lifetime);
        cert.setSubject(csr.subject.attributes);
        cert.setIssuer(this.issuer);

        cert.setExtensions([
            {
                name: 'keyUsage',
                keyCertSign: false,
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
                name: 'nsCertType',
                client: true,
                server: false,
                email: false,
                objsign: false,
                sslCA: false,
                emailCA: false,
                objCA: false,
            },
            ...(email_address ? [{
                name: 'subjectAltName',
                altNames: [
                    // https://tools.ietf.org/html/rfc5280#section-4.2.1.6
                    {type: SubjectAltNameType.EMAIL_ADDRESS, value: email_address},
                ],
            }] : []),
            {
                name: 'subjectKeyIdentifier',
            },
        ]);

        cert.sign(this.private_key);

        const cert_pem = forge.pki.certificateToPem(cert);
        // console.log('Issued certificate', cert_pem);
        await this.log?.appendFile(cert_pem, 'utf-8');

        return [cert, ...this.issuer_chain];
    }
}

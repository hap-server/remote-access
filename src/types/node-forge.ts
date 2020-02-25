import * as forge from 'node-forge';

declare module 'node-forge' {
    namespace pki {
        export function certificationRequestFromPem(pem: string, computeHash?: boolean | undefined, strict?: boolean | undefined): CertificationRequest;
        export function certificationRequestToPem(csr: CertificationRequest, maxline?: number | undefined): string
        export function certificationRequestFromAsn1(obj: forge.asn1.Asn1, computeHash?: boolean): CertificationRequest;
        export function createCertificationRequest(): CertificationRequest;
        export function certificationRequestToAsn1(csr: CertificationRequest): forge.asn1.Asn1;
        
        export {CertificationRequest};
    }
}

export interface CertificationRequest {
    version: number;
    signatureOid: unknown | null;
    signature: unknown | null;
    siginfo: {
        /** Same as signatureOid */
        algorithmOid: unknown | null;
    };

    subject: {
        getField(sn: string | forge.pki.GetAttributeOpts): forge.pki.Attribute | null;
        addField(attr: forge.pki.CertificateField): void;
        attributes: forge.pki.Attribute[];
        hash: string | null;
    };

    publicKey: forge.pki.PublicKey | null;
    attributes: forge.pki.Attribute[];
    getAttribute(sn: string | forge.pki.GetAttributeOpts): forge.pki.Attribute | null;
    addAttribute(attr: forge.pki.CertificateField): void;
    md: forge.md.MessageDigest | null;

    /**
     * Sets the subject of this certification request.
     *
     * @param attrs the array of subject attributes to use.
     */
    setSubject(attrs: forge.pki.CertificateField[]): void;

    /**
     * Sets the attributes of this certification request.
     *
     * @param attrs the array of attributes to use.
     */
    setAttributes(attrs: forge.pki.CertificateField[]): void;

    /**
     * Signs this certification request using the given private key.
     *
     * @param key the private key to sign with.
     * @param md the message digest object to use (defaults to forge.md.sha1).
     */
    sign(key: forge.pki.PrivateKey, md?: forge.md.MessageDigest): void;

    /**
     * Attempts verify the signature on the passed certification request using
     * its public key.
     *
     * A CSR that has been exported to a file in PEM format can be verified using
     * OpenSSL using this command:
     *
     * openssl req -in <the-csr-pem-file> -verify -noout -text
     *
     * @return true if verified, false if not.
     */
    verify(): boolean;
}

export enum SubjectAltNameType {
    OTHER_NAME = 0,
    RFC822_NAME = 1,
    EMAIL_ADDRESS = 1,
    DNS_NAME = 2,
    X400_ADDRESS = 3,
    DIRECTORY_NAME = 4,
    EDI_PARTY_NAME = 5,
    URI = 6,
    IP_ADDRESS = 7,
    REGISTERED_ID = 8,
}

import * as ipaddr from 'ip6addr';
import * as forge from 'node-forge';

export function ipaddrFromBuffer(buffer: Buffer) {
    if (buffer.length === 4) {
        return ipaddr.parse(`${buffer[0]}.${buffer[1]}.${buffer[2]}.${buffer[3]}`);
    }

    if (buffer.length !== 16) {
        throw new Error('Must be 4 or 16 bytes');
    }

    return ipaddr.parse(buffer.toString('hex').replace(/([a-f0-9]{4})(?!$)/g, '$1:'));
}

export function getCertificateFingerprint(cert: forge.pki.Certificate, algorithm: 'sha256' = 'sha256') {
    if (algorithm === 'sha256') {
        const sha256 = forge.md.sha256.create();
        // @ts-ignore
        sha256.start();
        sha256.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
        return sha256.digest().toHex().replace(/(.{2})(?!$)/g, m => `${m}:`);
    }

    throw new Error('Unknown algorithm');
}

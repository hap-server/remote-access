import * as ipaddr from 'ip6addr';

export function ipaddrFromBuffer(buffer: Buffer) {
    if (buffer.length === 4) {
        return ipaddr.parse(`${buffer[0]}.${buffer[1]}.${buffer[2]}.${buffer[3]}`);
    }

    if (buffer.length !== 16) {
        throw new Error('Must be 4 or 16 bytes');
    }

    return ipaddr.parse(buffer.toString('hex').replace(/([a-f0-9]{4})(?!$)/g, '$1:'));
}

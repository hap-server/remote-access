import {EventEmitter} from 'events';
import {MessageType} from '../common/message-types';

export default abstract class Connection extends EventEmitter {
    protected buffer = Buffer.alloc(0);

    log: typeof import('@hap-server/api').log | import('@hap-server/api/homebridge').Logger | typeof console = console;

    abstract close(): void;

    handleData(chunk: Buffer) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length) {
            // Haven't received the message type and length yet
            if (this.buffer.length < 5) break;

            const length = this.buffer.readUInt32BE(1);

            // Haven't received the full message yet
            if (this.buffer.length < 5 + length) break;

            const type = this.buffer.readUInt8(0);
            const data = this.buffer.slice(5, 5 + length);
            this.buffer = this.buffer.slice(5 + length);

            this.handleMessage(type, data);
        }
    }

    handleMessage(type: MessageType, data: Buffer) {
        this.emit('message', type, data);
    }

    waitForMessage(filter: (type: MessageType, data: Buffer) => boolean) {
        return new Promise<[MessageType, Buffer]>((resolve, reject) => {
            const onmessage = (type: MessageType, data: Buffer) => {
                if (!filter.call(this, type, data)) return;

                resolve([type, data]);

                this.removeListener('message', onmessage);
                this.removeListener('close', onclose);
            };
            const onclose = () => {
                reject(new Error('Disconnected'));

                this.removeListener('message', onmessage);
                this.removeListener('close', onclose);
            };

            this.on('message', onmessage);
            this.on('close', onclose);
        });
    }

    send(type: MessageType, data: Buffer) {
        const header = Buffer.alloc(5);
        header.writeUInt8(type, 0);
        header.writeUInt32BE(data.length, 1);

        this._write(Buffer.concat([header, data]));
    }

    protected abstract _write(data: Buffer): void;
}

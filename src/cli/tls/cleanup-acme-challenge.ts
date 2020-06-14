import {Challenge} from '../../init/tls';
import * as http from 'http';

interface ChallengeCleanup extends Challenge {
    auth_output: string;
}

const challenge: ChallengeCleanup = {
    domain: process.env.CERTBOT_DOMAIN!,
    validation: process.env.CERTBOT_VALIDATION!,
    token: process.env.CERTBOT_TOKEN,
    remaining_challenges: process.env.CERTBOT_REMAINING_CHALLENGES!,
    all_domains: process.env.CERTBOT_ALL_DOMAINS!,
    auth_output: process.env.CERTBOT_AUTH_OUTPUT!,
};

http.request({
    method: 'DELETE',
    path: '/challenge/' + challenge.domain,
    host: '::1',
    port: parseInt(process.env.TUNNEL_CHALLENGE_SERVER?.substr(process.env.TUNNEL_CHALLENGE_SERVER.lastIndexOf(':') + 1)!),
}, async response => {
    const data = await new Promise<Buffer>((resolve, reject) => {
        let data = Buffer.alloc(0);

        const ondata = (chunk: Buffer) => {
            data = Buffer.concat([data, chunk]);
        };
        const onend = () => {
            response.removeListener('data', ondata);
            response.removeListener('end', onend);
            response.removeListener('error', onerror);
            resolve(data);
        };
        const onerror = (err: Error) => {
            response.removeListener('data', ondata);
            response.removeListener('end', onend);
            response.removeListener('error', onerror);
            reject(err);
        };

        response.on('data', ondata);
        response.on('end', onend);
        response.on('error', onerror);
    });

    if (response.statusCode === 200) {
        console.log(data);
        process.exit(0);
    } else {
        console.error('Received status code %d', response.statusCode);
        console.log(data);
        process.exit(1);
    }
}).end();

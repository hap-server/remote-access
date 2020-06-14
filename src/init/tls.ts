import * as tls from 'tls';
import {promises as fs} from 'fs';
import * as child_process from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as url from 'url';
import mkdirp = require('mkdirp');
import {ServiceConnection} from '../client';

type TunnelPlugin = import('./hap-server').TunnelPlugin | import('./homebridge').TunnelPlugin;

export async function getSecureContext(plugin: TunnelPlugin): Promise<tls.SecureContext> {
    const hostname = plugin.hostname;

    if (!hostname) throw new Error('Not ready');

    const certbot_options: CertbotOptions = {
        path: plugin.config.certbot_path,

        data_path: plugin.config.certbot_data_path || plugin.certbot_data_path,
        challenge_server_path:
            path.join(plugin.config.certbot_data_path || plugin.certbot_data_path, 'challenge-server.sock'),

        acme_server: plugin.config.certbot_acme_server,

        agree_tos: plugin.config.certbot_agree_tos,
        subscriber_email_address: plugin.config.certbot_email_address ||
            ('"tunnelserver-hostname+' + plugin.hostname + '"@' + url.parse(plugin.tunnel_client.url).hostname),
    };

    await mkdirp(certbot_options.data_path);

    const certs_path = path.join(certbot_options.data_path, 'config', 'live', hostname);

    try {
        await fs.stat(certs_path);
    } catch (err) {
        // Request a new certificate

        const challenge_responder = await createChallengeResponder(plugin, certbot_options.challenge_server_path);
        try {
            await certbotRun(hostname, [hostname], certbot_options);

            await fs.writeFile(path.join(certbot_options.data_path, 'renew-timestamp'), Date.now() + '\n', 'utf-8');

            return tls.createSecureContext({
                cert: await fs.readFile(path.join(certs_path, 'fullchain.pem')),
                key: await fs.readFile(path.join(certs_path, 'privkey.pem')),
            });
        } finally {
            challenge_responder.close();
        }
    }

    try {
        const ts = parseInt(await fs.readFile(path.join(certbot_options.data_path, 'renew-timestamp'), 'utf-8'));
        if ((ts + (24 * 3600)) < Date.now()) throw new Error('Last renew check was more than 12 hours ago');
    } catch (err) {
        // Renew the certificate

        try {
            await certbotRenew(hostname, certbot_options);

            await fs.writeFile(path.join(certbot_options.data_path, 'renew-timestamp'), Date.now() + '\n', 'utf-8');
        } catch (err) {
            plugin.tunnel_client.log.error('Error renewing certificate', err);
        }
    }

    return tls.createSecureContext({
        cert: await fs.readFile(path.join(certs_path, 'fullchain.pem')),
        key: await fs.readFile(path.join(certs_path, 'privkey.pem')),
    });
}

export interface Challenge {
    domain: string;
    validation: string;
    token?: string;
    remaining_challenges: string;
    all_domains: string;
}

async function createChallengeResponder(plugin: TunnelPlugin, socket_path: string): Promise<http.Server> {
    const challenges = new Map<string, Challenge>();

    const server = http.createServer(async (request, response) => {
        if (request.method === 'POST' && request.url === '/challenge') {
            const data = await new Promise<Buffer>((resolve, reject) => {
                let data = Buffer.alloc(0);

                const ondata = (chunk: Buffer) => {
                    data = Buffer.concat([data, chunk]);
                };
                const onend = () => {
                    request.removeListener('data', ondata);
                    request.removeListener('end', onend);
                    request.removeListener('error', onerror);
                    resolve(data);
                };
                const onerror = (err: Error) => {
                    request.removeListener('data', ondata);
                    request.removeListener('end', onend);
                    request.removeListener('error', onerror);
                    reject(err);
                };

                request.on('data', ondata);
                request.on('end', onend);
                request.on('error', onerror);
            });

            const challenge: Challenge = JSON.parse(data.toString());

            if (challenges.has(challenge.domain)) {
                response.writeHead(500);
                return response.end('Already waiting for a challenge for this domain');
            }

            challenges.set(challenge.domain, challenge);

            response.end();
        } else if (request.method === 'DELETE' && request.url?.startsWith('/challenge/')) {
            const domain = request.url.substr(11);
            const challenge = challenges.get(domain);

            if (!challenge) {
                response.writeHead(500);
                return response.end('No challenge for this domain');
            }

            challenges.delete(challenge.domain);

            response.end();
        } else {
            response.writeHead(404);
            response.end();
        }
    });

    await new Promise((rs, rj) => server.listen(path, rs));

    plugin.acme_http01_challenge.challenge_sets.add(challenges);

    server.on('close', () => {
        plugin.acme_http01_challenge.challenge_sets.delete(challenges);
    });

    return server;
}

export class AcmeHttp01Service {
    readonly challenge_sets = new Set<Map<string, Challenge>>();

    constructor(readonly plugin: TunnelPlugin) {}

    readonly http_server = http.createServer(async (request, response) => {
        if (request.method === 'GET' && request.url?.startsWith('/.well-known/acme-challenge/')) {
            const token = request.url.substr(28);

            for (const challenges of this.challenge_sets) {
                for (const challenge of challenges.values()) {
                    if (!challenge.token || challenge.token !== token) continue;

                    response.writeHead(200, {
                        'Content-Type': 'text/plain',
                    });
                    response.end(challenge.validation);
                    return;
                }
            }
        }

        response.writeHead(404);
        response.end();
    });

    handleConnection = (connection: ServiceConnection) => {
        this.http_server.emit('connection', connection);
    };
}

interface CertbotOptions {
    path?: string;
    data_path: string;
    /** ACME Directory Resource URI. (default: https://acme-v02.api.letsencrypt.org/directory) */
    acme_server?: string;
    agree_tos: boolean;
    /**
     * Email used for registration and recovery contact. Use comma to register multiple emails,
     * ex: u1@example.com,u2@example.com. (default: Ask).
     */
    subscriber_email_address: string;

    challenge_server_path: string;
}

async function certbotRun(certname: string, hostnames: string[], options: CertbotOptions) {
    return certbot([
        '--cert-name',
        certname,
        'certonly',
        '--manual',
        '--preferred-challenges=http-01',
        '--manual-auth-hook', 'set-tunnel-acme-challenge',
        '--manual-cleanup-hook', 'cleanup-tunnel-acme-challenge',

        ...hostnames.reduce((acc, hostname) => (acc.push('--domain', hostname), acc), [] as string[]),
    ], options);
}

async function certbotRenew(certname: string, options: CertbotOptions) {
    return certbot([
        '--cert-name',
        certname,
        'renew',
    ], options);
}

function certbot(args: string[], options: CertbotOptions) {
    if (options.agree_tos !== true) return Promise.reject(new Error('The `agree_tos` option is not set to `true`'));

    return new Promise((resolve, reject) => {
        const child = child_process.spawn(options.path || 'certbot', [
            '--config-dir', path.join(options.data_path, 'config'),
            '--work-dir', path.join(options.data_path, 'work'),
            '--logs-dir', path.join(options.data_path, 'log'),

            '--non-interactive',

            ...(options.acme_server ? [
                '--server', options.acme_server,
            ] : []),

            '--agree-tos',
            '--email', options.subscriber_email_address,

            ...args,
        ], {
            env: {
                ...process.env,

                PATH: path.resolve(__dirname, '..', '..', 'bin') +
                    (process.platform === 'win32' ? ';' : ':') + process.execPath +
                    process.env.PATH ? (process.platform === 'win32' ? ';' : ':') + process.env.PATH : '',

                TUNNEL_CHALLENGE_SERVER_SOCKET: options.challenge_server_path,
            },
        });

        child.stdout.on('data', data => {
            console.log('[certbot %d stdout] %s', child.pid, data);
        });
        child.stderr.on('data', data => {
            console.error('[certbot %d stderr] %s', child.pid, data);
        });

        child.on('close', (code, signal) => {
            if (code === 0) resolve();
            else reject();
        });
    });
}

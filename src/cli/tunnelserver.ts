import TunnelServer, {
    HttpService, TlsService, HttpTlsService,
    SQLiteClientProvider, DefaultCertificateIssuer as CertificateIssuer,
    DEFAULT_HTTP_SERVICE_IDENTIFIER, DEFAULT_TLS_SERVICE_IDENTIFIER,
    ServiceType,
} from '../server';

import * as net from 'net';
import * as path from 'path';
import {promises as fs, unlinkSync} from 'fs';

(async ({
    data_path, run_path,
    http_port, https_port, httphttps_port, server_port, secureserver_port,
    domains, hostname_regex,
}) => {
    await fs.writeFile(path.join(run_path, 'tunnel-server.pid'), process.pid, 'utf-8');
    let deleted_pid = false;
    process.on('exit', () => {
        if (!deleted_pid) unlinkSync(path.join(run_path, 'tunnel-server.pid')), deleted_pid = true;
    });

    const tunnelserver = new TunnelServer();

    const clientprovider = await SQLiteClientProvider.create(path.join(data_path, 'clients.sqlite'));

    const certissuer = await CertificateIssuer.createFromFiles(
        path.join(data_path, 'issuer-privkey.pem'),
        path.join(data_path, 'issuer-cert.pem'),
        path.join(data_path, 'root-cert.pem')
    );

    certissuer.log = await fs.open(path.join(data_path, 'clientcerts.pem'), 'a');

    clientprovider.issuer = certissuer;

    clientprovider.domains = domains;
    clientprovider.hostname_regex = hostname_regex;

    tunnelserver.addClientProvider(clientprovider);
    tunnelserver.setDefaultClientProvider(clientprovider);

    // Register the default HTTP service

    const http_service = await tunnelserver.addService(ServiceType.ACME_HTTP01_CHALLENGE, DEFAULT_HTTP_SERVICE_IDENTIFIER, HttpService, {
        host: '::',
        port: http_port,
    });

    const http_serviceaddress = http_service.server.address() as net.AddressInfo;
    console.log('Listening for HTTP connections for ACME challenges on %s port %d', http_serviceaddress.address, http_serviceaddress.port);

    // Register the default HTTPS service

    const https_service = await tunnelserver.addService(
        ServiceType.TLS, DEFAULT_TLS_SERVICE_IDENTIFIER, TlsService, {
        host: '::',
        port: https_port,
    });

    https_service.hostname_regex = /\.hapserver-tunnel\.test$/;

    const https_serviceaddress = https_service.server.address() as net.AddressInfo;
    console.log('Listening for HTTPS connections on %s port %d',
        https_serviceaddress.address, https_serviceaddress.port);

    // Register the default HTTP/HTTPS service

    const httphttps_service = await tunnelserver.addService(ServiceType.HTTP_TLS, 0, HttpTlsService, {
        host: '::',
        port: httphttps_port,
    });

    const httphttps_serviceaddress = httphttps_service.server.address() as net.AddressInfo;
    console.log('Listening for HTTP/HTTPS connections on %s port %d',
        httphttps_serviceaddress.address, httphttps_serviceaddress.port);

    // Start listening for tunnel server connections
    // This should be done after registering all services

    const server = await tunnelserver.createServer({
        host: '::',
        port: server_port,
    });

    const serveraddress = server.address() as net.AddressInfo;
    console.log('Listening for tunnel server connections on %s port %d', serveraddress.address, serveraddress.port);

    server.on('connection', socket => {
        console.log('[TS] New connection from %s port %s', socket.remoteAddress, socket.remotePort);

        socket.on('close', () => {
            console.log('[TS] Connection from     %s port %s closed', socket.remoteAddress, socket.remotePort);
        });
    });

    // Start listening for secure tunnel server connections

    const secureserver = await tunnelserver.createSecureServer({
        cert: Buffer.concat(await Promise.all([
            fs.readFile(path.join(data_path, 'server-cert.pem')),
            fs.readFile(path.join(data_path, 'intermediate-cert.pem')),
            fs.readFile(path.join(data_path, 'root-cert.pem')),
        ])),
        key: await fs.readFile(path.join(data_path, 'server-privkey.pem')),
        requestCert: true,
        rejectUnauthorized: false,
        ca: Buffer.concat(await Promise.all([
            fs.readFile(path.join(data_path, 'issuer-cert.pem')),
            fs.readFile(path.join(data_path, 'root-cert.pem')),
        ])),
    }, {
        host: '::',
        port: secureserver_port,
    });

    const secureserveraddress = secureserver.address() as net.AddressInfo;
    console.log('Listening for secure tunnel server connections on %s port %d',
        secureserveraddress.address, secureserveraddress.port);

    secureserver.on('connection', socket => {
        console.log('[TS] New secure connection from %s port %s, waiting for TLS',
            socket.remoteAddress, socket.remotePort);

        socket.on('close', () => {
            console.log('[TS] Secure connection from     %s port %s closed', socket.remoteAddress, socket.remotePort);
        });
    });
    secureserver.on('secureConnection', socket => {
        console.log('[TS] New secure connection from %s port %s', socket.remoteAddress, socket.remotePort);
    });

    process.on('SIGTERM', async () => {
        console.log('Received SIGTERM, closing all listening sockets and asking clients to reconnect');
        http_service.server.close();
        https_service.server.close();
        httphttps_service.server.close();
        server.close();
        secureserver.close();
        tunnelserver.shutdown();

        await fs.unlink(path.join(run_path, 'tunnel-server.pid'));
        deleted_pid = true;
    });

    // @ts-ignore
    global.tunnelserver = tunnelserver, global.http_service = http_service, global.https_service = https_service, global.httphttps_service = httphttps_service, global.server = server, global.secureserver = secureserver;
})({
    data_path: process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) :
        path.resolve(__dirname, '..', '..', 'data'),
    run_path: process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) :
        path.resolve(__dirname, '..', '..'),

    http_port: parseInt(process.env.HTTP_SERVER_PORT || '9001'),
    https_port: parseInt(process.env.HTTPS_SERVER_PORT || '9002'),
    httphttps_port: parseInt(process.env.HTTPHTTPS_SERVER_PORT || '9003'),
    server_port: parseInt(process.env.TUNNEL_SERVER_PORT || '9000'),
    secureserver_port: parseInt(process.env.SECURE_TUNNEL_SERVER_PORT || '9004'),

    domains: (process.env.TUNNEL_SERVER_DOMAINS || '').split(',').filter(d => d),
    hostname_regex: process.env.TUNNEL_SERVER_HOSTNAME_REGEX ?
        new RegExp(process.env.TUNNEL_SERVER_HOSTNAME_REGEX) : null,
});

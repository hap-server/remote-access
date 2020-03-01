import TunnelServer, {
    HttpService, HttpsService, HttpHttpsService,
    SQLiteClientProvider, DefaultCertificateIssuer as CertificateIssuer,
    DEFAULT_HTTP_SERVICE_IDENTIFIER, DEFAULT_HTTPS_SERVICE_IDENTIFIER,
    ServiceType,
} from '../server';

import * as net from 'net';
import * as path from 'path';
import {promises as fs} from 'fs';

(async ({data_path}) => {
    const tunnelserver = new TunnelServer();

    const clientprovider = await SQLiteClientProvider.create(path.join(data_path, 'clients.sqlite'));

    const certissuer = await CertificateIssuer.createFromFiles(
        path.join(data_path, 'issuer-privkey.pem'),
        path.join(data_path, 'issuer-cert.pem'),
        path.join(data_path, 'root-cert.pem')
    );

    certissuer.log = await fs.open(path.join(data_path, 'clientcerts.pem'), 'a');

    clientprovider.issuer = certissuer;

    clientprovider.domains = [
        'hapserver-tunnel.test',
    ];
    clientprovider.hostname_regex = /\.hapserver-tunnel\.test$/;

    tunnelserver.addClientProvider(clientprovider);
    tunnelserver.setDefaultClientProvider(clientprovider);

    // Register the default HTTP service

    const http_service = await tunnelserver.addService(ServiceType.HTTP, DEFAULT_HTTP_SERVICE_IDENTIFIER, HttpService, {
        host: '::',
        port: 9001,
    });

    const http_serviceaddress = http_service.server.address() as net.AddressInfo;
    console.log('Listening for HTTP connections on %s port %d', http_serviceaddress.address, http_serviceaddress.port);

    // Register the default HTTPS service

    const https_service = await tunnelserver.addService(
        ServiceType.HTTPS, DEFAULT_HTTPS_SERVICE_IDENTIFIER, HttpsService, {
        host: '::',
        port: 9002,
    });

    https_service.hostname_regex = /\.hapserver-tunnel\.test$/;

    const https_serviceaddress = https_service.server.address() as net.AddressInfo;
    console.log('Listening for HTTPS connections on %s port %d',
        https_serviceaddress.address, https_serviceaddress.port);

    // Register the default HTTP/HTTPS service

    const httphttps_service = await tunnelserver.addService(ServiceType.HTTP_HTTPS, 0, HttpHttpsService, {
        host: '::',
        port: 9003,
    });

    const httphttps_serviceaddress = httphttps_service.server.address() as net.AddressInfo;
    console.log('Listening for HTTP/HTTPS connections on %s port %d',
        httphttps_serviceaddress.address, httphttps_serviceaddress.port);

    // Start listening for tunnel server connections
    // This should be done after registering all services

    const server = await tunnelserver.createServer({
        host: '::',
        port: 9000,
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
        port: 9004,
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

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, closing all listening sockets and asking clients to reconnect');
        http_service.server.close();
        https_service.server.close();
        httphttps_service.server.close();
        server.close();
        secureserver.close();
        tunnelserver.shutdown();
    });

    // @ts-ignore
    global.tunnelserver = tunnelserver, global.http_service = http_service, global.https_service = https_service, global.httphttps_service = httphttps_service, global.server = server, global.secureserver = secureserver;
})({
    data_path: process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) :
        path.resolve(__dirname, '..', '..', 'data'),
});

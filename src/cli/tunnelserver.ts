import TunnelServer, {Service} from '../server';
import HttpService from '../server/httpservice';
import HttpsService from '../server/httpsservice';
import HttpHttpsService from '../server/httphttpsservice';
import LocalClientProvider from '../server/localclientprovider';
import {DEFAULT_HTTP_SERVICE_IDENTIFIER, DEFAULT_HTTPS_SERVICE_IDENTIFIER} from '../constants';
import {ServiceType} from '../common/message-types';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

(async ({data_path}) => {
    const tunnelserver = new TunnelServer();

    const clientprovider = new LocalClientProvider(path.join(data_path, 'clients.json'));

    await clientprovider.ready;

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
        cert: fs.readFileSync(path.join(data_path, 'cert.pem')),
        key: fs.readFileSync(path.join(data_path, 'privkey.pem')),
    }, {
        host: '::',
        port: 9004,
    });

    const secureserveraddress = secureserver.address() as net.AddressInfo;
    console.log('Listening for secure tunnel server connections on %s port %d',
        secureserveraddress.address, secureserveraddress.port);

    secureserver.on('connection', socket => {
        console.log('[TS] New secure connection from %s port %s', socket.remoteAddress, socket.remotePort);

        socket.on('close', () => {
            console.log('[TS] Secure connection from     %s port %s closed', socket.remoteAddress, socket.remotePort);
        });
    });
})({
    data_path: process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) :
        path.resolve(__dirname, '..', '..', 'data'),
});

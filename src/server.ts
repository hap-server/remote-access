import TunnelServer, {ClientProvider, Service} from './server/index';
import HttpService from './server/httpservice';
import HttpsService from './server/httpsservice';
import HttpHttpsService from './server/httphttpsservice';
// import LocalClientProvider from './server/localclientprovider';

export default TunnelServer;
export {
    ClientProvider,
    Service,
    HttpService,
    HttpsService,
    HttpHttpsService,
    // LocalClientProvider,
};

export {
    DEFAULT_HTTP_SERVICE_IDENTIFIER,
    DEFAULT_HTTPS_SERVICE_IDENTIFIER,
} from './constants';
export {
    RegisterStatus,
    UnregisterStatus,
    ListHostsHostnameStatus,
    AddHostStatus,
    RemoveHostStatus,
    ServiceType,
    ConnectServiceStatus,
    DisconnectServiceStatus,
    CloseConnectionStatus,
} from './common/message-types';

/**
 * MessageType is an 8 bit unsigned integer.
 */
export enum MessageType {
    PROTOCOL_VERSION                        = 0x00,
    PING                                    = 0x01,
    RECONNECT                               = 0x02,

    REGISTER                                = 0x10,
    UNREGISTER                              = 0x11,
    RENEW_REGISTRATION                      = 0x12,
    REVOKE_CERTIFICATE                      = 0x13,

    LIST_HOSTS                              = 0x20,
    ADD_HOST                                = 0x21,
    REMOVE_HOST                             = 0x22,
    LIST_DOMAINS                            = 0x23,

    LIST_SERVICES                           = 0x30,
    CONNECT_SERVICE                         = 0x31,
    DISCONNECT_SERVICE                      = 0x32,

    CONNECTION                              = 0x40,
    CLOSE_CONNECTION                        = 0x41,
    MESSAGE                                 = 0x42,
}

/**
 * The first byte of register messages is an 8 bit unsigned integer.
 */
export enum RegisterState {
    /** [client] CSR -> server */
    M1 = 0x01,
    /** [server] signed certificate -> client */
    M2 = 0x02,
}

export enum RegisterStatus {
    SUCCESS = 0,
    UNKNOWN_ERROR = 1,
    NOT_ACCEPTING_REGISTRATIONS = 2,
    INVALID_CSR_DATA = 3,
}

export enum UnregisterStatus {
    SUCCESS = 0,
    UNAUTHORISED = 1,
    OTHER_CLIENT_CONNECTED = 2,
    SERVICES_CONNECTED = 3,
}

export enum RenewRegistrationStatus {
    SUCCESS = 0,
    UNKNOWN_ERROR = 1,
}

export enum RevokeCertificateStatus {
    SUCCESS = 0,
    UNAUTHORISED = 1,
    NO_OTHER_CERTIFICATES = 2,
}

export enum ListHostsHostnameType {
    SEPARATOR = 0x00,
    HOSTNAME = 0x01,
    DOMAIN = 0x02,
    STATUS = 0x03,
}

export enum ListHostsHostnameStatus {
    NOT_CONNECTED = 0,
    OTHER_CLIENT_CONNECTED = 1,
    CONNECTED = 2,
}

export enum AddHostStatus {
    SUCCESS = 0,
    INVALID_DOMAIN = 1,
    /** Hostname is currently registered */
    ALREADY_REGISTERED = 2,
    /** Hostname isn't registered, but was and can't be registered again */
    PREVIOUSLY_REGISTERED = 3,
    UNKNOWN_ERROR = 4,
}

export enum RemoveHostStatus {
    SUCCESS = 0,
    UNAUTHORISED = 1,
    CLIENT_CONNECTED = 2,
}

export enum ServiceType {
    HTTP = 0x0000,
    HTTPS = 0x0001,
    HTTP_HTTPS = 0x0002,
}

export enum ConnectServiceStatus {
    SUCCESS = 0,
    UNAUTHORISED = 1,
    UNSUPPORTED_SERVICE = 2,
    OTHER_CLIENT_CONNECTED = 3,
}

export enum DisconnectServiceStatus {
    SUCCESS = 0,
    WASNT_CONNECTED = 1,
}

export enum CloseConnectionStatus {
    CLOSED_BY_CLIENT = 0,
    CLOSED_BY_REMOTE_CLIENT = 1,
    ERROR = 2,
}

declare module 'is-tls-client-hello' {
    function isTLSClientHello(data: Buffer): boolean;

    export = isTLSClientHello;
}

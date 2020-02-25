declare module 'http-headers' {
    import * as http from 'http';

    interface DefinedHttpHeaders {
        'set-cookie': string[];

        'content-type': string;
        'content-length': string;
        'user-agent': string;
        'referer': string;
        'host': string;
        'authorization': string;
        'proxy-authorization': string;
        'if-modified-since': string;
        'if-unmodified-since': string;
        'from': string;
        'location': string;
        'max-forwards': string;
        'retry-after': string;
        'etag': string;
        'last-modified': string;
        'server': string;
        'age': string;
        'expires': string;
    }

    type HttpHeaders = DefinedHttpHeaders & {
        [header: string]: string;
    };

    interface HttpRequest {
        method: string;
        url: string;
        version: {
            major: number;
            minor: number;
        };
        headers: HttpHeaders;
    }

    interface HttpResponse {
        version: {
            major: number;
            minor: number;
        };
        statusCode: number;
        statusMessage: string;
        headers: HttpHeaders;
    }

    function parse(str: string | Buffer | http.ServerResponse, onlyHeaders: true): HttpHeaders;
    function parse(str: string | Buffer | http.ServerResponse, onlyHeaders?: boolean):
        HttpRequest | HttpResponse | HttpHeaders;
    
    namespace parse {
        export {
            DefinedHttpHeaders,
            HttpHeaders,
            HttpRequest,
            HttpResponse,
        };
    }

    export = parse;
}

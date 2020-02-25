declare module 'sni' {
    function extractSNI(data: Buffer): string | null;

    export = extractSNI;
}

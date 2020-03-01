try {
    require('./hap-server');
} catch (err) {
    console.error('Error loading @hap-server/remote-access as a hap-server plugin', err);
}

export default function (...args: any[]) {
    require('./homebridge').default(...args);
}

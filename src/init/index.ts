try {
    require('./init/hap-server');
} catch (err) {}

export default function (...args: any[]) {
    require('./init/homebridge').default(...args);
}

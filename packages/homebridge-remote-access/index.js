const {default: initHomebridgePlugin} = (() => {
    try {
        return require('@hap-server/remote-access/dist/init/homebridge');
    } catch (err) {
        try {
            if (require('../../package').name !== '@hap-server/remote-access') throw undefined;

            return require('../../dist/init/homebridge');
        } catch (err) {
            console.error('Failed to load @hap-server/remote-access');
        }
    }
})();

module.exports = function (...args) {
    initHomebridgePlugin(...args);
};

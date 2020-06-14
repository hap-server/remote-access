try {
    require('@hap-server/remote-access/dist/init/homebridge');
} catch (err) {
    console.error('Could not find the @hap-server/remote-access package');
    console.error('Make sure this is installed as well');
}

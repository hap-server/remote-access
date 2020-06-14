hap-server Remote Access
===

This repository contains:

- The tunnel server library,
- The plugin for hap-server and Homebridge Config UI to connect to the tunnel server and
- A command line program to register with the tunnel server.

See [docs/protocol.md](docs/protocol.md) for more information about the tunnel protocol.

### Installing with hap-server

```
npm install --global @hap-server/remote-access
```

### Installing with Homebridge

As Homebridge doesn't support loading scoped packages as plugins you need to install an additional package to load it.

```
npm install --global @hap-server/remote-access homebridge-remote-access
```

### Registration

> TODO

1. Create an account on the tunnel server

    You will be asked to enter an email address when registering. You may need to prove you have access to emails
    sent to this address.

    ```
    hapserver-tunnel-setup register > cert-key.pem
    ```

    <details><summary>If you are using a different tunnel server add it's address.</summary>

    ```
    hapserver-tunnel-setup register hapserver-tunnel.fancy.org.uk#pk=... > cert-key.pem
    ```

    </details>

    This will generate a CSR and wait for the server to generate a certificate. At this point the server may ask for
    additional verification (e.g. validating an email address).

    Once the server has generated a certificate it will be saved to `cert-key.pem` with the private key. Move this
    somewhere that hap-server/Homebridge will be able to read. The registration command will also generate a URL with
    the certificate.

    When configuring hap-server/Homebridge or registering a hostname you can use either:
    
    - A URL with `cert` and `key` parameters:

        ```
        hapserver-tunnel.fancy.org.uk#pk={hex encoded server record signing key}&cert={base64 encoded PEM encoded client certificate}&key={base64 encoded PEM encoded client private key}
        ```

    - Or, a URL with `cf` (and optional `pkf`) parameters:

        ```
        hapserver-tunnel.fancy.org.uk#pk={hex encoded server record signing key}&cf={path to PEM encoded client certificate and private key (cert-key.pem)}
        ```

2. Register a hostname

    Replace `$URL` with the URL from the previous command.

    ```
    hapserver-tunnel-setup "$URL" add-hostname example.hapserver-tunnel.fancy.org.uk
    ```

    hap-server or your Homebridge server will be accessible at https://example.hapserver-tunnel.fancy.org.uk
    once hap-server/Homebridge is configured.

    The domains you can use depends on the tunnel server you're using. To list the domains you can use run the `list-domains` command:

    ```
    hapserver-tunnel-setup "$URL" list-domains
    ```

### hap-server configuration

Add this to your configuration file with the tunnel server address and hostname from [registration](#registration).
The tunnel server address includes authentication data.

```yaml
plugins:
    @hap-server/remote-access:
        server: hapserver-tunnel.fancy.org.uk#pk=...&cf=.../path/to/cert-key.pem
        hostname: example.hapserver-tunnel.fancy.org.uk

        # All certbot options are optional except `certbot_agree_tos` which must be set to `true`
        # If `certbot` can't be found with the PATH environment variable `certbot_path` must be set
        # certbot_path: /usr/local/bin/certbot
        # certbot_data_path: /path/to/store/certbot/data
        # certbot_acme_server: https://acme-v02.api.letsencrypt.org/directory
        certbot_agree_tos: true
        # certbot_email_address: letsencrypt@example.com
```

### Homebridge configuration

Add this to your configuration file with the tunnel server address and hostname from [registration](#registration).
The tunnel server address includes authentication data.

Replace `8080` with the web interface port if you have changed this or aren't using Homebridge Config UI X.

```json
{
    "platforms": [
        {
            "platform": "remote-access.TunnelServiceConfiguration",
            "server": "hapserver-tunnel.fancy.org.uk#pk=...&cf=.../path/to/cert-key.pem",
            "hostname": "example.hapserver-tunnel.fancy.org.uk",
            "proxy": {
                "port": 8080
            },
            "certbot_agree_tos": true
        }
    ]
}
```

<details><summary>Optional: set Homebridge Config UI X to only accept connections from localhost/the tunnel
service</summary>

To prevent using Homebridge Config UI X without using the tunnel service set the `host` option to `::1`.

```json
{
    "platforms": [
        {
            "platform": "config",
            ...
            "host": "::1"
        }
    ]
}
```

</details>

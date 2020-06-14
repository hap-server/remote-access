Installing as a Homebridge plugin
---

1. Install the package globally

    ```
    npm install --global @hap-server/remote-access homebridge-remote-access
    ```

2. Create an account on the tunnel server

    You will be asked to enter an email address when registering. You may need to prove you have access to emails
    sent to this address.

    ```
    hapserver-tunnel-setup register > ~/.homebridge/tunnel-server-cert-key.pem

    # Keep a copy of `tunnel-server-cert-key.pem`
    cp ~/.homebridge/tunnel-server-cert-key.pem ~/Documents/tunnel-server-cert-`date`.pem
    ```

3. Register a hostname

    ```
    hapserver-tunnel-setup "hapserver-tunnel.fancy.org.uk#pk=...&cf=$HOME/.homebridge/tunnel-server-cert-key.pem" add-hostname example.hapserver-tunnel.fancy.org.uk
    ```

4. Configure Homebridge

    Add this to your configuration file with the tunnel server address and hostname from [registration](#registration).
    The tunnel server address includes authentication data.

    Replace `8080` with the web interface port if you have changed this or aren't using homebridge-config-ui-x.

    ```json
    {
        "platforms": [
            {
                "platform": "remote-access.TunnelServiceConfiguration",
                "server": "hapserver-tunnel.fancy.org.uk#pk=...&cf=.../path/to/your/home/directory/.homebridge/tunnel-server-cert-key.pem",
                "hostname": "example.hapserver-tunnel.fancy.org.uk",
                "proxy": {
                    "port": 8080
                },
                "certbot_agree_tos": true
            }
        ]
    }
    ```

    You can also use Homebridge Config UI X to add this to your config.json.

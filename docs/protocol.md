Tunneling Protocol
---

The tunneling protocol uses TLS for encryption and authentication and TLV messages.

The client library allows four connection methods:

- Connecting without encryption (using `ts` URLs like `ts://tunnel-server.example.com:9000`)
- Connecting without authentication (using `tss` URLs like `tss://tunnel-server.example.com:9000`)
- Connecting with encryption and authentication (using `tss` URLs like `tss://tunnel-server.example.com:9000#auth=...`)
- Connecting with DNS service discovery (using a URL without a protocol like `tunnel-service.example.com`
    or `tunnel-service.example.com#auth=...`)

### DNS service discovery

When no `ts`/`tss` protocol is specified in the server URL the client will lookup the hostname's SRV and TXT records.

These records will allow the client to resolve `tunnel-service.example.com` to
`tss://tunnel-server.example.com:9000#ca=[base64 encoded trusted server certificate authorities]`.

```zone
_hapserver-tunnel._tcp.tunnel-service.example.com. 10800 IN SRV     0 0 9000 tunnel-server.example.com.
                                    10800   IN  TXT     "hap-server/tunnel" "tls" "ca-url" "https://tunnel-service.example.com/tsca.pem" "[signature]"
```

If a `"hap-server/tunnel" "tls"` TXT record exists TLS will be used.

Once the client has resolved the server URL it will continue with the other connection method.

#### Signing DNS records

If the URL includes a `pk` parameter (`tunnel-service.example.com#pk=...`) it will be used to check the signature of
each DNS record.

In this record `[signature]` must be the hexidecimal ED25519 signature of
`tls\0ca-url\0[url]\0[certificate authority at the url]` for the
hexidecimal public key in the `pk` parameter.

```zone
_hapserver-tunnel._tcp.tunnel-service.example.com. 10800 IN TXT "hap-server/tunnel" "tls" "ca-url" "https://tunnel-service.example.com/tsca.pem" "[signature]"
```

#### DNS records with a single entry

For DNS servers that don't support more than a single entry in a TXT record you can use a single record with
entries separated with spaces.

```zone
_hapserver-tunnel._tcp.tunnel-service.example.com. 10800 IN TXT "hap-server/tunnel tls ca-url https://tunnel-service.example.com/tsca.pem [signature]"
```

### Connecting without encryption

The client creates a TCP connection to the tunnel server and sends/receives TLV messages.

> As TLS client certificates are used to authenticate clients it is not possible to connect to a tunnel server with
> authentication but without encryption.

Unencrypted connections should usually be rejected.

### Connecting without authentication

The client creates a TCP connection to the tunnel server, negotiates TLS and sends/receives TLV messages. No client
certificate is used when negotiating TLS.

### Connecting with encryption and authentication

The client creates a TCP connection to the tunnel server, negotiates TLS with a client certificate and sends/receives
TLV messages.

All messages except registration, list domains and list services messages should use this connection method.

### Data format

Once connected the client/server can send/receive messages. Each message has an 8 bit type, 32 bit length and variable
length data.

#### Message types

Name                                        | Type      | Type
--------------------------------------------|-----------|------
Protocol version                            | `0x00`    | `0`
Ping                                        | `0x01`    | `1`
Register                                    | `0x10`    | `16`
Unregister                                  | `0x11`    | `17`
Renew registration                          | `0x12`    | `18`
Revoke certificate                          | `0x13`    | `19`
List hosts                                  | `0x20`    | `32`
Add host                                    | `0x21`    | `33`
Remove host                                 | `0x22`    | `34`
List domains                                | `0x23`    | `35`
List services                               | `0x30`    | `48`
Connect service                             | `0x31`    | `49`
Disconnect service                          | `0x32`    | `50`
Connection                                  | `0x40`    | `64`
Close connection                            | `0x41`    | `65`
Message                                     | `0x42`    | `66`

<!-- ### Certificates

- Root CA generated for the tunnel server
    - Intermediate CA for server certificates
        - TLS server certificates
    - Intermediate CA for client certificates
        - TLS client certificate for each registered client

Only a single client should connect with the same certificate. If multiple clients connect with the same certificate
only one will be able to connect to services. -->

### Registration

To register with a tunnel server the client sends a `REGISTER` (`0x10`) message to the server with state `1` and
a certificate signing request.

1. Client generates a keypair and certificate signing request.
2. Client sends a register message to the server with the state `1` and the CSR.
3. Server validates the CSR and signs a certificate.
    - The server can reject the CSR by sending a register message to the client with the state `2` and an error code
        greater than `0`.
4. Server optionally logs the new registered client.
5. Server sends a register message to the client with the state `2`, error `0` and the signed certificate.
6. Client stores the signed certificate and keypair.

### Unregister

1. Client sends an unregister message to the server.
2. Server checks the client is not connected to any services, has no service connections and the client has no other
    connections to the server.
3. Server revokes all certificates for the client.
4. Server sends an unregister message to the client.
5. Server disconnects the client.

### Renew registration

The client can renew it registration by sending a `RENEW_REGISTRATION` (`0x12`) message to the server. As the
certificate is used to identify the client the server effectively revokes the old certificate and transfers all
details to the new certificate.

> TODO

### Revoke certificate

1. Client sends a revoke certificate message to the server with the SHA256 fingerprint of the certificate to revoke.
2. Server checks the client has another valid certificate that won't expire soon.
3. Server revokes the certificate.
4. Server disconnects all clients with that certificate.
5. Server sends a revoke certificate message to the client.

### List hosts

1. Client sends a list hosts message to the server.
2. Server sends a list hosts message to the client with a nested TLV containing all hostnames the client previously
    reserved and a status.

#### TLV format

Type                            | Value
--------------------------------|-------
Hostname (`0x01`)               | Reserved hostname not including the server's domain
Domain (`0x02`)                 | Domain of the reserved hostname (optional)
Status (`0x03`)                 | Status (`0` = no client connected, `1` = another client is connected to a service, `2` = this client is connected to a service)

For each additional hostname a separator is added, then another entry:

Type                            | Value
--------------------------------|-------
Separator (`0x00`)              | None
Hostname (`0x01`)               | Reserved hostname not including the server's domain
Domain (`0x02`)                 | Domain of the reserved hostname (optional)
Status (`0x03`)                 | Status (`0` = no client connected, `1` = another client is connected to a service, `2` = this client is connected to a service)

### Add host

To create a tunnel the client sends an `ADD_HOST` (`0x21`) message to the server with the hostname it would like
to reserve.

1. Client sends an add host message to the server with the hostname (including server domain) it would like to reserve.
2. Server validates the client can register the hostname (it offers hostnames under that domain and it isn't already
    registered).
    - The server can reject the hostname by sending an add host message to the client with an error code greater than
        `0`.
3. Server stores the hostname reservation.
4. Server sends an add host message to the client with the error `0`.

### Remove host

1. Client sends a remove host message to the server with the hostname (including server domain) it would like to
    remove.
2. Server validates the hostname was reserved by the client and that no clients are connected to services on this
    hostname.
3. Server deletes the hostname reservation (or revokes it).
4. Server sends a remove host message with the error `0`.

The server can decide whether hostnames previously registered by a client can be registered again by any client,
the same client or no clients.

### List domains

1. Client sends a list domains message to the server.
2. Server sends a list domains message to the client with all domains the client may register hostnames under. Each
    domain is prefixed by it's length in an unsigned 32 bit integer.

### Services

A tunnel server may support multiple services on a single hostname (for example, HTTP and HTTPS).

A service name is a 16 bit service type, a 32 bit service identifier and the hostname.

Service type name               | Type
--------------------------------|----------
HTTP                            | `0x0000`
TLS                             | `0x0001`
HTTP/TLS                        | `0x0002`

### Service connections

When a tunnel server receives a connection for a service it has a client connected to it sends a `CONNECTION`
(`0x40`) message to the client.

Offset  | Length    | Value
--------|-----------|-------
`0`     | `2`       | A 16 bit connection ID assigned by the server.
`2`     | `2`       | The length of the service name.
`4`     | Variable  | The service name.
`4` +   | `16`      | The server's IP address.
`20` +  | `2`       | The server's port.
`22` +  | `16`      | The remote client's IP address.
`38` +  | `2`       | The remote client's port.

When the remote client sends data the tunnel server sends a `MESSAGE` (`0x42`) message to the client with the 16 bit
connection ID and the data from the remote client.

The client sends data to the remote client by sending a `MESSAGE` (`0x42`) message to the tunnel server with the 16
bit connection ID and the data to send to the remote client.

When the remote client disconnects the tunnel server sends a `CLOSE_CONNECTION` (`0x41`) message to the client with
the 16 bit connection ID and a status code (`1` if the remote client closed the connection).

The client can disconnect the remote client by sending a `CLOSE_CONNECTION` (`0x41`) message to the tunnel server
with the 16 bit connection ID. The tunnel server will send a connection closed message to the client with status
code `0`.

### List services

The client can request a list of services the server offers by sending a `LIST_SERVICES` (`0x30`) message.

1. Client sends a list services message to the server, optionally with a hostname.
2. Server sends a list services message to the client with 16 bit service types and 32 bit service identifiers
    joined with no separator. If the client didn't include a hostname the server should list all services. If the
    client included a hostname the server should only list services it supports for that hostname.

### Connecting to services

Before any messages are sent through the tunnel the client must ask the server to connect the tunnel to the service
to tunnel.

1. Client sends a connect service message to the server with the name of the service it would like to receive
    connections to.
2. Server validates the client should be able to connect to that service and that the another client with the same
    identity isn't already connected to the service.
3. Server sends a connect service message to the client with the error `0`.
4. Server begins sending `CONNECTION` (`0x40`) messages to the client for that service.

### Disconnecting from services

1. Client sends a disconnect service message to the server with the name of the service it would like to stop
    receiving connections to.
2. Server validates the client is connected to that service.
3. Server stops tunneling that service and destroys all connections.
4. Server sends a disconnect service message to the client with the error `0`.

When a client disconnects from a service (or the client disconnects from the tunnel server entirely) all connections
to that service must be destroyed.

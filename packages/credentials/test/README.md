# test

`grants.test.ts`: each profile's grants, replayed against the gateway's rules — the Internet
opens no host with a credential —, their composition on one host (write on one repo, read on
another), refused profiles, and the JWT checked with Agora's public key, bound to the Pod's
address.
`limits.test.ts`: each provider's answer read into windows, the `limits` grant and the catalogue that
refuses it, the reads kept and their failures, `GET /api/limits`, and a real GET through a stand-in
gateway — CONNECT, then TLS with a certificate `openssl` makes for the test.

`npm test -w @agora/credentials`

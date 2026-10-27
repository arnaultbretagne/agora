# test

`grants.test.ts`: each profile's grants, replayed against the gateway's rules — the Internet
opens no route with a credential, and reads GitHub only as the public does —, their composition
on one host (write on one repo, read on another), `previews` and its host pattern (C55), refused
profiles, and the JWT checked with Agora's public key, bound to the Pod's address.
`previews-gateway.test.ts`: the previews through the real gateway and their real gate — agentgateway
1.6.0 and oauth2-proxy 7.15.5, their release binaries checked against their sha256 and kept in the
temporary directory —, the gateway on `fixtures/previews-gateway.yaml`, the gateway gate as the spec
configures it, the browser gate as infra-k8s's template does, a stand-in issuer and app (C56–C60). It
needs `openssl`, `tar` and linux-amd64, and downloads the binaries once.
`limits.test.ts`: each provider's answer read into windows, the `limits` grant and the catalogue that
refuses it, the reads kept and their failures, `GET /api/limits`, and a real GET through a stand-in
gateway — CONNECT, then TLS with a certificate `openssl` makes for the test.

`npm test -w @agora/credentials`

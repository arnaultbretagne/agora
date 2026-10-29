# An execution's credentials

Contract to implement — agentgateway **1.6.0**, on top of the executions contract
(`executions.md`). How it fits together is explained in `architecture/credentials.md`; why, in
the gateway ADR.

**The sandbox holds no secret. It goes out through the gateway, which checks each request
against the execution's grants and sets the credential on the way through.**

## A request's path

| Step | Who | What |
| --- | --- | --- |
| 1 | Adapter → bridge | `CONNECT api.github.com:443` on `127.0.0.1`. |
| 2 | Bridge → gateway | The same `CONNECT` to `gateway.agora-gateway.svc.cluster.local:3000`, with `Proxy-Authorization: Bearer` and the JWT. The response goes back to the adapter as is. |
| 3 | Gateway | Answers 200, then terminates TLS with a certificate signed by "Agora gateway CA". |
| 4 | Adapter | Trusts that authority — through `NODE_EXTRA_CA_CERTS`, or `GIT_SSL_CAINFO` for git — and sends its request. |
| 5 | Gateway | Checks the JWT and the grants. Sets the host's credential in place of the `Authorization` it received, keeps the other headers, forwards to the host. |

| Response | Meaning |
| --- | --- |
| 503 from the bridge, on `CONNECT` | No token attached: a warm Pod whose pool declares no base profile, or before Agora hands one. |
| 502 from the bridge, on `CONNECT` | Gateway unreachable. |
| 401 from the gateway | JWT missing, expired or signed by another key. |
| 403 from the gateway | None of the execution's grants covers this host, path and method. A host with no route of its own falls to the `internet` route: refused without `internet`. On GitHub, what no grant covers falls to its public routes: refused without `internet`, and refused for anything but a read. |
| 404 from the gateway, on `CONNECT` | A port other than 443: the gateway serves HTTPS on 443 only. |
| 503 from the gateway | The host cannot be reached: its name does not resolve, or the connection fails or times out — as it does for a private address, which the network keeps out of the gateway's reach. |
| TLS refused by the gateway (`access denied`) | An IP address instead of a name: the gateway issues certificates for names only. |

## The bridge

| Element | Rule |
| --- | --- |
| `PUT /credentials` | With Agora's token. The body gives the proxy (`host:port`), the token and its expiry. Replaces the previous token and closes the tunnels opened with it: later tunnels use the new one. |
| `GET /info`, `outbound` field | Proxy, expiry, when the credential was attached, number of tunnels, number of refusals, and for each target the number of tunnels and the last response to the `CONNECT`. Never the token. |
| Adapter's environment | `HTTPS_PROXY` and `https_proxy` set to `http://127.0.0.1:<port>`, `NO_PROXY` set to `localhost,127.0.0.1`, `NODE_USE_ENV_PROXY` set to `1` so that Node's own `fetch` goes through it too, `KUBECONFIG` set to the bridge's kubeconfig ("Kubernetes"). Everything the agent runs inherits it. |
| The agent's access | At each `PUT /credentials`, before answering: the token's claims — its payload as JSON, never the token or its signature — written to `~/.agora/access.json`, replacing the previous ones as a whole, in the order the tokens came. A token whose claims cannot be read removes the file. |
| What is relayed | `CONNECT` only. An `http://` request is refused (501): the gateway serves HTTPS only. |

## Profiles and grants

An execution receives a list of **profiles**. Agora compiles them into **grants**: a host, a
regular expression anchored on the path and query, methods, and for an MCP server the tools a call
may name; for many hosts, a regular expression on the host. The catalogue lives in Agora's code
(`packages/credentials`).

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything. |
| `zai` | `api.z.ai`, everything: z.ai's OpenAI- and Anthropic-compatible APIs. |
| `chatgpt` | `chatgpt.com`, only `/backend-api/codex…` and `/backend-api/wham…`: what codex uses. The session reaches the whole ChatGPT account, conversations included. |
| `internet` | `*`, everything: any host with no route of its own, with no credential set. Public addresses, HTTPS on port 443. On GitHub, what no `github` profile covers, read only: the public routes below. |
| `github:owner/repo:read` | REST API `/repos/owner/repo…` with `GET` and `HEAD`; git `git-upload-pack` only (a clone also sends a `POST`). |
| `github:owner/repo:write` | REST API `/repos/owner/repo…`, all methods; git `git-upload-pack` and `git-receive-pack`. |
| `vault:read` | `vault.bretagne.dev`, `/mcp` exactly, `GET`, `POST` and `DELETE`; `tools`: `read_note`, `search_content`, `search_properties`, `get_backlinks`, `list_properties`, `get_property_values`. No prompt, no resource. |
| `vault:write` | The same host, path and methods, no `tools`: the whole server — its twelve tools, the six of `vault:read` and `create_note`, `update_note`, `delete_note`, `move_note`, `update_schema`, `clip_url` — and its prompt `clip-to-vault`. |
| `kubernetes:read` | `kubernetes.agora.internal`, `GET` and `HEAD` on the API's paths: `/api`, `/apis`, `/openapi`, `/version` and what lies under them, any query. A watch is a `GET`: covered. What may be read is the credential's RBAC ("Kubernetes"). |
| `previews` | The hosts `pr-<n>-<app>.preview.bretagne.dev` — one DNS label, `<n>` a pull request's number, `<app>` lowercase letters, digits and dashes —, every path and every method. Through the preview's gateway gate ("Previews"). |

Grants are additive. GraphQL (`/graphql`) is covered by no profile.

A grant's `tools` lists the MCP tools a call may name. On an MCP server every message is a `POST` to
the same path, so host, path and method cannot tell a read from a write: only a route whose backend
is an MCP server reads `tools`, in the protocol itself ("The vault"). There, a grant without `tools`
opens everything the server offers — tools, prompts, resources — and a grant with `tools` opens
those tools and nothing else. In the JWT it is a list of names beside `host`, `path` and
`methods`, for instance `{"host": "vault.bretagne.dev", "path": "^/mcp$", "methods": ["GET", "POST",
"DELETE"], "tools": ["read_note", …]}`. Only `vault:read` carries it.

| Vault tool | Level | What it does |
| --- | --- | --- |
| `read_note`, `search_content`, `search_properties`, `get_backlinks`, `list_properties`, `get_property_values` | read | Read notes, their properties, links and the schema. |
| `create_note`, `update_note`, `delete_note`, `move_note` | write | Change notes. |
| `update_schema` | write | Writes the schema overlay, `.obsidian/mcp-schema.json`. |
| `clip_url` | write | Fetches a page through the clipper and writes it into the vault as a note. |
| Prompt `clip-to-vault` | write | Leads to `clip_url`. |

The server (obsidian-mcp 0.4.0) offers no resource. A tool it adds is closed to `vault:read` until
the catalogue names it, and open to `vault:write`, which is the whole server.

A grant on many hosts keeps a `host`, the wildcard of the route that serves them, which no request's
host equals: the rule of every other route compares `host` with the request's, so none covers it. Its
`hostPattern`, a regular expression anchored on the request's host, is read only by that route, behind
`has(g.hostPattern)`: a grant without one never makes that rule fail. Only `previews` has one.

`internet` never opens a route with a credential: those routes compare the grant's host with the
request's, and only the `internet` route and GitHub's public routes read `*`. On GitHub it adds what
anyone may read: a public repository outside the execution's `github` profiles can be cloned,
fetched and read through the REST API. Never a write, a push or GraphQL: those take a `github`
profile.

### Base profiles

What a harness needs before any execution — its SDK initializing, for instance — is declared on
its pool, the `SandboxWarmPool`, in the annotation `agora.bretagne.dev/base-profiles`: profiles
separated by commas. Only profiles the catalogue marks as base may be declared: those naming a
service — never a repository, nor `internet`, nor the vault.

| Profile | Base |
| --- | --- |
| `anthropic` | Yes |
| `zai` | Yes |
| `chatgpt` | Yes |
| `internet` | No |
| `github:…` | No |
| `vault:read`, `vault:write` | No |
| `kubernetes:read` | No |
| `previews` | No |

A pool without the annotation, or declaring a profile that is not a base one, gets no warm token;
the catalogue (`GET /api/pools`) shows its base profiles, or the refused one.

### Offered profiles

What an execution may be given beyond its pool's base profiles is declared on Agora, in
`OFFERED_PROFILES`: profiles separated by commas, each at the widest access it may be given. The
interface offers these (`assistant-ui.md`, "Access"); a Create or a Scope may name an offered
profile, or a narrower one of the same repository or of the vault.

| Offered | May be named |
| --- | --- |
| `github:owner/repo:write` | `github:owner/repo:write`, `github:owner/repo:read` |
| `github:owner/repo:read` | `github:owner/repo:read` |
| `vault:write` | `vault:write`, `vault:read` |
| `vault:read` | `vault:read` |
| `anthropic`, `zai`, `chatgpt`, `internet`, `kubernetes:read`, `previews` | Itself |

The vault's levels follow GitHub's: `vault:read` opens a subset of what `vault:write` opens — six of its
tools, on the same host, path and methods — so an operator offering write has accepted every read,
and the user may pick the narrower one. Anything else is refused (`profile_not_offered`). Without the variable, any profile of the
catalogue may be named, and the interface offers none. A profile the catalogue does not know stops
the server at start.

### MCP servers

A profile may open an MCP server: the execution's `session/new` names it, and the harness reaches it
through the gateway like any host. The catalogue holds them beside the profiles.

| Element | Rule |
| --- | --- |
| `mcpServers` | In `session/new`, and in `session/load` or `session/resume` when a Session is restored: the servers the execution's profiles — its pool's base profiles and its own — open, each once. `[]` when none does. |
| The vault | With `vault:read` or `vault:write`, or both: one server, `{ "type": "http", "name": "vault", "url": "https://vault.bretagne.dev/mcp", "headers": [] }`. |
| Headers | None. The gateway sets the server's credential; nothing in `mcpServers` is a secret, and it is written in the log. |
| A Scope | Changes the token, never the Session's servers, fixed when it opens. A Session opened without the vault does not get it; one opened with it and scoped out of it keeps the server, refused by the gateway (403). |

## The token

An EdDSA JWT signed by Agora's key (Secret `grants-key`), `kid` `agora-grants-1`.

| Claim | Content |
| --- | --- |
| `iss`, `aud` | `agora`, `agora-gateway`: required by the gateway. |
| `sub` | The execution (`agora <execution>`), or the warm Pod (`agora warm <sandbox>`); written in every log line. |
| `exp` | A warm token: 15 minutes. An execution's: the turn's maximum duration plus the lease, from when it is handed over. Between 60 s and 24 h. |
| `jti` | One id per token. |
| `ip` | The Pod's address, from its Sandbox (`status.podIPs`), never from the Pod. The gateway takes the token only from there. |
| `grants` | The compiled grants. |
| `profiles` | The requested profiles, for the record. |

The gateway reads it from the `Proxy-Authorization` of the `CONNECT`, which every request in the
tunnel sees (`source.connectHeaders`), and checks it with the JWKS from the `grants-jwks`
ConfigMap.

The token is not a secret from the agent: the agent runs under the bridge's user and can read
the bridge's memory. What keeps a token from serving anywhere else is `ip`: the gateway compares
it with the address the request comes from (`source.address`), which the network vouches for —
a Pod cannot send from another Pod's address. A secret kept in the Pod would not do: whatever
the bridge holds, the agent can read. No token is signed without the Pod's address.

## The gateway

agentgateway in standalone mode, namespace `agora-gateway`, Service `gateway` port 3000
(`CONNECT`). Every tunnel to port 443 is terminated with the "Agora gateway CA" CA.

The listener verifies the JWT before any route is picked. The routes with a credential share one
authorization rule: the request comes from the JWT's `ip`, the path contains no `..`, `.`, `%2e` or
`%2f`, and one of the JWT's grants covers the host, the path with the query, and the method. If the
rule fails, the request stops at the gateway; otherwise the gateway sets the host's credential.

GitHub has two routes per host: one for what a grant covers, one for the rest. On `api.github.com`
and `github.com`, the listener sets `x-gateway-grant` before a route is picked — `covered` when the
rule above would let the request through, `none` otherwise — overwriting whatever the sandbox sent.
`github-api` and `github-git` take `covered`: a route with a header match outranks the one without.
`github-api-public` and `github-git-public` take the rest. The header only steers: each route checks
the request again, so a header the sandbox sets itself gains nothing, and each removes it before
GitHub.

The public routes' rule: the request comes from the JWT's `ip`, its path has none of the tricks
above, one of the JWT's grants is on host `*`, and the request reads. On `api.github.com`, `GET` and
`HEAD`. On `github.com`, `GET` and `HEAD` except `git-receive-pack`'s first request, and the `POST`
of `git-upload-pack` that a clone or a fetch sends. They set the same PAT as the routes with a
grant: a fine-grained PAT reads every public repository, so a repository given no grant reads as the
public sees it, with the PAT's rate limit. GraphQL stays closed: it is always a `POST`, read or
write.

The `internet` route names no host. agentgateway picks a route by the request's exact host, then
by wildcard, and the route without hosts last: it takes every host the other routes do not name.
Its rule: the request comes from the JWT's `ip`, and one of the JWT's grants is on host `*` and
covers the path with the query, and the method. It sets no credential: the request leaves as the sandbox sent it.

| Route | Host | Credential set |
| --- | --- | --- |
| `anthropic-usage` | `api.anthropic.com`, `GET /api/oauth/usage` only | `Authorization: Bearer` + the access token of the cluster's own Claude login. Its exact path outranks `anthropic`. |
| `anthropic` | `api.anthropic.com` | `Authorization: Bearer` + the operator's Claude setup-token. |
| `zai` | `api.z.ai` | `Authorization: Bearer` + the operator's z.ai API key. |
| `chatgpt` | `chatgpt.com` | `Authorization: Bearer` + the access token of the cluster's own ChatGPT session; the sandbox's `chatgpt-account-id` removed. |
| `github-api` | `api.github.com`, `x-gateway-grant: covered` | `Authorization: Bearer` + the GitHub PAT. |
| `github-git` | `github.com`, `x-gateway-grant: covered` | `Authorization: Basic` + `x-access-token:` and the PAT, in base64. |
| `github-api-public` | `api.github.com`, the rest; reads, with `internet` | As `github-api`. |
| `github-git-public` | `github.com`, the rest; clone and fetch, with `internet` | As `github-git`. |
| `vault` | `vault.bretagne.dev`; an MCP backend, the tools the grants name ("The vault") | `Authorization: Bearer` + an access token of the Pocket-ID machine client `agora_gateway_vault`. |
| `kubernetes` | `kubernetes.agora.internal`, to the cluster's API server ("Kubernetes") | `Authorization: Bearer` + the token of the gateway's own ServiceAccount, projected, read only by its RBAC. |
| `previews` | `*.preview.bretagne.dev`, the hosts a grant's `hostPattern` covers ("Previews") | `Authorization: Bearer` + a token of the Pocket-ID client `agora_gateway_previews`; `x-agora-gate: gateway`. |
| `internet` | Any other | None. |

The PAT must reach every repository offered, with the access offered: the grants only narrow it. It
must reach no private repository: through the public routes, an execution with `internet` reads
whatever the PAT reads. A private repository to offer calls for a second credential on the public
routes, one that reads public repositories only.

### Kubernetes

`kubernetes:read` lets an execution read the cluster with kubectl. The sandbox holds no token and no
client certificate: the gateway sets its own ServiceAccount's token, and that token's RBAC is what may
be read. The grant cuts the methods to `GET` and `HEAD`; RBAC bounds the rest — the credential bounds,
the grants cut.

**The host.** `kubernetes.agora.internal`: `.internal` is reserved for private use and resolves
nowhere, and only the gateway's `kubernetes` route knows the name. The sandbox never resolves it:
kubectl sends `CONNECT kubernetes.agora.internal:443` to the bridge. Until the route exists, the name
falls to the `internet` route: 403 without `internet`; with it, a name that does not resolve, 503.

| Element | The `kubernetes` route |
| --- | --- |
| Host | `hostnames: [kubernetes.agora.internal]`, on the internal bind's HTTPS listener with the other routes. |
| Backend | `host: kubernetes.default.svc.cluster.local:443`, the API server's Service. `backendTLS`: `root` the cluster's CA — `ca.crt` of the ConfigMap `kube-root-ca.crt` that every namespace has, mounted in the gateway —, `hostname: kubernetes.default.svc`, a name the API server's certificate carries. |
| Rule | `authorization`: the rule of every route with a credential, unchanged — from the JWT's `ip`, no path tricks, a grant covering host, path with query, and method. |
| Credential | `backendAuth.key`: `Authorization: Bearer` + the file `/etc/agentgateway/kubernetes/token`, watched; whatever `Authorization` kubectl sent is replaced. |
| Identity | The gateway's own ServiceAccount, `gateway` in `agora-gateway`, named by its Deployment (`serviceAccountName`), `automountServiceAccountToken` still `false`. Its token comes from a projected volume (`serviceAccountToken`, `expirationSeconds: 3600`, the API server's own audience) mounted at `/etc/agentgateway/kubernetes`: the kubelet renews the file before it expires, and the gateway reads it again, as it does the Secrets' files. No refresher, no token in git. |
| Network | The gateway's policy: egress to the API server (Cilium's `kube-apiserver` entity), on the port it listens on behind the Service — 6443 on k0s. Nothing else of the cluster. |

**The RBAC the token carries.** One ClusterRole, `agora-kubernetes-read`, bound to that ServiceAccount
by the ClusterRoleBinding of the same name. Its verbs are `get`, `list` and `watch`, written out, in
every rule; its resources and API groups are named one by one.

| API group | Resources |
| --- | --- |
| `""` | `pods`, `pods/log`, `pods/status`, `services`, `endpoints`, `events`, `namespaces`, `nodes`, `configmaps`, `serviceaccounts`, `persistentvolumes`, `persistentvolumeclaims`, `replicationcontrollers`, `resourcequotas`, `limitranges` |
| `apps` | `deployments`, `replicasets`, `statefulsets`, `daemonsets`, `controllerrevisions` |
| `batch` | `jobs`, `cronjobs` |
| `networking.k8s.io`, `discovery.k8s.io`, `policy`, `autoscaling` | `ingresses`, `networkpolicies`; `endpointslices`; `poddisruptionbudgets`; `horizontalpodautoscalers` |
| `events.k8s.io`, `storage.k8s.io`, `apiextensions.k8s.io`, `metrics.k8s.io` | `events`; `storageclasses`; `customresourcedefinitions`; `pods`, `nodes` |
| The cluster's own custom resources | Each by its group and plural, as infra-k8s lists them; none whose objects hold a credential. |

| Never | Why |
| --- | --- |
| `*` in `verbs`, `resources` or `apiGroups` | A wildcard would take in what the cluster adds, Secrets included. |
| Any verb but `get`, `list`, `watch` — `create`, `update`, `patch`, `delete`, `deletecollection`, `impersonate`, `bind`, `escalate` | Read only. Without `impersonate`, kubectl's `--as` is refused. |
| `secrets` | The cluster's credentials. |
| `pods/exec`, `pods/attach`, `pods/portforward` | kubectl may run them over WebSocket, whose handshake is a `GET`, which the grant lets through: RBAC refuses them, `pods` never standing for its subresources. |
| `pods/proxy`, `services/proxy`, `nodes/proxy` | A way into the Pods, and through `nodes/proxy` into the kubelet, which runs commands. |
| `serviceaccounts/token`, `pods/ephemeralcontainers` | A token minted, a container added. |

A ConfigMap and a Pod's log are readable: neither may hold a credential. `kubectl auth can-i` and
`kubectl auth whoami` are `POST`s: refused by the gateway, like every write.

**The API server is the gateway's one private destination.** Its egress rule cannot tell routes
apart: the `internet` route reaches the API server too, through any name that resolves to its
Service's address, a public name included — the gateway dials port 443 only, which the Service
translates. Such a request carries no credential, the `internet` route setting none: the API server
takes it as anonymous. So the API server must answer an anonymous request only with what it gives
anyone — `/version`, `/healthz`, `/livez`, `/readyz`, the `system:public-info-viewer` defaults — or
refuse it; nothing bound to `system:anonymous` or `system:unauthenticated` beyond them.

**kubectl in the sandbox.**

| Element | Rule |
| --- | --- |
| The binary | kubectl 1.36.5, within one minor of the cluster's (k0s 1.36), in the claude-code, codex and opencode images: the release binary, checked against its sha256 at the build, which runs `kubectl version --client`. Not in the mock's. |
| Its configuration | `KUBECONFIG`, set by the bridge in the adapter's environment, names `kubeconfig.yaml`, shipped with the bridge (`packages/harness-bridge/src`), which every image copies — not `~/.kube/config`: `HOME` is a `tmpfs` in the cluster. One cluster, `server: https://kubernetes.agora.internal`, `certificate-authority: /etc/agora/credential-proxy/ca.pem`; one user, `username: agora`; one context, current. |
| No credential | No token, no client certificate, no password, no `exec` or `auth-provider`. The user name is there only because kubectl asks for credentials on stdin for a user it cannot identify (client-go 1.36.5, `canIdentifyUser`): kubectl then sends `Authorization: Basic` of `agora:`, which the gateway replaces. |
| The way out | No `proxy-url`: client-go then takes `HTTPS_PROXY` (`http.ProxyFromEnvironment`, read in client-go 1.36.5, `transport/cache.go`), the bridge's outbound proxy, which adds the token to the `CONNECT`. |
| The root | The gateway's alone: client-go builds its pool from `certificate-authority` only, without the system's roots (`transport/transport.go`, `rootCertPool`). |

### Previews

A preview (infra-k8s ADR 0017 v4, §7) is served at `pr-<n>-<app>.preview.bretagne.dev`, behind a gate
in `preview-system`: oauth2-proxy, which lets an `admin` through with a browser session. `previews`
lets an execution — the flows' judge — reach a preview with no browser and no credential in the
sandbox: the gateway presents an identity of its own to a second gate beside the browser's, which
takes that identity and no other.

| Grant | Value |
| --- | --- |
| `host` | `*.preview.bretagne.dev` |
| `hostPattern` | `^pr-[1-9][0-9]*-[a-z0-9]([a-z0-9-]*[a-z0-9])?\.preview\.bretagne\.dev$` |
| `path`, `methods` | None: every path, every method — a preview is the change running, to be exercised. |

Not covered, among others: `preview.bretagne.dev`, `x.preview.bretagne.dev`, `a.b.preview.bretagne.dev`,
`pr-42-rss.x.preview.bretagne.dev`, `x.bretagne.dev`, `preview.bretagne.dev.evil.com`, an upper-case
name, a port.

| Element | The `previews` route |
| --- | --- |
| Host | `hostnames: ["*.preview.bretagne.dev"]`, on the internal bind's HTTPS listener with the other routes. |
| Backend | `dynamic`, `backendTLS: {}`: the preview's public name, as a browser reaches it — Traefik, the wildcard certificate. The gateway already reaches the operator's sites so (from a sandbox through `internet`, 2026-10-27: `vault.bretagne.dev/health` 200, a preview's name answered). |
| Rule | `authorization`: `jwt.ip == source.address && !request.pathAndQuery.matches("(?i)(/[.][.]?(/\|[?]\|$)\|%2e\|%2f)") && jwt.grants.exists(g, has(g.hostPattern) && request.host.matches(g.hostPattern) && (!has(g.path) \|\| request.pathAndQuery.matches(g.path)) && (!has(g.methods) \|\| request.method in g.methods))`. A name the pattern refuses is never sent with the credential: 403 without `internet` (C57). |
| Marker | `requestHeaderModifier`: `set` `x-agora-gate: gateway`, overwriting what the sandbox sent. |
| Credential | `backendAuth.key`: `Authorization: Bearer` + the file `/etc/agentgateway/previews/access_token`, watched; whatever `Authorization` the sandbox sent is replaced. |

**The identity.** A Pocket-ID OIDC client of its own, `agora_gateway_previews`, declared in the
reconciler's `spec.json`: confidential, no callback URL, `isGroupRestricted: true` with no allowed group,
`accessTokenDurationMinutes: 15`. A token is asked by client credentials, without `resource`. As read in
Pocket-ID 2.18.0: its `sub` is `client-<its id>` (`oidc/token_handler.go`), its `aud` the client's id —
a request without a resource is audienced to the client (`oidc/api_resource.go`, `resolveResource`) —,
and it carries no `groups` and no identity scope.

| What else it can obtain (read in Pocket-ID 2.18.0) | |
| --- | --- |
| Grant types | A confidential client has `authorization_code`, `refresh_token`, `device_code` and `client_credentials` (`oidc/client.go`, `GetGrantTypes`). |
| `authorization_code` | Nothing: with no callback URL, no redirect URI matches — neither in fosite (`MatchRedirectURIWithClientRedirectURIs`, pocket-id/fosite 1.3.0) nor in Pocket-ID's own list (`oidc/provider.go`, `matchRedirectURI`). |
| `device_code`, `refresh_token` | Nothing: both are bound to a user, whom every token request checks again against the client's group restriction (`oidc/token_handler.go`, `ValidateUserAccess`; `oidc/authorization_service.go`, `IsUserGroupAllowedToAuthorize`); restricted with no allowed group, no user passes. |
| `client_credentials` | Its own token, as above, without identity scopes (`token_handler.go` drops them). With a `resource`, only an API registered and granted to the client; otherwise `invalid_target` or `access_denied` (`api_resource.go`). None is to be granted to it. |
| Where it is accepted | Only by the previews' gateway gates, which name its id as their audience and `client-<its id>` as their one identity. The browser gate's settings take no bearer token (C58); no other application is to name it. |

**The gateway gate.** Per preview, beside the browser gate and in `preview-system` like it, a second
oauth2-proxy of the same version, on its own port. The preview's HTTPRoute sends the requests carrying
`x-agora-gate: gateway` to it, every other request to the browser gate as today.

| Setting | Value |
| --- | --- |
| `provider`, `oidc-issuer-url` | `oidc`, `https://id.bretagne.dev`. |
| `client-id` | `agora_gateway_previews`'s id: the audience a bearer token must carry. `client-secret` `unused`: oauth2-proxy requires one for `oidc` (`pkg/validation/providers.go`), the gate never redeems a code, and it holds no secret of that client. |
| `skip-jwt-bearer-tokens`, `bearer-token-login-fallback` | `true`, `false`: a bearer token checked against Pocket-ID's keys — issuer, audience, expiry — is the session; an invalid one is refused, 403. |
| `oidc-email-claim`, `authenticated-emails-file` | `sub`, and a file naming `client-<its id>` alone: the session's identity is the token's `sub` (`providers/oidc.go`, `CreateSessionFromToken`), which must be in that file. No `email-domain`, no `allowed-group`. The file is the ConfigMap `preview-gateway-identities`, in `preview-system`. |
| `pass-basic-auth`, `basic-auth-password` | `true`, `none`: oauth2-proxy then replaces the `Authorization` it received by its own (`pkg/apis/options/legacy_options.go`: the header is stripped only when it injects one). |
| `api-route` | `^/`: no sign-in page; a request without a valid token gets 401 or 403. |
| `upstream`, `proxy-prefix`, `redirect-url`, `cookie-secret`, `reverse-proxy` | As the browser gate's. |

Nothing reaches a `pv-*` namespace: the ConfigMap and the cookie secret stay in `preview-system`, the
client's secret in `agora-gateway`.

| What the app receives | |
| --- | --- |
| `X-Forwarded-User`, `X-Forwarded-Email` | `client-<its id>`, from the gate. |
| `Authorization` | `Basic` of `client-<its id>:none`: the gate's, never the gateway's token nor the sandbox's (C56). |
| `x-agora-gate` | `gateway`. |
| The request | Its method, path, query and body as the sandbox sent them; what the sandbox sent as `X-Forwarded-User` is not passed on (C56). |

**Its secret.** Pocket-ID 2.18.0 keeps up to 20 secrets per client, each with an optional expiry, and
takes any of them that has not expired (`model/oidc.go`, `ActiveSecrets`; `oidc/client.go`,
`GetHashedSecret` and `GetRotatedHashes`). Creating one (`POST /api/oidc/clients/{id}/secrets`) adds it
and removes none (`service/oidc_service.go`, `CreateClientSecret`); only `DELETE
/api/oidc/clients/{id}/secrets/{secretId}` removes one (`DeleteClientSecret`). The client is read from the
database at each token request (`oidc/store.go`, `GetClient`): a change to its secrets, or its deletion,
counts from the next request. The client has one secret, the Pocket-ID reconciler's (`"secret"` in the
spec): it mints it into the Secret `previews-client` of `agora-gateway`, which `previews-refresher` alone
mounts, and deletes every other secret of the client. Nobody holds it.

| Rotating the secret | |
| --- | --- |
| 1 | Empty `previews-client`, or delete it: Flux recreates it empty. |
| 2 | The reconciler's next run, within 15 minutes, mints a new secret and writes it there; the refresher uses it from its next run. |
| 3 | The same run deletes the old secret. From the next token request, one with the old secret is refused; tokens it already minted stay valid until they expire, 15 minutes at most. |

**Keeping the token.** `previews-refresher`, a CronJob in `agora-gateway`: every 5 minutes, a
client-credentials request to Pocket-ID, without `resource`, with the client's secret from
`previews-client`, which it alone mounts; it writes `access_token` into the Secret `previews-session`,
mounted optional on the gateway at `/etc/agentgateway/previews`. A new token never breaks a request
under way: the gateway sets the header when it sends a request, the gate checks the token once, when
the request arrives (`pkg/middleware/jwt_session.go`), and a response under way goes on past the change (C60). The token it replaces stays valid until it expires.

**Revocation.** A gate checks a token offline, against Pocket-ID's keys, its audience and its expiry
(`providers/oidc.go`, `CreateSessionFromToken`): nothing done in Pocket-ID reaches a token already issued.
Only the gates' identities cut those.

| Operation | What it cuts | When |
| --- | --- | --- |
| `client-<its id>` taken out of `preview-gateway-identities` | Every token of the client, at every gateway gate, whatever secret minted it: each carries that `sub`, and no other identity is named. | Once the kubelet has updated the mounted ConfigMap — its sync, not measured for this ConfigMap —, oauth2-proxy reloads the file (`pkg/watcher/watcher.go`): 2 to 5 ms after a swap as the kubelet makes it (C59). |
| A secret deleted (`DELETE /api/oidc/clients/{id}/secrets/{secretId}`) | Every new token asked with that secret. | From the next token request. Tokens it already minted: valid at the gates until they expire, 15 minutes at most, unless the identity is taken out too. |
| The client deleted (`DELETE /api/oidc/clients/{id}`) | Every new token of the client, whatever the secret. | From the next token request. Tokens already issued: as above. |
| `previews` taken out of `OFFERED_PROFILES` | No new execution is given it. | Tokens already handed expire with them. |

A secret leaked: take the identity out of the gates, which cuts every token, then delete that secret —
or the client —, which stops new ones; creating a new secret alone cuts nothing.

**The browser path is unchanged**: the browser gate's configuration and the HTTPRoute's rule for it
stay as they are, and a browser never sends `x-agora-gate`. One that sends it reaches the gateway gate,
which refuses it without the client's token.

The `internet` route can name any host, so the network bounds it: the gateway goes out to public
IPv4 addresses only, on port 443. The private ranges — `10.0.0.0/8`, `100.64.0.0/10`,
`169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16` — hold the operator's networks and the
cluster: a name resolving there times out (503); an address written as such is refused at TLS.

### The vault

The Obsidian vault's MCP server — obsidian-mcp 0.4.0, namespace `obsidian`, Service `obsidian-mcp`
port 4000, path `/mcp`, Streamable HTTP with sessions (`mcp-session-id`) — is its own OAuth resource
server. It takes a Pocket-ID JWT whose `aud` is in `MCP_ALLOWED_AUDIENCE`, and refuses a token
presenting a client identity — `sub` `client-<uuid>`, as a client-credentials token does — that is not
in `MCP_ALLOWED_CLIENT_IDS`. It knows neither executions nor levels: whoever it accepts may read and
write. The gateway is where `vault:read` and `vault:write` are told apart, before the server.

| Element | The `vault` route |
| --- | --- |
| Host | `hostnames: [vault.bretagne.dev]`, on the internal bind's HTTPS listener with the other routes: the sandbox sends `CONNECT vault.bretagne.dev:443`, then its MCP messages to `https://vault.bretagne.dev/mcp`. |
| Backend | An MCP backend with one target: `http://obsidian-mcp.obsidian.svc.cluster.local:4000/mcp`, `statefulMode: stateless`, tool names unprefixed. agentgateway reads every message and speaks to the server itself. Stateless, it builds its client to the server, `backendAuth` included, again for each message, so a replaced token reaches the sessions already open; otherwise agentgateway 1.6.0 builds it once per session (`mcp/upstream/mod.rs`, `setup_upstream`; infra-k8s #301). Each message reaches the server as `initialize`, the message, then `DELETE`, which ends the server's session. The Service, not the public address: `vault.bretagne.dev` resolves to the operator's public address, which reaches Traefik only by a hairpin into the private ranges the gateway's egress cuts. |
| HTTP rule | `authorization`: the rule of every route with a credential, unchanged — from the JWT's `ip`, no path tricks, a grant covering host, path with query, and method. With the `vault` grants: `POST`, `GET` and `DELETE` on `/mcp` exactly; `/sse`, `/.well-known/…`, `/health` refused (403). |
| Tool rule | `mcpAuthorization`, one `allow`: `jwt.grants.exists(g, g.host == "vault.bretagne.dev" && (!has(g.tools) \|\| (has(mcp.tool) && mcp.tool.name in g.tools)))`. agentgateway runs it on each `tools/call`, `prompts/get` and `resources/read`, and filters the lists with it (read in its 1.6.0 code, measured in infra-k8s #295). On a prompt or a resource `mcp.tool` is absent: `has(mcp.tool)` makes a grant with `tools` false there, never an error. It must stay: agentgateway 1.6.0's `exists` takes the grants in the JWT's order and stops at the first error, which refuses (measured in infra-k8s #295). Without it, `vault:read` before `vault:write` in one token would fail on the read grant and refuse the prompt that the write grant opens — grants would no longer add up. A refused call is answered by the gateway, HTTP 400 and JSON-RPC error `-32602` "Unknown tool: `<name>`" — "Unknown prompt: `<name>`" for a prompt; the server never sees it (measured on the 1.6.0 binary, C44). |
| Credential | `backendAuth.key`: `Authorization: Bearer` + the file `/etc/agentgateway/vault/access_token`, watched; whatever `Authorization` the sandbox sent never reaches the server. |
| Identity | The Pocket-ID OIDC client `agora_gateway_vault`, id `7d54f86c-7456-4cbd-b79d-a9bb7452bb62`, declared in `apps/pocket-id/oidc-reconciler/spec.json`: confidential, no callback URL, used for the client-credentials grant only. Its token is asked without `resource` — Pocket-ID 2.18 refuses a resource it has no API registered for —, so `aud` and the `sub` `client-…` both carry its id, which `obsidian-mcp` lists in `MCP_ALLOWED_AUDIENCE` and `MCP_ALLOWED_CLIENT_IDS`. No other client can get a token with that `aud`: it has no callback, so no authorization code. Its secret is the Pocket-ID reconciler's (`"secret"` in the spec): it mints it into the Secret `vault-client` of `agora-gateway`, the one secret the client keeps; emptying that Secret rotates it. |
| Keeping the token | `vault-refresher`, a CronJob in `agora-gateway`: every 5 minutes, a client-credentials request to Pocket-ID in the cluster, without `resource`, with the client's secret from `vault-client`, which it alone mounts; it writes `access_token` into the Secret `vault-token`, mounted optional on the gateway at `/etc/agentgateway/vault`: until its first run, the server answers 401. The client's tokens live 15 minutes (`accessTokenDurationMinutes: 15`). The gateway watches the file, and the open sessions use the new token from their next message; the token it replaces stays valid until it expires. Nobody mints a token. |
| Network | The gateway: egress to the `obsidian` Pods `app: obsidian-mcp`, port 4000; `obsidian-mcp`: ingress from the `agora-gateway` Pods `app: gateway`, port 4000. `vault-refresher`: egress to Pocket-ID in the cluster, port 1411, and the API server for `vault-token`. Nothing else. |

Until the route exists, `vault.bretagne.dev` is a host with no route of its own: the `internet` route
takes it, refused without `internet` (403), and with it the request leaves with no credential, which
the server refuses (401). Once the route exists, `internet` never opens it: the route compares hosts.

The credentials are in the SOPS Secret `upstream-credentials`, mounted as files. The gateway
watches these files: a rotation is a commit, with no restart. Verified: a replaced PAT was
reloaded about a minute after the merge, the time the kubelet takes to sync the Secret. Its
configuration is not watched: a new route takes a restart of the gateway (verified on 2026-10-02,
the `zai` route answered 404 "route not found" until then).

The ChatGPT session is the one credential that rotates: an OAuth set from the cluster's own codex
login, never the operator's. Its access token lives 10 days; its refresh token may be spent once.
It sits in a Secret infra-k8s keeps out of git (`chatgpt-session`), which a daily job renews five
days before expiry; nothing in the sandbox can refresh it — its `auth.json` is a placeholder and
`auth.openai.com` has no route.

The cluster's Claude login rotates too, from its own `claude auth login`, never the operator's
session: the setup-token lacks the `user:profile` scope that the usage endpoint asks for ("Limits").
It sits in a Secret infra-k8s keeps out of git (`claude-session`), which a job renews every two
hours once its access token has less than four hours left. Measured on 2026-10-07: the access
token lives 8 hours; a refresh gives a new refresh token and revokes the previous access token at
once, so inference stays on the setup-token — the gateway sees a new token only when the kubelet
syncs the Secret, about a minute later. The login ends on a fixed date, about 28 days after it,
which refreshes do not move; from five days before, the job fails, for a new login in time.

Every request leaves a log line: execution (`jwt.sub`), `jti`, method, host, path, status, and
the reason for a refusal.

## On Agora's side

| Element | Rule |
| --- | --- |
| Warming | Every 5 seconds, Agora lists the pools' Sandboxes. To each one that is ready, has an address and is still owned by a pool declaring base profiles, it hands a warm token bound to that address (`PUT /credentials`), and a new one when less than a third of its life remains. |
| At the claim | Once it sees a claim bound to the Sandbox, Agora warms it no more. On the execution's connection, before `initialize`, it hands the execution's token: the base profiles and the execution's own. `initialize` waits until the bridge has taken it; a warming hand-off still in flight has settled first. |
| Between turns | Before dispatching a prompt, Agora hands a new token if the current one would expire within the turn's maximum duration plus one minute, or names other profiles than the execution's; if it cannot, the prompt fails (`credentials_refused`) and nothing is sent. After a restart, Agora does not know which profiles the bridge's token names: it hands one before the next prompt. |
| The Create | `profiles`, optional: the execution's own. Checked against the catalogue (`unknown_profile`) and the offered profiles (`profile_not_offered`); recorded with the command. |
| Scope | The execution's own profiles replaced, between turns (`log.md`, "Commands"): the whole set, checked as the Create's, recorded with the command. If the execution is connected, its new token is handed at once, its tunnels closed — a turn has nothing in flight then; if that fails, before the next prompt, as above. |
| `POST /api/workstreams/{id}/credentials` | Test only: a token for other profiles, handed at once, its tunnels closed — whatever is in flight. |
| The token | Kept nowhere: not on the claim, not in memory after the call, not in the log. |
| After each turn | Agora reads the bridge's `outbound` field again: tunnels and responses become visible in the execution's state. |
| `GET /api/config` | `credentials` field: the gateway, the known profiles and the offered ones (`offered`), or nothing. |
| Configuration | `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, and `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE`, `OFFERED_PROFILES`. Without `GATEWAY_PROXY`, no Pod and no execution has a way out. |

The claude-code image keeps `CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder`. This value only puts the
CLI in OAuth mode: it then sends a Bearer and `anthropic-beta: oauth-…`. The gateway replaces the
Bearer and lets the rest through.

## Limits

Each account's limits — a subscription's 5-hour and weekly windows — as its provider's own usage
endpoint gives them. The server reads them through the gateway, as an execution goes out, with a
grant it signs for itself: the `limits` profile, bound to its own Pod's address. It never holds a
provider's credential.

| Base profile | Request | Windows |
| --- | --- | --- |
| `anthropic` | `GET api.anthropic.com/api/oauth/usage`, with `anthropic-beta: oauth-2025-04-20` | `five_hour` and `seven_day`, every model's week: `utilization` in percent, `resets_at`. The route `anthropic-usage` sets the cluster's Claude login; the setup-token is answered 403. |
| `chatgpt` | `GET chatgpt.com/backend-api/wham/usage` | `rate_limit.primary_window` and `secondary_window`, told apart by `limit_window_seconds` (5 hours, 7 days): `used_percent`, `reset_at`; the plan, `plan_type`. |
| `zai` | `GET api.z.ai/api/monitor/usage/quota/limit` | `data.limits` of type `TOKENS_LIMIT` or `CREDIT_LIMIT`: unit 3 the 5-hour window, unit 6 the week; `percentage`, `nextResetTime`, absent until the window has started; the plan, `level`. The MCP calls' limit is left out. |

| Element | Rule |
| --- | --- |
| The `limits` profile | Agora's own: a `GET` on the exact path of each endpoint above, nothing else. The catalogue does not know it: a Create or a Scope naming it is refused, `unknown_profile`. |
| Which accounts | The base profiles of the catalogue's pools that have an endpoint. |
| When | When the interface asks, at most once every 5 minutes, one read at a time; each account on its own, 10 seconds at most. |
| A failed read | The windows before it, kept, `stale`, with why. An account never read: no window, `stale`, why. |
| A window whose reset has passed | 0 % and no reset, until the next read. |
| `GET /api/limits` | `limits`: by base profile, its `windows` (`kind` `five_hour` or `weekly`, `usedPercent`, `resetsAt`), `plan`, `checkedAt`, `stale`, `error`. Empty when the server cannot read them. `GET` only. |
| Configuration | `POD_IP`, the server's own address, and `GATEWAY_CA_FILE`, the gateway's root. Without `POD_IP` or the gateway, no limits. |

The server reaches the gateway on port 3000, and the gateway accepts it beside the sandboxes. The
windows are the whole account's: they count what the operator spends elsewhere too.

## What the template adds

| Element | Value |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | `/etc/agora/credential-proxy/ca.pem`, from the `credential-proxy-ca` ConfigMap: "Agora gateway CA", valid until 2028. |
| `GIT_SSL_CAINFO` | The same file, for git, whose libcurl does not read `NODE_EXTRA_CA_CERTS`. The gateway's root alone: everything goes through it. |
| Network egress | DNS, and `gateway.agora-gateway` on port 3000. Nothing else: the Internet, when granted, is reached through the gateway. |

On the other side, the gateway accepts only the sandboxes and goes out only to public addresses,
on port 443.

## The model

The model is chosen over ACP: `session/set_config_option` with `configId` `model`, for example
`haiku`. It is sent after `session/new` and before the first prompt, which is the first billed
call. The test page does it itself when the agent offers the option.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| C1 | Going out without a credential | The mock's `/fetch`: `CONNECT` refused, 503; one refusal counted. |
| C2 | The chain alone | `anthropic` profile, the mock's `/fetch https://api.anthropic.com/v1/models`: a response from Anthropic, neither a 403 from the gateway nor a TLS error. |
| C3 | Real harness | `anthropic` profile, claude-code on `haiku`: a real model response. |
| C4 | Composition | Profiles `github:A:write` and `github:B:read`. A: read, write, push; B: read and fetch, no write or push; C, GraphQL: refused. |
| C5 | A JWT missing, expired or signed by another key, sent straight to the gateway | 401 from the gateway. |
| C6 | Crafted paths (`..`, `.`, `%2e`, `%2f`) under a granted repo | 403 from the gateway. |
| C7 | A host with no route of its own, the execution without `internet`: the mock's `/fetch https://example.com/` | 403 from the gateway. |
| C8 | A pool declaring `anthropic`, a pool declaring none | A warm Pod of the first can reach `api.anthropic.com` before any claim, and nothing else (403); its token names the Pod. The second's Pod has no way out (503). |
| C9 | A warm Pod waiting beyond two thirds of its token's life | A new token before the old one expires; no request refused in between. |
| C10 | A claim on a warm Pod, the Create naming `github:A:read` | Before `initialize`, a token naming the execution, with `anthropic` and `github:A:read`; the tunnels of the warm token closed. |
| C11 | A warm token being handed over when the claim binds the Pod | The execution's token is the one in place; no warm token after it. |
| C12 | An execution whose token would expire during the next turn | A new token before the prompt leaves; the previous tunnels closed; no request refused for an expired token during the turn. |
| C13 | claude-code, from the Create to a Session open | Under 5 s, with no refused connection. |
| C14 | A Create naming an unknown profile | Refused, `unknown_profile`; nothing written. |
| C15 | The chain to z.ai | `zai` profile, the mock's `/fetch https://api.z.ai/api/paas/v4/models`: 200 from z.ai, with the key the gateway set. |
| C16 | The chain to ChatGPT | `chatgpt` profile, the mock's `/fetch https://chatgpt.com/backend-api/codex/models`: 200 from ChatGPT with the session the gateway set; `/backend-api/conversations`: 403 from the gateway. |
| C17 | A Scope between turns, the execution connected; another leaving it no profile at all | Accepted; at once, a token naming the base profiles and the Scope's, the previous tunnels closed; the next prompt leaves without another. The other: a token with no grant at once. |
| C18 | A Scope during a turn, naming a profile not offered, naming one the catalogue does not know | `turn_active`, `profile_not_offered`, `unknown_profile`; no token. |
| C19 | A Scope whose token cannot be handed at once | Accepted; before the next prompt, a token naming its profiles, or the prompt fails `credentials_refused`. |
| C20 | `github:A:write` and `github:B:read` offered; Creates naming `github:A:read`, `github:A:write`, `github:B:write` | Accepted, accepted, `profile_not_offered`; `GET /api/config` lists the offered profiles. |
| C21 | Agora restarted between two turns of an execution with a token | A new token before the next prompt, naming the execution's profiles. |
| C22 | git in a harness's sandbox: `git ls-remote https://github.com/A` with `github:A:read`, then with no `github` profile | The refs, with no TLS error; then 403 from the gateway. |
| C23 | The Internet: `internet` profile, the mock's `/fetch` of `https://example.com/`, `GET` then `POST` | Both answered by example.com, the `GET` 200; the gateway logs the route `internet`. |
| C24 | `internet` alone, the mock's `/fetch` to `api.anthropic.com`, `api.z.ai`, `chatgpt.com`; on A, a `DELETE` of a branch that does not exist, the first request of a push, and a GraphQL query; then `github:A:read` added, a read of A | 403 from the gateway for each; then GitHub answers the read, through `github-api`. |
| C25 | `internet`, the mock's `/fetch` to a name resolving to a private address that refuses port 443, to that address itself, and to `https://example.com/` | The name: 503 from the gateway, the connection timed out — never refused, which would mean it was reached. The address: TLS refused by the gateway. example.com: 200. |
| C26 | `internet`, the mock's `/fetch https://example.com:8443/` | `CONNECT` refused, 404 from the gateway. |
| C27 | `PUT /credentials` with a token, then with one naming other profiles, then with one that is no JWT | `~/.agora/access.json` holds the first token's claims, then the second's, each before the answer; never a token or a signature; then no file. |
| C28 | Node's own `fetch` in the adapter's environment, before any credential; the same without `NODE_USE_ENV_PROXY` | `NODE_USE_ENV_PROXY` is `1`; the request fails, refused by the outbound proxy: one refusal counted. Without it: no refusal counted. |
| C29 | A warm token, and an execution's, for Pods whose Sandboxes record known addresses | Each token's `ip` is its Pod's address as the Sandbox records it; a signer asked for a token without a valid address refuses. |
| C30 | A token whose `ip` is another address than the one the request comes from; one with no `ip` | 403 from the gateway, on a route with a credential and on `internet`. The same token from its own address: let through. |
| C31 | `GET /api/limits` on the server in the cluster, its pools declaring `anthropic`, `chatgpt` and `zai` | For each, its 5-hour and weekly windows from the provider, `stale` false; the gateway logs a request per account from the server, under the `limits` grant; a second request within 5 minutes reaches no provider. |
| C32 | The grant the server signs for the limits | Bound to the server's address; a `GET` on the exact path of each usage endpoint; another path, a query, or another method of the same host: not covered. |
| C33 | A Create naming `limits` | Refused, `unknown_profile`; nothing written. |
| C34 | `GET /api/limits` twice at once, again within 5 minutes, then after; pools with base profiles with and without an endpoint; a `POST`; the server without an address | One read per account with an endpoint, through the gateway with the `limits` grant; nothing more within 5 minutes; read again after; 405; `limits` empty. |
| C35 | A read failing after one that succeeded; an account never read; a window whose reset has passed | The earlier windows, `stale`, the reason; no window, `stale`, the reason; that window at 0 % with no reset. |
| C36 | Each provider's answer, as given on 2026-10-07; an answer of another shape | Their 5-hour and weekly windows in percent with their resets, and the plan; z.ai's 5-hour without a reset, its MCP limit left out; no window. |
| C37 | A read through a gateway, the tunnel accepted, then refused | `CONNECT` with the grant as `Proxy-Authorization`, TLS to the host, the placeholder `Authorization` and the endpoint's headers; the answer read. Refused: an error naming the status. |
| C38 | Public GitHub: `internet` alone, the mock's `/fetch` of `api.github.com/repos/A`, of `/rate_limit`, of git's refs and `git-upload-pack` on A; then a `PATCH` of A and the first request of a push; then the same read with `anthropic` alone | GitHub answers each read, the gateway logging `github-api-public` or `github-git-public`, the rate limit the PAT's; the write and the push: 403 from the gateway; without `internet`: 403. |
| C39 | `x-gateway-grant: covered` sent by the sandbox with `internet` alone: a read of a public repository, a write on an offered one | The read through `github-api-public`; the write: 403 from the gateway. |
| C40 | A real git client with `internet` alone: `git ls-remote` and `git clone --depth 1` of a public repository, of an offered one not granted; then `git push` to it | The refs and the clones; the push refused, 403 from the gateway, no branch on GitHub. |
| C41 | The grants of `vault:read` and `vault:write`; a pool declaring either; `vault`, `vault:admin` | Only `vault.bretagne.dev`, `POST`, `GET` and `DELETE` on `/mcp` exactly: another path, method or host not covered, no grant on `*`; neither a base profile, the pool refused; the others `unknown_profile`. |
| C42 | Each of the vault's tools, and its prompt, under `vault:read` then `vault:write`, replayed with the `vault` route's two rules; a tool the server would add; `tools/list` | Read: the six read tools covered, the six write tools and the prompt not. Write: all twelve and the prompt. The added tool: write only. The list filtered to what each covers. No other profile names a tool. |
| C43 | An execution with `vault:read`, one with `vault:write`; one with other profiles, one with none | `session/new` names one MCP server, `http`, `https://vault.bretagne.dev/mcp`, no header; for the other two, `mcpServers` is `[]`. |
| C44 | Through the gateway, an MCP client dialing the server `mcpServers` names, with the `Authorization` a sandbox could send itself: with `vault:read`, `initialize`, `tools/list`, `read_note`, `create_note`, `prompts/list`, `prompts/get` of `clip-to-vault`; with `vault:write`, `tools/list`, `create_note`, `delete_note`, the prompt | Read: the six read tools listed, `read_note` answered by the server; `create_note` and the prompt refused by the gateway, HTTP 400, `-32602`, the server receiving neither; no prompt listed. Write: twelve tools; `create_note`, `delete_note` and the prompt reach the server. Every message the server receives carries the gateway's credential, never the execution's token nor the sandbox's `Authorization`. |
| C45 | `POST https://vault.bretagne.dev/mcp` with `internet` alone, with `anthropic` alone, and with `vault:write` from another address than the token's | 403 from the gateway each time; the server sees none of them. |
| C46 | `vault:read` and `vault:write` in one token, the read grant first, then the write grant first: the prompt `clip-to-vault`, `clip_url`, `delete_note`, `read_note`, with the `vault` route's tool rule | Each let through, in both orders: the grants add up. With the rule lacking `has(mcp.tool)`, the prompt is refused when the read grant comes first. |
| C47 | `vault:write` offered, a Create or a Scope naming `vault:read`; `vault:read` offered, one naming `vault:write` | The first accepted; the second `profile_not_offered`. |
| C48 | In the cluster, the `vault` route deployed: an execution with `vault:read`, its harness's MCP client on the server `session/new` names: `initialize`, then `read_note` of an existing note | The real obsidian-mcp answers both: it accepts the token of `agora_gateway_vault`, its log naming client `7d54f86c-…`; the gateway logs the route `vault`. |
| C49 | The grants of `kubernetes:read`; a pool declaring it; `kubernetes:write`, `kubernetes` | `kubernetes.agora.internal` only, `GET` and `HEAD` on `/api`, `/apis`, `/openapi`, `/version` and below, a watch included; `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `/`, `/healthz`, `/logs`, another host: not covered; no grant on `*`; not a base profile, the pool refused; the others `unknown_profile`. |
| C50 | What a command of the agent inherits from the bridge | `KUBECONFIG` names the bridge's `kubeconfig.yaml`: `https://kubernetes.agora.internal`, the gateway's root, the user `agora` with no password; no token, certificate, `exec`, `auth-provider` or `proxy-url`; `HTTPS_PROXY` the bridge's outbound proxy. |
| C51 | Through the gateway, kubectl with that kubeconfig and `HTTPS_PROXY` alone, the execution with `kubernetes:read`: `version`, `get pods`, `get pod`, a watch; `delete`, `patch`, `create`; a read with `--password` | The reads answered by the API server, the watch's event printed. The writes refused by the gateway, 403, the API server receiving none. Every request the API server receives carries the gateway's credential, never kubectl's. |
| C52 | kubectl, the execution with `anthropic` alone, with `internet` alone, and with `kubernetes:read` from another address than the token's | 403 from the gateway each time; the API server receives nothing. |
| C53 | In the cluster, the `kubernetes` route deployed, an execution with `kubernetes:read`: `kubectl get pods -A`, `get nodes`, `logs`; then `get secrets -A`, `exec`, `attach`, `port-forward`, `get --raw` of a node's `proxy/`, `create token`, `get pods --as=system:admin` | The reads answered. Each of the others refused: by the API server, 403 Forbidden, for those sent as a `GET`; by the gateway, 403, for the `POST`s. |
| C54 | `kubectl version --client` in the claude-code, codex and opencode images | 1.36.5. |
| C55 | The grants of `previews`; a pool declaring it; neighbouring hosts | `pr-<n>-<app>.preview.bretagne.dev` covered, every method and path; the neighbours listed in "Previews" not; no other route's rule and no `internet` grant covers it; not a base profile, the pool refused. |
| C56 | Through the gateway and a gateway gate, `previews` with the judge's other profiles: a `GET` with a query and a `POST` with a body, the sandbox sending its own `Authorization` and `X-Forwarded-User` | Both answered by the app, the body passed. The app receives `X-Forwarded-User` and `X-Forwarded-Email` `client-<id>`, `Authorization: Basic` of `client-<id>:none`, `x-agora-gate: gateway`; never the gateway's token, nor what the sandbox sent. |
| C57 | `previews` alone to `a.b.preview.bretagne.dev`, `pr-42-demo.x.preview.bretagne.dev`, `x.preview.bretagne.dev`, `x.bretagne.dev`, `preview.bretagne.dev.evil.com`, `pr-42-demo.preview.bretagne.dev.evil.com`; a preview with `anthropic` alone, with `internet` and a repository, and with `previews` from another address | 403 from the gateway each time; the app receives nothing; `previews` from its own address: answered. |
| C58 | Straight to a gateway gate: the gateway's token; another client's; another client's claiming the gateway's audience; an `admin`'s token for the gateway's client; the gateway's expired; no token. The gateway's token to the browser gate | Only the first passes; the others 401 or 403, the app receiving none. The browser gate: 302 to Pocket-ID's sign-in, not the app. |
| C59 | The gateway gate's identities swapped, as the kubelet updates a ConfigMap, without `client-<id>`; then with it | The gateway's tokens, a fresh one included, refused — through the gateway too; then taken again. |
| C60 | The gateway's credential replaced while a response from the app is under way | That response ends whole; the next request carries the new credential. |
| C61 | In the cluster, the route and the gateway gate deployed, a preview open: the judge with `previews`; a browser without a session; the client `agora_gateway_previews` asked for a device code and an authorization code | The judge reaches the preview's app through the gateway gate; the browser is sent to Pocket-ID by the browser gate; Pocket-ID gives no user token for the client. |
| C62 | In Pocket-ID, `agora_gateway_previews` given a second secret, a token asked with each; the first secret deleted; then the client deleted | A token for each while both exist; once the first is deleted, it is refused and the second still answered; once the client is deleted, neither; the tokens already issued still taken by the gateway gate until they expire, and refused once `client-<id>` is out of its identities. |

**To be specified:** a harness initializing in the pool (claude-code's SDK); count the responses
to `CONNECT` by status, not just the last one; read access to GraphQL.

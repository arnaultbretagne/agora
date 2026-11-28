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
| `PUT /credentials` | With Agora's token. The body gives the proxy (`host:port`), the token and its expiry. Replaces the previous token: later tunnels use the new one. A renewal — the same proxy, and a token naming the same `sub` with the same `grants` — leaves the tunnels opened with the previous token open, and closes them 30 s before it expires; any other token closes them at once. |
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
| `antigravity` | `daily-cloudcode-pa.googleapis.com`, only `/v1internal:…`, every method; `www.googleapis.com`, only `GET /oauth2/v2/userinfo`: what agy uses ("Antigravity"). The login reaches the account's whole Google Cloud. |
| `internet` | `*`, everything: any host with no route of its own, with no credential set. Public addresses, HTTPS on port 443. On GitHub, what no `github` profile covers, read only: the public routes below. |
| `github:owner/repo:read` | REST API `/repos/owner/repo…` with `GET` and `HEAD`; git `git-upload-pack` only (a clone also sends a `POST`). |
| `github:owner/repo:write` | REST API `/repos/owner/repo…`, all methods; git `git-upload-pack` and `git-receive-pack`. And Agora's MCP endpoint, as `agora:read`'s grant: Agora opens `propose_merge` to it (`merge.md`). |
| `github:owner/repo:review` | REST API `/repos/owner/repo…`, all methods; git `git-upload-pack` only. As the reviewer ("GitHub identities"): its approval is the review `main` requires; no git push, and no merge. |
| `vault:read` | `vault.bretagne.dev`, `/mcp` exactly, `GET`, `POST` and `DELETE`; `tools`: `read_note`, `search_content`, `search_properties`, `get_backlinks`, `list_properties`, `get_property_values`. No prompt, no resource. |
| `vault:write` | The same host, path and methods, no `tools`: the whole server — its twelve tools, the six of `vault:read` and `create_note`, `update_note`, `delete_note`, `move_note`, `update_schema`, `clip_url` — and its prompt `clip-to-vault`. |
| `kubernetes:read` | `kubernetes.agora.internal`, `GET` and `HEAD` on the API's paths: `/api`, `/apis`, `/openapi`, `/version` and what lies under them, any query. A watch is a `GET`: covered. What may be read is the credential's RBAC ("Kubernetes"). |
| `previews` | The hosts `pr-<n>-<app>.preview.bretagne.dev` — one DNS label, `<n>` a pull request's number, `<app>` lowercase letters, digits and dashes —, every path and every method. Through the preview's gateway gate ("Previews"). Every execution's ("Default profiles"). |
| `agora:read` | `mcp.agora.internal`, `/mcp` exactly, `GET`, `POST` and `DELETE`: Agora's own MCP server ("Agora's MCP"). No `tools`: Agora tells its tools apart itself, by the rights it recorded (`mcp.md`). Every execution's ("Default profiles"). |
| `agora:delegate` | The same grant as `agora:read`; Agora opens `spawn_agent`, `send_message`, `stop_agent` and `list_agents` to it (`delegation.md`). |
| `agora:submit` | The same grant as `agora:read`; Agora opens `send_message` to it, toward its delegator alone. Agora's own: given by Agora to every delegate, never offered, never named by a Create or a Scope (`unknown_profile`) but one keeping what its Workstream's last execution holds. |

Grants are additive. GraphQL (`/graphql`) is covered by no profile. A GitHub grant names who acts,
`identity`: `contributor` for read and write, `reviewer` for review.

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
| `antigravity` | Yes |
| `internet` | No |
| `github:…` | No |
| `vault:read`, `vault:write` | No |
| `kubernetes:read` | No |
| `previews` | No |
| `agora:read` | No |
| `agora:delegate`, `agora:submit` | No |

A pool without the annotation, or declaring a profile that is not a base one, gets no warm token;
the catalogue (`GET /api/pools`) shows its base profiles, or the refused one.

A base profile is a harness's infrastructure, never a right a person or a delegating agent picks:
its pool alone gives it.

| Element | Rule |
| --- | --- |
| Declared | On a pool alone, by its annotation. |
| Offered | Never. `OFFERED_PROFILES` naming one stops the server at start, as a profile the catalogue does not know ("Offered profiles"); `GET /api/config` never lists one in `offered`. |
| Named | Never: a Create, a Scope or a delegate's `rights` (`delegation.md`) naming one is refused, `unknown_profile`, whatever `OFFERED_PROFILES` says, the variable unset included; nothing is written, no token handed. |
| The access picker | Shows none (`assistant-ui.md`, "Access"). |
| Held | By every execution of the pool, from its Create's `baseProfiles` ("On Agora's side"): its warm token names them, and its execution's token beside its own profiles. They feed `GET /api/limits` ("Limits"). |
| `POST /api/workstreams/{id}/credentials` | Test only, it may still name one: the live cases of the gateway's chains go through it. |

### Default profiles

Every new execution holds `agora:read` and `previews` without anyone naming them, whether a person's
Create starts it, a `spawn_agent` (`delegation.md`) or Agora continuing a Workstream: Agora gives
every agent Agora's MCP server, read (`mcp.md`), and the previews. Each can then read the person's
Workstreams, an execution holding `internet` too.

| Element | Rule |
| --- | --- |
| The Create | Its profiles checked as before ("Offered profiles"), then the defaults it does not name added after its own. Recorded so, with the command: they are among the execution's own profiles, in the log's `profiles`, its token's `profiles` and grants, `~/.agora/access.json` and its Session's `mcpServers` ("MCP servers"). |
| Naming one | A Create, a Scope or a delegate's `rights` may name a default, whatever `OFFERED_PROFILES` says: never `profile_not_offered`, and never a right beyond its delegator's (`delegation.md`, "Approval"). |
| Offered | Never: `GET /api/config` leaves them out of `offered`. `OFFERED_PROFILES` may still list them: they are left out there too, and the list still restricts what else may be named, as any list does. |
| A Scope | Replaces the execution's own profiles with the set it gives, as before: a default it leaves out is taken from that execution, until its Workstream's next Create. |
| Base | Neither: a warm Pod holds neither before its claim. |

### Offered profiles

What an execution may be given beyond its pool's base profiles is declared on Agora, in
`OFFERED_PROFILES`: profiles separated by commas, each at the widest access it may be given. The
interface offers these (`assistant-ui.md`, "Access"); a Create or a Scope may name an offered
profile, or a narrower one of the same repository or of the vault.

| Offered | May be named |
| --- | --- |
| `github:owner/repo:write` | `github:owner/repo:write`, `github:owner/repo:review`, `github:owner/repo:read` |
| `github:owner/repo:review` | `github:owner/repo:review`, `github:owner/repo:read` |
| `github:owner/repo:read` | `github:owner/repo:read` |
| `vault:write` | `vault:write`, `vault:read` |
| `vault:read` | `vault:read` |
| `internet`, `kubernetes:read`, `agora:delegate` | Itself |
| Anything, or nothing | `agora:read` and `previews`, the default profiles ("Default profiles") |

The vault's levels follow GitHub's: `vault:read` opens a subset of what `vault:write` opens — six of its
tools, on the same host, path and methods — so an operator offering write has accepted every read,
and the user may pick the narrower one. Anything else is refused (`profile_not_offered`). Without the variable, any profile of the
catalogue may be named but a base one, and the interface offers none. A profile the catalogue does not know, or a base profile
("Base profiles"), stops the server at start.

### MCP servers

A profile may open an MCP server: the execution's `session/new` names it, and the harness reaches it
through the gateway like any host. The catalogue holds them beside the profiles.

| Element | Rule |
| --- | --- |
| `mcpServers` | In `session/new`, and in `session/load` or `session/resume` when a Session is restored: the servers the execution's profiles — its base profiles and its own — open, each once. `[]` when none does. |
| The vault | With `vault:read` or `vault:write`, or both: one server, `{ "type": "http", "name": "vault", "url": "https://vault.bretagne.dev/mcp", "headers": [] }`. |
| Agora | With `agora:read`, `agora:delegate` or `agora:submit`, or several: one server, `{ "type": "http", "name": "agora", "url": "https://mcp.agora.internal/mcp", "headers": [] }`. |
| Headers | None. The gateway sets the server's credential; nothing in `mcpServers` is a secret, and it is written in the log. |
| A Scope | Changes the token, never the Session's servers, fixed when it opens. A Session opened without the vault does not get it; one opened with it and scoped out of it keeps the server, refused by the gateway (403). |

## The token

An EdDSA JWT signed by Agora's key (Secret `grants-key`), `kid` `agora-grants-1`.

| Claim | Content |
| --- | --- |
| `iss`, `aud` | `agora`, `agora-gateway`: required by the gateway. |
| `sub` | The execution (`agora <execution>`), or the warm Pod (`agora warm <sandbox>`); written in every log line. |
| `exp` | A warm token: 15 minutes. An execution's: one hour, three leases at least, from when it is handed over; renewed while its sandbox lives ("On Agora's side"). Between 60 s and 24 h. |
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

GitHub has three routes per host: one per identity for what a grant covers, one for the rest. On
`api.github.com` and `github.com`, the listener sets `x-gateway-grant` before a route is picked —
`contributor` when the rule above would let the request through with a grant of the contributor's,
else `reviewer` when it would with one of the reviewer's, else `operator` with Agora's own `merge`
grant, `none` otherwise — overwriting whatever the sandbox sent. A grant naming no identity is the contributor's. `github-api` and `github-git`
take `contributor`, `github-api-reviewer` and `github-git-reviewer` take `reviewer`: a route with a
header match outranks the one without. `github-api-public` and `github-git-public` take the rest.
The header only steers: each route checks the request again, against its own identity's grants, so
a header the sandbox sets itself gains nothing, and each removes it before GitHub.

The public routes' rule: the request comes from the JWT's `ip`, its path has none of the tricks
above, one of the JWT's grants is on host `*`, and the request reads. On `api.github.com`, `GET` and
`HEAD`. On `github.com`, `GET` and `HEAD` except `git-receive-pack`'s first request, and the `POST`
of `git-upload-pack` that a clone or a fetch sends. They set a token of the contributor's App that
reads its public repositories only: it reads every public repository on GitHub, none of the
operator's private ones, with an installation's rate limit. GraphQL stays closed: it is always a
`POST`, read or write.

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
| `antigravity-userinfo` | `www.googleapis.com`, `GET /oauth2/v2/userinfo` only ("Antigravity") | `Authorization: Bearer` + the access token of the cluster's own Google login. |
| `antigravity` | `daily-cloudcode-pa.googleapis.com` ("Antigravity") | `Authorization: Bearer` + the access token of the cluster's own Google login. |
| `github-api` | `api.github.com`, `x-gateway-grant: contributor` | `Authorization: Bearer` + the contributor's installation token. |
| `github-git` | `github.com`, `x-gateway-grant: contributor` | `Authorization: Basic` + `x-access-token:` and the contributor's token, in base64. |
| `github-api-reviewer` | `api.github.com`, `x-gateway-grant: reviewer` | As `github-api`, with the reviewer's token. |
| `github-git-reviewer` | `github.com`, `x-gateway-grant: reviewer` | As `github-git`, with the reviewer's token. |
| `github-api-public` | `api.github.com`, the rest; reads, with `internet` | As `github-api`, with the token that reads public repositories only. |
| `github-git-public` | `github.com`, the rest; clone and fetch, with `internet` | As `github-git`, with that token. |
| `vault` | `vault.bretagne.dev`; an MCP backend, the tools the grants name ("The vault") | `Authorization: Bearer` + an access token of the Pocket-ID machine client `agora_gateway_vault`. |
| `kubernetes` | `kubernetes.agora.internal`, to the cluster's API server ("Kubernetes") | `Authorization: Bearer` + the token of the gateway's own ServiceAccount, projected, read only by its RBAC. |
| `previews` | `*.preview.bretagne.dev`, the hosts a grant's `hostPattern` covers ("Previews") | `Authorization: Bearer` + a token of the Pocket-ID client `agora_gateway_previews`; `x-agora-gate: gateway`. |
| `agora` | `mcp.agora.internal`, to Agora's server, port 8082 ("Agora's MCP") | None; `Authorization: Bearer` + the JWT the CONNECT carried, which Agora checks again; `x-agora-execution` set to the JWT's `sub`. |
| `internet` | Any other | None. |

### GitHub identities

Agora acts on GitHub as two GitHub Apps of the operator's, each installed once on the account with
every repository: one actor each, `<app>[bot]`, never the operator. The grants narrow what each
App's installation reaches; the App's permissions bound what it may do there.

| Identity | App | Permissions | Profiles |
| --- | --- | --- | --- |
| `contributor` | `agora-contributor` | Contents, pull requests and issues read and write; actions, checks, commit statuses read. No workflows, no administration. | `github:…:read`, `github:…:write` |
| `reviewer` | `agora-reviewer` | The same. Contents write is what makes its approval count: GitHub counts an approval only from an actor who may write. | `github:…:review` |

- **One writes, one reviews, the person merges.** `main` requires one approving review, from
  someone other than the last pusher, and restricts its updates to the operator: the contributor
  opens and pushes, the reviewer's approval is the review required, and neither App may merge. A
  push after an approval dismisses it. GitHub lets the contributor approve a pull request it did not
  write, the operator's: that approval counts too.
- **One actor per App.** GitHub refuses an approval from a pull request's author: the review is
  another App's, and an App can be only one of them.
- **Both on a repository: the contributor.** A request a grant of each covers goes as the
  contributor: review adds nothing to write.
- **The tokens.** An installation token lives one hour. A refresher in the infrastructure mints
  each App's every 15 minutes from its private key, and a third, the contributor's narrowed to its
  public repositories with read permissions, for the public routes; the gateway watches the files,
  with no restart.
- **The commits.** git commits as the contributor ("What the template adds"), so a commit shows
  the actor that pushed it.

The operator's own credential reaches no execution: only Agora's own `merge` grant, `identity` `operator`, reaches the route that sets it, `github-api-operator` — to merge from the card (`merge.md`).

| Identity | Who holds it | Route | Credential |
| --- | --- | --- | --- |
| `operator` | The server alone, its `merge` grant ("Limits") | `github-api-operator`, `x-gateway-grant: operator` | The operator's PAT, as `Authorization: Bearer`. |

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
| The binary | kubectl 1.36.5, within one minor of the cluster's (k0s 1.36), in the claude-code, codex, opencode and antigravity images: the release binary, checked against its sha256 at the build, which runs `kubectl version --client`. Not in the mock's. |
| Its configuration | `KUBECONFIG`, set by the bridge in the adapter's environment, names `kubeconfig.yaml`, shipped with the bridge (`packages/harness-bridge/src`), which every image copies — not `~/.kube/config`: `HOME` is a `tmpfs` in the cluster. One cluster, `server: https://kubernetes.agora.internal`, `certificate-authority: /etc/agora/credential-proxy/ca.pem`; one user, `username: agora`; one context, current. |
| No credential | No token, no client certificate, no password, no `exec` or `auth-provider`. The user name is there only because kubectl asks for credentials on stdin for a user it cannot identify (client-go 1.36.5, `canIdentifyUser`): kubectl then sends `Authorization: Basic` of `agora:`, which the gateway replaces. |
| The way out | No `proxy-url`: client-go then takes `HTTPS_PROXY` (`http.ProxyFromEnvironment`, read in client-go 1.36.5, `transport/cache.go`), the bridge's outbound proxy, which adds the token to the `CONNECT`. |
| The root | The gateway's alone: client-go builds its pool from `certificate-authority` only, without the system's roots (`transport/transport.go`, `rootCertPool`). |

### Previews

A preview (infra-k8s ADR 0017 v4, §7) is served at `pr-<n>-<app>.preview.bretagne.dev`, behind a gate
in `preview-system`: oauth2-proxy, which lets an `admin` through with a browser session. `previews`
lets an execution — a `judge` — reach a preview with no browser and no credential in the
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
| `previews` taken out of the default profiles, in Agora's code ("Default profiles"), and out of `OFFERED_PROFILES` | No new execution is given it. | From the start of a server built with that code. Tokens already handed expire with them. |

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

### Agora's MCP

Agora's own MCP server (`mcp.md`) is a host of the gateway like any other. The gateway checks the
token and the grant and forwards the token to Agora, which checks it again and takes the caller
from it; it sets no credential and reads no MCP message: Agora opens its tools by the rights it
recorded.

| Element | The `agora` route |
| --- | --- |
| Host | `hostnames: [mcp.agora.internal]`, on the internal bind's HTTPS listener with the other routes: the sandbox sends `CONNECT mcp.agora.internal:443`, then its MCP messages to `https://mcp.agora.internal/mcp`. The name resolves nowhere: only this route knows it. |
| Backend | `http://server.agora.svc.cluster.local:8082`, an HTTP backend: the messages pass as the sandbox sent them. |
| HTTP rule | `authorization`: the rule of every route with a grant — from the JWT's `ip`, no path tricks, a grant covering host, path with query, and method. With `agora:read`'s grant: `GET`, `POST` and `DELETE` on `/mcp` exactly; any other path refused (403). |
| The caller | `Authorization: Bearer` and the JWT the CONNECT carried — the one `jwtAuth` verified, read by the same expression —, over whatever the sandbox sent: the proof Agora checks (`mcp.md`, "The caller"). And `x-agora-execution`, set from the JWT's `sub` — `agora <execution>` — over whatever the sandbox sent: Agora reads it no more; set, no header of the sandbox's reaches any server under that name. |
| Credential | None. |
| Network | The gateway: egress to the `agora` Pods `app: server`, port 8082. The server: ingress on port 8082 from the `agora-gateway` Pods `app: gateway`, and from no other Pod — the node reaches it, as Cilium lets a node reach every port of its Pods; its Service gains port `mcp`, 8082. |

Until the route exists, `mcp.agora.internal` is a host with no route of its own: the `internet` route
takes it, refused without `internet` (403), and with it the gateway cannot resolve the name. Once the
route exists, `internet` never opens it.

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

The cluster's Google login, for agy, is renewed too, from its own login, never the operator's; how
long its tokens live and whether its refresh token rotates are not measured yet ("Antigravity").

Every request leaves a log line: execution (`jwt.sub`), `jti`, method, host, path, status, and
the reason for a refusal.

### Antigravity

`antigravity` runs agy, the Antigravity CLI, on the cluster's own Google login: a Google account
dedicated to the cluster, holding its own Google AI subscription, never the operator's — as the
ChatGPT session and the Claude login are the cluster's own. The gateway sets the login's access
token; the sandbox holds a placeholder.

**What agy does.** Measured on 2026-11-20 on agy 1.5.13, the release binary, behind a local stand-in
for Google that answered its login and logged each request it sent; Google itself answered 401 to the
stand-in's tokens.

| Element | agy 1.5.13 |
| --- | --- |
| Inference | `POST daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`, its body naming the project `loadCodeAssist` gave. `daily-cloudcode-pa` is agy's default endpoint (`--cloud_code_endpoint`). |
| Before and beside it | On the same host, `POST /v1internal:loadCodeAssist` (the account's tier and project), `fetchAvailableModels`, `fetchUserInfo`, `retrieveUserQuotaSummary`, `fetchAdminControls`, `listExperiments`, `writeTrajectoryAcls`; and `GET www.googleapis.com/oauth2/v2/userinfo`. |
| Its credential | `Authorization: Bearer` and the access token of its token file, on each of those requests; no other credential header, no `x-goog-user-project`. |
| Telemetry | `POST play.googleapis.com/log`, with the same Bearer. None with `--disable-telemetry`, which the image passes. |
| Refreshing | `POST oauth2.googleapis.com/token`, `grant_type=refresh_token`, the client's id and secret in the body; only once the token file's `expiry` has passed. Never on a 401: Google's 401 ends the turn, written in the answer, and the file is left as it is. |
| Its token store | Without a D-Bus session bus, as in a Pod, a file instead of a keyring: `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`, JSON `{"token": {"access_token", "token_type", "refresh_token", "expiry"}, "auth_method"}`, as agy writes it at a login. |
| Without a browser | With the file, `session/new` and `authenticate` (`oauth-personal`) succeed without opening a browser, whatever Google answers. Without it, `session/new` fails `Authentication required` and `authenticate` at once, -32603 "No browser is available here". Agora never calls `authenticate`. |
| The way out | `HTTPS_PROXY`, the bridge's; the root, from `SSL_CERT_FILE` — a Go binary, which does not read `NODE_EXTRA_CA_CERTS`. |

**The placeholder.** The image writes the token file at start (`harnesses/antigravity`): `access_token`
and `refresh_token` `agora-placeholder`, `expiry` 2099-01-01, `auth_method` `consumer`. agy then sends
`Bearer agora-placeholder`, which the gateway replaces, and never refreshes.

**The OAuth client.** agy's own, Google's: id `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`,
its secret in the binary, as an installed application's is, the string beginning `GOCSPX-K58F` — public, no
credential (measured: Google
answers this pair `invalid_grant` to an unknown refresh token, and `invalid_client` to the two other
secrets the binary holds). PKCE, redirect `https://antigravity.google/oauth-callback`. Scopes
`cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, `aicode`,
`openid`: the access token reaches the account's whole Google Cloud. The account owns no Cloud project,
and the grants open two paths of Google and nothing else.

| Element | The routes |
| --- | --- |
| `antigravity` | `hostnames: [daily-cloudcode-pa.googleapis.com]`, on the internal bind's HTTPS listener with the other routes. Rule: the rule of every route with a credential — from the JWT's `ip`, no path tricks, a grant covering host, path with query, and method; the grant's path `^/v1internal:[A-Za-z]+(\?.*)?$`. |
| `antigravity-userinfo` | `hostnames: [www.googleapis.com]`, the exact path `/oauth2/v2/userinfo` alone; the same rule, the grant's path `^/oauth2/v2/userinfo$`, `GET`. Any other path of that host is not this route's: it falls to the `internet` route, which sets no credential — 403 without `internet`. |
| Credential | `backendAuth.key`: `Authorization: Bearer` + the file `/etc/agentgateway/antigravity/access_token`, watched, on both routes; whatever `Authorization` agy sent is replaced. |
| No route | `oauth2.googleapis.com`, `play.googleapis.com`: hosts with no route of their own, 403 without `internet`; with it, the request leaves as the sandbox sent it, a placeholder — nothing in the sandbox can refresh the login. |

**The login and its renewal.**

| Step | What |
| --- | --- |
| The login | Once, by the operator, with the dedicated account, in a throwaway Linux environment with no D-Bus session bus, so that the token goes to the file: `HOME=$(mktemp -d) agy acp --login` prints a URL; opened in a browser signed into that account, its code pasted back. The refresh token is the file's `token.refresh_token`; the throwaway HOME is deleted after. Each login mints a new refresh token. |
| The renewal | `antigravity-refresher`, a CronJob in `agora-gateway`, every 15 minutes: `POST https://oauth2.googleapis.com/token` with the client's id and secret, `grant_type=refresh_token` and the refresh token; it writes `access_token` into the Secret `antigravity-token`, mounted optional on the gateway at `/etc/agentgateway/antigravity`: until its first run, Google answers 401. The gateway watches the file, and the next request carries the new token. |
| The refresh token | Where it lives follows from whether it rotates. If a refresh gives no new one and the first stays good: in the SOPS Secret `upstream-credentials`, key `antigravity-refresh-token`, a rotation then being a commit. If it rotates: a Secret infra-k8s keeps out of git, `antigravity-session`, which the refresher rewrites with each new one, as `chatgpt-session`. The client's id and secret are public and may sit in the refresher's configuration. |
| Network | `antigravity-refresher`: egress to `oauth2.googleapis.com` on 443, and the API server for `antigravity-token`. The gateway: public addresses on 443, as for every route. |

**What is not measured yet.** Nothing above was seen with a real login: these come from Google's
documentation, or are assumed, and the operator measures them on the cluster's login.

| Fact | Source | How it is measured |
| --- | --- | --- |
| The access token lives 1 hour (`expires_in` 3599) | Google's documentation | The refresher's answer. |
| The refresh token does not rotate: a refresh gives no new one, and the first stays good | Google's documentation | Right after the login, two refreshes: whether either answer holds a `refresh_token`, and whether the first refresh token still works after the second. Settles where it lives (above). |
| The refresh token ends when revoked, after six months unused, or once the account holds more than 100 of this client's | Google's documentation | — |
| An access token stays good until its expiry after a refresh | Assumed | The previous token used once after a refresh. |
| What `loadCodeAssist` answers for the account: tier, project, and whether the subscription gives agy its quota | Not seen: the stand-in answered it | The first real turn (E34). |
| agy loading the workspace's `AGENTS.md` | Not seen: in the stand-in's runs no rule reached the model's request, in a git repository or not, nor `~/.gemini/GEMINI.md` | The first real turn (E35). |

Agora reads the account's limits as agy does, `loadCodeAssist` then `retrieveUserQuotaSummary`, and, when the summary
holds no Gemini window, `retrieveUserQuota`, as Omarchy does ("Limits").

## On Agora's side

| Element | Rule |
| --- | --- |
| Warming | Every 5 seconds, Agora lists the pools' Sandboxes. To each one that is ready, has an address and is still owned by a pool declaring base profiles, it hands a warm token bound to that address (`PUT /credentials`), and a new one when less than a third of its life remains. |
| At the claim | Once it sees a claim bound to the Sandbox, Agora warms it no more. On the execution's connection, before `initialize`, it hands the execution's token: the base profiles and the execution's own. `initialize` waits until the bridge has taken it; a warming hand-off still in flight has settled first. |
| Between turns | Each time Agora moves the execution's deadline (`executions.md`, "The deadline") — a prompt dispatched, a renewal during a turn or while work left running runs, the end of a turn —, it first hands a new token if the current one would expire less than half a token's life after the deadline it is about to set, or names other profiles than the execution's: the token in place always outlives the sandbox's deadline. Before a prompt, if it cannot, the prompt fails (`credentials_refused`) and nothing is sent; at a renewal, the deadline is not moved, and the next step tries again. After a restart, Agora does not know which profiles the bridge's token names: it hands one before the next prompt or renewal. |
| The Create | `profiles`, optional: the execution's own. Checked against the catalogue, a base profile refused as unknown (`unknown_profile`, "Base profiles"), and the offered profiles (`profile_not_offered`); the default profiles it does not name added after them ("Default profiles"); recorded with the command. Its pool's base profiles are recorded beside them, as `baseProfiles`: the execution's until it ends, its pool replaced by a newer image's or declaring others meanwhile. A Create that recorded none, written before they were: its pool's, while the catalogue lists it. |
| Scope | The execution's own profiles replaced, between turns (`log.md`, "Commands"): the whole set, checked as the Create's, recorded with the command. If the execution is connected, its new token is handed at once, its tunnels closed — a turn has nothing in flight then; if that fails, before the next prompt, as above. |
| `POST /api/workstreams/{id}/credentials` | Test only: a token for other profiles, handed at once, its tunnels closed — whatever is in flight. |
| The token | Kept nowhere: not on the claim, not in memory after the call, not in the log. |
| After each turn | Agora reads the bridge's `outbound` field again: tunnels and responses become visible in the execution's state. |
| `GET /api/config` | `credentials` field: the gateway, the known profiles and the offered ones (`offered`), never a default profile nor a base one, or nothing. |
| Configuration | `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, and `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE`, `OFFERED_PROFILES`. Without `GATEWAY_PROXY`, no Pod and no execution has a way out. |

The claude-code image keeps `CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder`. This value only puts the
CLI in OAuth mode: it then sends a Bearer and `anthropic-beta: oauth-…`. The gateway replaces the
Bearer and lets the rest through.

## Limits

Each account's limits — a subscription's 5-hour and weekly windows, or its billing period — as its
provider's own usage endpoint gives them. The server reads them through the gateway, as an execution goes out, with a
grant it signs for itself: the `limits` profile, bound to its own Pod's address. It never holds a
provider's credential.

| Base profile | Request | Windows |
| --- | --- | --- |
| `anthropic` | `GET api.anthropic.com/api/oauth/usage`, with `anthropic-beta: oauth-2025-04-20` | `five_hour` and `seven_day`, every model's week: `utilization` in percent, `resets_at`. The route `anthropic-usage` sets the cluster's Claude login; the setup-token is answered 403. |
| `chatgpt` | `GET chatgpt.com/backend-api/wham/usage` | `rate_limit.primary_window` and `secondary_window`, told apart by `limit_window_seconds` (5 hours, 7 days): `used_percent`, `reset_at`; the plan, `plan_type`. |
| `xiaomi` | `GET token-plan-ams.xiaomimimo.com/v1/platform/token_plan` | One window, `period`, the Token Plan's billing period, a month or a year: `quota.used_credits` of `quota.total_credits` in percent, to 100 at most; its reset `period.end_at`, `YYYY-MM-DD HH:MM:SS` in UTC; the plan, `plan_code`. No window while `total_credits` is 0, nor for an answer whose `object` is not `token_plan`. The route `xiaomi` sets the operator's Token Plan key, `tp-…`, of the European cluster ("Xiaomi's answer"). |
| `zai` | `GET api.z.ai/api/monitor/usage/quota/limit` | Not read, for now ("Not read"). `data.limits` of type `TOKENS_LIMIT` or `CREDIT_LIMIT`: unit 3 the 5-hour window, unit 6 the week; `percentage`, `nextResetTime`, absent until the window has started; the plan, `level`. The MCP calls' limit is left out. |
| `antigravity` | `POST daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`, `{"metadata": {"ideType": "ANTIGRAVITY", "platform": "LINUX_AMD64", "pluginType": "GEMINI"}}`; then `POST /v1internal:retrieveUserQuotaSummary` on the same host, `{"project": …}`, the project being the first answer's `cloudaicompanionProject` (a string, or an object's `id`); then, only when the summary gives no window, `POST /v1internal:retrieveUserQuota` on the same host with the same body. All with `User-Agent: antigravity/1.5.13 linux/amd64`. The route `antigravity` sets the cluster's Google login. | Gemini's buckets: those of the group named `Gemini Models` (or `Gemini`), and any whose `bucketId` begins `gemini-` or `gemini_`, Argon's excepted, in `groups[].buckets[]` or the deprecated top-level `buckets[]` — every top-level bucket when there is no group, Claude and GPT's `3p` ids excepted; the answer bare, or in `response` or `summary`. A bucket's window from its `window`, else its `bucketId`, else its `displayName` ("Google's answer"): `5h`, `session`, `5-hour`, `five hour` the 5-hour window, `weekly` the week. Used is 100 × (1 − what remains), to the hundredth: the fraction — `remainingFraction` or `remaining_fraction`, or `remaining.remainingFraction`, or `remaining` `{case: "remainingFraction", value}`, a number or a number written as a string —, a fraction outside 0 to 1 none; without a fraction, an amount (`remainingAmount`, `remaining_amount`, the oneof's) of 0 nothing left, any other amount none; neither, with a reset time, nothing left; `resetTime` or `reset_time`. Two buckets of one window: the more spent. A bucket `disabled`, or with neither and no reset time, gives no window. A fraction of 1, an untouched window: 0 % and no reset. No plan. The other groups — Claude and GPT models, Gemini 4 Argon, a placeholder's All Models — are left out. With no window there, the per-model quota's ("Google's answer"): of `buckets[]`, those whose `modelId` (or `model_id`), after a `models/`, begins `gemini`, Argon's excepted, read as above; the most spent, the earliest reset among equals, is the 5-hour window, without a reset when untouched. 400 or 404 there: no window. |

| Element | Rule |
| --- | --- |
| The `limits` profile | Agora's own: a `GET` on the exact path of each endpoint above, nothing else — but on `daily-cloudcode-pa.googleapis.com`, a `POST`, and nothing else, on three exact paths, `/v1internal:loadCodeAssist`, `/v1internal:retrieveUserQuotaSummary` and `/v1internal:retrieveUserQuota`: Google answers the quotas to a `POST` alone, for a project only `loadCodeAssist` names. None changes the account; inference and agy's other calls stay out. The catalogue does not know it: a Create or a Scope naming it is refused, `unknown_profile`. |
| The `merge` profile | Agora's own, for the merge card (`merge.md`), bound to the server's address like `limits`: on `api.github.com`, `GET` of a pull request and of its reviews, `PUT` of its merge, nothing else, as `identity` `operator` ("GitHub identities"). Unknown to the catalogue: `unknown_profile`. |
| Which accounts | The base profiles of the catalogue's pools that have an endpoint, but those not read; and, whatever the pools, those read without a pool: `xiaomi`, the operator's Xiaomi MiMo subscription, which no harness uses. A departure, approved by the operator: the only account read that no execution draws from. `xiaomi` is no profile of the catalogue, base or other, so no execution can hold it: only the `limits` grant opens its host. It is listed in `LIMITS_WITHOUT_POOL` (`packages/credentials/src/limits.ts`); an account not read wins over it. |
| Not read | `zai`: the operator's z.ai subscription has lapsed (2026-11), and its endpoint answers no window. Its endpoint stays in the code, and the `limits` grant still covers it, but it is never asked and `GET /api/limits` has no `zai`, whatever the pools declare; the opencode pool and the route `zai` are unchanged. A preview leaves it out too (`preview.md`, "The limits"). To read it again: take `zai` out of `LIMITS_NOT_READ` in `packages/credentials/src/limits.ts`, then out of this row and of C31, C34 and V12, whose tests expect it absent. |
| When | When the interface asks, at most once every 5 minutes, one read at a time; each account on its own, each of its requests 10 seconds at most — Google's, `loadCodeAssist`, the summary, then the per-model quota when the summary gives no window, one after the other, so up to 30 seconds for that account. |
| A failed read | The windows before it, kept, `stale`, with why. An account never read: no window, `stale`, why. An answer that is not JSON, any provider's: `<host> answered no JSON to <path>`, not a word of it. Google's: `loadCodeAssist` answered anything but 200 (`daily-cloudcode-pa.googleapis.com answered 403 to /v1internal:loadCodeAssist`), or named no project (`loadCodeAssist named no project: currentTier "free-tier", paidTier none, no project, fields {currentTier}`) — the summary is then not asked; the per-model quota answering anything but 200, 400 or 404 (`daily-cloudcode-pa.googleapis.com answered 500 to /v1internal:retrieveUserQuota`); neither the summary nor the per-model quota holding a Gemini window (`daily-cloudcode-pa.googleapis.com gave no window: loadCodeAssist …; summary …; retrieveUserQuota …`, its last part `answered 404` or `answered 400` when it has none). Either says what Google's answers held, enough to write the reader from: `loadCodeAssist`'s tiers' ids (`currentTier`, `paidTier`, each `ineligibleTiers` id and `reasonCode`), which project — none, Google's shared consumer project (`aicode-consumers`), or the account's own, never its id —, its fields' names; the summary's fields' names, each group's `displayName`, each bucket's `bucketId`, `window`, fraction, `disabled`, `displayName` and fields' names; the per-model quota's fields' names, each bucket's `modelId` (after a `models/`), fraction, `disabled` and fields' names. Nothing of Google's is written but by construction, whatever it sends: of a string, only the words — runs of letters or digits — that `DIAGNOSTIC_WORDS` (`packages/credentials/src/limits.ts`) lists, Google's own vocabulary and plain English, lowercased, any other word written `*`, the separators `-`, `_`, `.` and spaces kept between them; a string holding any other character, or longer than 64, `withheld` whole. A field's name as it is when `DIAGNOSTIC_FIELDS` lists it, the proto's and `loadCodeAssist`'s, else its camel-cased words under the same rule. A fraction only from 0 to 1, to the ten-thousandth, else `not a fraction`; `disabled` only `true` or `false`, else `not a boolean`; no other number, no description, no tier's name. So a token, an email, a telephone number or a project reaches the error only as far as it is made of those words; and should any part, reduced to letters and digits, still hold the project, that part is withheld whole. 500 characters of `loadCodeAssist`'s part, 1,500 of the summary's and 1,500 of the per-model quota's at most. |
| A window whose reset has passed | 0 % and no reset, until the next read. |
| `GET /api/limits` | `limits`: by base profile, its `windows` (`kind` `five_hour`, `weekly` or `period` — a billing period, a month or a year —, `usedPercent`, `resetsAt`), `plan`, `checkedAt`, `stale`, `error`. Empty when the server cannot read them. `GET` only. |
| Configuration | `POD_IP`, the server's own address, and `GATEWAY_CA_FILE`, the gateway's root. Without `POD_IP` or the gateway, no limits. |

The server reaches the gateway on port 3000, and the gateway accepts it beside the sandboxes. The
windows are the whole account's: they count what the operator spends elsewhere too.

**Google's answer.** No one here holds the Google login, so its shape comes from agy and from public clients that read
it. agy 1.5.13 — the image's binary, its sha256 `7fa9cc6d…d4b2` — carries the descriptor of
`google/internal/cloud/code/v1internal/quota_summary.proto`: `RetrieveUserQuotaSummaryRequest {project}`,
`RetrieveUserQuotaSummaryResponse {buckets (deprecated), groups, description}`, `QuotaSummaryGroup {displayName, description,
buckets}`, `QuotaSummaryBucket {bucketId, displayName, description, window, oneof remaining {remainingFraction,
remainingAmount}, disabled, resetTime}`, `resetTime` a Timestamp — RFC 3339 in JSON. A Google AI Pro account's answer, captured
on 2026-10-20 by token-monitor (github.com/Javis603/token-monitor, `tests/fixtures/antigravityQuotaSummaryArgon.json`), has
three groups: Gemini Models (`gemini-weekly`, `gemini-5h`), Claude and GPT models (`3p-weekly`, `3p-5h`), Gemini 4 Argon
(`gemini-argon-wtu-weekly`); `window` `5h` or `weekly`; untouched buckets at `remainingFraction` 1 reset at the request's
time plus their window. A live test logged in CVERInc/clikae #159 (2026-09-27): `retrieveUserQuotaSummary` answers 403 to
`{}` and to a User-Agent not naming Antigravity, 200 to `antigravity`; `loadCodeAssist` names `cloudaicompanionProject` when
the request says `ideType` `ANTIGRAVITY`. With another project than the account's, the Gemini group is missing
(pingdotgg/t3code #21020). `remainingFraction` sits in a oneof, so proto3's JSON writes it even at 0.

The other shapes read, each with its source. Wrapped in `response` or `summary`: CodexBar's reader
(github.com/steipete/CodexBar `9699239`, `AntigravityQuotaSummaryParser.swift`) and token-monitor's (`61032c0`,
`src/shared/providers/antigravity/probe.js`, `quotaSummaryWindows`). The top-level `buckets`: the proto's deprecated
field 1. The window named by `window`, else `bucketId`, else `displayName`, with `session`, `5-hour`, `five hour`,
`five-hour` beside `5h`, `_` as `-`, a trailing ` limit` or ` limit remaining` dropped: token-monitor's
`quotaBucketKind` and CodexBar's cadence aliases (its tests: `gemini-session`, `gemini_session`, `gemini-5h limit`,
`gemini-session-history` no window); names alone, "Weekly" and "Five-Hour": pingdotgg/t3code #21020. The oneof as
protobuf-es writes it, `remaining`: both readers. Two buckets of one window, the more spent: token-monitor's
`collapsePools`. `remainingAmount`, a count with no total to make a percentage of, is read at 0 alone, as nothing left.
A bucket with a reset time and neither, spent: Omarchy's `used` (below), and t3code #21020 (closed, not merged), both
read it so — proto3 JSON leaves a zero out of an answer written without the oneof's choice; one with neither and no reset
time gives none. Snake case (`remaining_fraction`, `reset_time`), a fraction written as a string, every top-level bucket
when there is no group: Omarchy's `used` and `extract_limits` too.

**Omarchy.** Omarchy (github.com/basecamp/omarchy, `cafb698`, 2026-11-27) reads Gemini's limits with agy's sign-in:
`bin/omarchy-agent-usage-agy`, lines 249–489 — `used`, `project_body`, `extract_limits`, `extract_model_limits`, `post`,
`collect_limits` —, its tests `test/shell.d/agent-usage-agy-test.sh`, its summary's tests at `7278346`
(`test/shell.d/agent-usage-agy-limits-test.sh`, removed by `0fae8e6`), its doc `shell/plugins/agents/README.md`. Its
finding: "Google AI Ultra omits Gemini from retrieveUserQuotaSummary (its summary lists only Claude and GPT), while
retrieveUserQuota still reports every model's 5-hour bucket". When the summary's Gemini group gives no 5-hour or weekly
window, it `POST`s `v1internal:retrieveUserQuota` with the same `{project}` body and takes, of the buckets whose
`modelId` (after `models/`) begins `gemini`, the fullest as the 5-hour window, the earliest reset among equals, without the
rolling reset Google gives an untouched bucket; a 400 or 404 there means no fallback, another status a failed check. The
answer's shape, `RetrieveUserQuotaResponse {buckets: [{remainingAmount, remainingFraction, resetTime, tokenType,
modelId}]}` for `RetrieveUserQuotaRequest {project}`, is gemini-cli's too (github.com/google-gemini/gemini-cli
`60f8082`, `packages/core/src/code_assist/types.ts`, lines 250–265). Agora reads both as Omarchy does but where the
mapping below says otherwise.

**The cluster's account.** Its login is agy's, on agy's own OAuth client (`1071006060591-…`, "Antigravity"), a consumer
sign-in. With that client, CodexBar #4293 measured `loadCodeAssist` answering `free-tier` and Google's shared project
`aicode-consumers` for consumer accounts, the summary then holding the Gemini Models and Claude and GPT models groups;
with agy's other client (`884354919052-…`), no tier, no project, `ineligibleTiers` `free-tier`
`GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT`, and a placeholder All Models group, every fraction 1 and no window. t3code #21020
measured the summary for `aicode-consumers` holding the Claude and GPT models' week alone, the Gemini group missing.
Production's first read (2026-11-27, #249): both requests 200, a project named, no Gemini window — t3code's shape, the
shared project's, the likeliest; and still none after #252 (2026-11-28). Omarchy's Ultra summary is that shape too,
Claude and GPT alone, with Gemini's 5-hour bucket in the per-model quota: what Agora now reads.

| Mapping | Why |
| --- | --- |
| The Gemini group only | `antigravity` is the Google AI subscription for Gemini; the Claude and GPT models' group and Argon's are other quotas, which a single 5-hour and weekly pair cannot hold. |
| By `window`, else `bucketId`, else `displayName` | The proto's `window` names the window; the public readers fall back on the id and the name, which also say it, the identifiers being the stable part. A bucket is Gemini's by its group's name or its id: the Argon bucket's id begins `gemini-` too, so Argon is named apart. |
| `remainingFraction` 1: no reset | Google gives an untouched window the request's time plus its length, which moves at each read: no window has started, as z.ai's `nextResetTime` absent. |
| The daily host | agy's own (`--cloud_code_endpoint`); the production host answers Gemini's 5-hour bucket at 1, its reset moving, whatever is used (Javis603/token-monitor #722). |
| The per-model quota's fullest Gemini bucket: the 5-hour window | Omarchy's reading. Each model's bucket is its own 5-hour allowance; the fullest is the one that stops first. It has no week. |
| Argon's models left out of the per-model quota | Omarchy counts every `gemini` model; Argon is a quota of its own in the summary (token-monitor's capture), so it is left out here too. |
| No window after a 400 or 404: a failed read | Omarchy shows the account healthy without a meter; Agora's header has no such state, and a read with no window fails, naming what the answers held. |
| Claude and GPT's allowance not shown | Omarchy shows it once touched, never standing in for Gemini; Agora's windows are one 5-hour and one weekly pair per account, Gemini's. Never standing in: the same. |
| The Gemini group by its exact name, `Gemini Models` or `Gemini` | Omarchy takes the first group whose name holds `gemini`: Gemini 4 Argon's, listed first, would stand in. |
| Top-level buckets: with a group, those whose id says Gemini; without, all but `3p`'s | Omarchy reads them only without a group, and then all: the id is the proto's identifier, and `3p-` is Claude and GPT's (token-monitor's capture). |
| Two buckets of one window: the more spent | Omarchy keeps the last; token-monitor's `collapsePools`, and the window stops at the first. |
| A fraction outside 0 to 1: none | Omarchy clamps it; it is no fraction, and a number of the account's — a project's — could be one (C89). |
| No project: the summary not asked | Omarchy then asks with `{}`; agy's request names the project, and Google answers it with one alone (CVERInc/clikae #159: 403 to `{}`). |
| agy's `User-Agent` and `loadCodeAssist` body | Omarchy sends `User-Agent: antigravity` and `{}`; Agora sends what agy 1.5.13 sent, measured (C71), which Google answers 200 in production. |
| What is not seen | No answer with the cluster's login is seen here: its tier, its project, and whether its summary has the Gemini group come from the read's error, which names them. |
**Xiaomi's answer.** No one here holds the key, so its shape comes from Xiaomi's documentation, "Query Token Plan
Credits" (mimo.mi.com/docs/en-US/api/asset/credits-get, read on 2026-11-27): `GET /v1/platform/token_plan`, no
parameter, `Authorization: Bearer` a dedicated `tp-` key, on the host of the subscription's region — `token-plan-cn`,
`-sgp` or `-ams.xiaomimimo.com`; the operator's is the European one. Its example: `{"object": "token_plan", "plan_code":
"pro", "period": {"start_at": "2026-09-21 23:59:59", "end_at": "2027-09-21 23:59:59"}, "quota": {"total_credits":
10000000, "used_credits": 1500000, "remaining_credits": 8500000}, "auto_renew": false, "claw_enabled": false}`, the times
UTC. A public client reads it so: CodexBar (github.com/steipete/CodexBar, `Sources/CodexBarCore/Resources/Plugins/mimo.ts`,
#5138), from a live read on a Singapore account (#5124). Without a key, the path answers 401 `invalid_api_key` on each of
the three hosts. Xiaomi's plans have no 5-hour, daily or weekly limit: their one window is the billing period.

## What the template adds

| Element | Value |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | `/etc/agora/credential-proxy/ca.pem`, from the `credential-proxy-ca` ConfigMap: "Agora gateway CA", valid until 2028. |
| `GIT_SSL_CAINFO` | The same file, for git, whose libcurl does not read `NODE_EXTRA_CA_CERTS`. The gateway's root alone: everything goes through it. |
| git identity | `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` `agora-contributor[bot]`, `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` the App's noreply address, `<bot id>+agora-contributor[bot]@users.noreply.github.com`: GitHub shows the commit as the App's. |
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
| C10 | A claim on a warm Pod, the Create naming `github:A:read` | Before `initialize`, a token naming the execution, with `anthropic`, `github:A:read`, `agora:read` and `previews`; the tunnels of the warm token closed. |
| C11 | A warm token being handed over when the claim binds the Pod | The execution's token is the one in place; no warm token after it. |
| C12 | An execution whose token would expire less than half its life after the deadline the next prompt sets | A new token before the prompt leaves; the previous tunnels kept, then closed 30 s before it expires; no request refused for an expired token during the turn. |
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
| C31 | `GET /api/limits` on the server in the cluster, its pools declaring `anthropic`, `chatgpt` and `zai` | For each but `zai`, not read, its 5-hour and weekly windows from the provider, and for `xiaomi`, no pool's, its billing period, `stale` false; no `zai`; the gateway logs a request per account read from the server, under the `limits` grant; a second request within 5 minutes reaches no provider. |
| C32 | The grant the server signs for the limits | Bound to the server's address; on the exact path of each usage endpoint, its method alone — `GET`, or Google's three `POST`s; another path, a query, or another method of the same host: not covered. |
| C33 | A Create naming `limits` | Refused, `unknown_profile`; nothing written. |
| C34 | `GET /api/limits` twice at once, again within 5 minutes, then after; pools with base profiles with and without an endpoint, `zai` among them, as in production; a `POST`; the server without an address | One read per account with an endpoint, through the gateway with the `limits` grant, `zai` never asked nor in `limits`, its endpoint kept; nothing more within 5 minutes; read again after; 405; `limits` empty. |
| C35 | A read failing after one that succeeded; an account never read; a window whose reset has passed | The earlier windows, `stale`, the reason; no window, `stale`, the reason; that window at 0 % with no reset. |
| C36 | Each provider's answer, as given on 2026-10-07, Google's as captured on 2026-10-20 ("Google's answer"); Google's with a window spent, a bucket disabled, a bucket without its fraction nor a reset, one without its fraction with a reset; an answer of another shape | Their 5-hour and weekly windows in percent with their resets, and the plan; z.ai's 5-hour without a reset, its MCP limit left out; Google's Gemini group alone, its untouched 5-hour at 0 % without a reset, its week at 0.76 % with its reset, the disabled bucket and the one with neither fraction nor reset left out, the one with a reset at 100 %; no window. |
| C37 | A read through a gateway, the tunnel accepted, then refused; a `POST` with a body | `CONNECT` with the grant as `Proxy-Authorization`, TLS to the host, the placeholder `Authorization` and the endpoint's headers; the answer read. Refused: an error naming the status. The `POST` reaches the host with its body, `content-type: application/json`. |
| C38 | Public GitHub: `internet` alone, the mock's `/fetch` of `api.github.com/repos/A`, of `/rate_limit`, of git's refs and `git-upload-pack` on A; then a `PATCH` of A and the first request of a push; then the same read with `anthropic` alone | GitHub answers each read, the gateway logging `github-api-public` or `github-git-public`, the rate limit an installation's; the write and the push: 403 from the gateway; without `internet`: 403. |
| C39 | `x-gateway-grant: covered` sent by the sandbox with `internet` alone: a read of a public repository, a write on an offered one | The read through `github-api-public`; the write: 403 from the gateway. |
| C40 | A real git client with `internet` alone: `git ls-remote` and `git clone --depth 1` of a public repository, of an offered one not granted; then `git push` to it | The refs and the clones; the push refused, 403 from the gateway, no branch on GitHub. |
| C41 | The grants of `vault:read` and `vault:write`; a pool declaring either; `vault`, `vault:admin` | Only `vault.bretagne.dev`, `POST`, `GET` and `DELETE` on `/mcp` exactly: another path, method or host not covered, no grant on `*`; neither a base profile, the pool refused; the others `unknown_profile`. |
| C42 | Each of the vault's tools, and its prompt, under `vault:read` then `vault:write`, replayed with the `vault` route's two rules; a tool the server would add; `tools/list` | Read: the six read tools covered, the six write tools and the prompt not. Write: all twelve and the prompt. The added tool: write only. The list filtered to what each covers. No other profile names a tool. |
| C43 | An execution with `vault:read`, one with `vault:write`; one with other profiles, one with none | `session/new` names the vault's server, `http`, `https://vault.bretagne.dev/mcp`, no header, then Agora's, the default profiles' ("MCP servers"); for the other two, Agora's alone. |
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
| C54 | `kubectl version --client` in the claude-code, codex, opencode and antigravity images | 1.36.5. |
| C55 | The grants of `previews`; a pool declaring it; neighbouring hosts | `pr-<n>-<app>.preview.bretagne.dev` covered, every method and path; the neighbours listed in "Previews" not; no other route's rule and no `internet` grant covers it; not a base profile, the pool refused. |
| C56 | Through the gateway and a gateway gate, `previews` with the judge's other profiles: a `GET` with a query and a `POST` with a body, the sandbox sending its own `Authorization` and `X-Forwarded-User` | Both answered by the app, the body passed. The app receives `X-Forwarded-User` and `X-Forwarded-Email` `client-<id>`, `Authorization: Basic` of `client-<id>:none`, `x-agora-gate: gateway`; never the gateway's token, nor what the sandbox sent. |
| C57 | `previews` alone to `a.b.preview.bretagne.dev`, `pr-42-demo.x.preview.bretagne.dev`, `x.preview.bretagne.dev`, `x.bretagne.dev`, `preview.bretagne.dev.evil.com`, `pr-42-demo.preview.bretagne.dev.evil.com`; a preview with `anthropic` alone, with `internet` and a repository, and with `previews` from another address | 403 from the gateway each time; the app receives nothing; `previews` from its own address: answered. |
| C58 | Straight to a gateway gate: the gateway's token; another client's; another client's claiming the gateway's audience; an `admin`'s token for the gateway's client; the gateway's expired; no token. The gateway's token to the browser gate | Only the first passes; the others 401 or 403, the app receiving none. The browser gate: 302 to Pocket-ID's sign-in, not the app. |
| C59 | The gateway gate's identities swapped, as the kubelet updates a ConfigMap, without `client-<id>`; then with it | The gateway's tokens, a fresh one included, refused — through the gateway too; then taken again. |
| C60 | The gateway's credential replaced while a response from the app is under way | That response ends whole; the next request carries the new credential. |
| C61 | In the cluster, the route and the gateway gate deployed, a preview open: the judge with `previews`; a browser without a session; the client `agora_gateway_previews` asked for a device code and an authorization code | The judge reaches the preview's app through the gateway gate; the browser is sent to Pocket-ID by the browser gate; Pocket-ID gives no user token for the client. |
| C62 | In Pocket-ID, `agora_gateway_previews` given a second secret, a token asked with each; the first secret deleted; then the client deleted | A token for each while both exist; once the first is deleted, it is refused and the second still answered; once the client is deleted, neither; the tokens already issued still taken by the gateway gate until they expire, and refused once `client-<id>` is out of its identities. |
| C63 | The grant of `agora:read`; a pool declaring it; `agora`, `agora:write` | Only `mcp.agora.internal`, `POST`, `GET` and `DELETE` on `/mcp` exactly: another path, method or host refused; never the Internet's grant, which opens nothing of it; not a base profile; the others unknown. |
| C64 | The grants of `agora:delegate` and `agora:submit`; an execution with either | `agora:read`'s grant each; `session/new` names the server `agora` once, with them both or with `agora:read` too. |
| C65 | A Create, then a Scope, naming `agora:submit`; a delegate | `unknown_profile` both times; the delegate's execution holds `agora:submit`, given by Agora. |
| C66 | The person, in a delegate: a Scope, then once its execution ended a Create, each keeping the `agora:submit` it holds | Both accepted, the profile kept. |

**To be specified:** a harness initializing in the pool (claude-code's SDK); count the responses
to `CONNECT` by status, not just the last one; read access to GraphQL.
| C67 | The grants of `github:A:review`, `github:A:read`, `github:A:write`; requests on A and elsewhere, with each and with two of them | Review: every REST method on A and its clone and fetch, as the reviewer, never a push; read and write as the contributor; write and review on A: the contributor; read and review: the reads as the contributor, a review as the reviewer; nothing elsewhere but through the public routes. |
| C68 | `github:A:write` offered, then `github:A:review`; Creates naming A's review, read, write | Write offered: all three accepted; review offered: review and read, the write `profile_not_offered`. |
| C69 | The gateway as deployed, a stand-in GitHub: write on A, review on B, `internet`, each request with forged `x-gateway-grant` values too | A's requests reach GitHub with the contributor's token, B's review with the reviewer's, a public read with the public token; a review grant never sends the contributor's token, nor a write grant the reviewer's; the forged header changes nothing; no request carries the operator's credential. |
| C70 | In a real execution: `github:A:write`, a branch pushed and a pull request opened; another with `github:A:review` approving it; then the contributor merging | The commit and the pull request by `agora-contributor[bot]`, the approval by `agora-reviewer[bot]`, which makes it mergeable; the merge refused by GitHub to both Apps; the operator's accepted. |
| C71 | The grants of `antigravity`; requests on Cloud Code, `www.googleapis.com`, Google's token endpoint, its telemetry and its other APIs | `daily-cloudcode-pa.googleapis.com` on `/v1internal:<method>`, any query; `GET www.googleapis.com/oauth2/v2/userinfo` exactly; every other path, method and host refused — `/v1internal`, `/v1internal:loadCodeAssist/x`, a `POST` or a query on the user info, `/oauth2/v3/tokeninfo`, `/drive/v3/files`, `oauth2.googleapis.com/token`, `play.googleapis.com/log`, `cloudcode-pa.googleapis.com`, `generativelanguage.googleapis.com`; no grant on `*`. A base profile. |
| C72 | In the cluster, the routes deployed and the login renewed: the mock's `/fetch POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` and `/fetch https://www.googleapis.com/oauth2/v2/userinfo` with `antigravity`; `/fetch POST https://oauth2.googleapis.com/token` and `/fetch https://www.googleapis.com/drive/v3/about` with `antigravity` alone, then with `internet` too | 200 from Google for the first two, the account's tier and its email, with the token the gateway set; the others 403 from the gateway, then answered by Google without the credential: never the login's token on them. |
| C73 | agy on the placeholder, a Session open: `antigravity-token` replaced; then emptied, a turn; then filled again, a turn | The next request carries the new token; emptied, the turn ends on Google's 401, no request to `oauth2.googleapis.com`, no browser, the token file unchanged; filled again, the turn answered. |
| C74 | A person's Create naming `github:A:read`, one naming no profile; a `spawn_agent` giving `internet`, within its delegator's rights | Each execution's profiles its own, then `agora:read` and `previews`, each once: recorded with its Create, in the log's `profiles`, in its token's `profiles` beside its pool's base profiles, and in its bridge's `~/.agora/access.json`; the delegate's `internet`, `agora:submit`, `agora:read`, `previews`. |
| C75 | `OFFERED_PROFILES` listing `previews` and `agora:read` with others, then the others alone: the server started each time; Creates and Scopes naming the defaults, then one beside a profile not offered, one beside a profile the catalogue does not know | The server starts both times; `GET /api/config` offers the others alone, the same both times; the defaults accepted as named; then `profile_not_offered` and `unknown_profile` as before, nothing written. |
| C76 | An execution of a pool declaring `anthropic`, that pool replaced in the catalogue by another of its harness declaring `chatgpt`: a prompt, then a Scope; another execution, Agora restarted once its pool is replaced, then a prompt | `anthropic` recorded with the Create; no new token before the prompt, the Scope's `anthropic` and the Scope's own. After the restart, a token before the prompt, naming `anthropic` and the execution's own. Never `chatgpt`. |
| C77 | An execution whose Create recorded no base profiles, its pool listed and declaring `anthropic`; another, its pool replaced: Agora restarted, then a prompt in each | A token naming `anthropic` and the execution's own; the other's naming its own alone. |
| C78 | Two executions, the pool of one declaring `anthropic`, of the other nothing; both pools declaring `chatgpt` since; Agora restarted, then a prompt in each | Each token names what its Create recorded and the execution's own, as before: `anthropic` for one, no base profile for the other, never `chatgpt`. |
| C79 | `OFFERED_PROFILES` naming `anthropic`, `zai`, `chatgpt` or `antigravity`, each beside other profiles; a signer given one; the offer without them | The server stops at start, the signer refused, for each, as for a profile the catalogue does not know; each never offered (`offers` false), even listed; the others offered as before, `GET /api/config`'s `offered` without a base profile. |
| C80 | A pool declaring `anthropic`; a Create, a Scope and a `spawn_agent` naming `anthropic`, `zai`, `chatgpt` or `antigravity`, `OFFERED_PROFILES` empty, then listing other profiles; the same Create without it | Each `unknown_profile`, nothing written — no Create, no Scope, no Workstream, no approval —, no token handed; the Create without it accepted, its `baseProfiles` `anthropic`, its token naming `anthropic` and its own profiles. |
| C81 | An execution living past its first token's life, a command left running after its turn | A new token before each one expires, with the same profiles; every deadline Agora sets at least half a token's life before the end of the token in place; the bridge holding the last. |
| C82 | A token renewed — the same `sub` and `grants` — while a tunnel is open; then one with other grants | The tunnel opened with the previous token stays open, and closes 30 s before that token expires; later tunnels carry the new one. The other grants close the open tunnels at once. |
| C83 | The `limits` grant on Google: the quota summary, `loadCodeAssist` and the per-model quota with `POST`, with `GET`, `PUT`, a query, a suffix, a prefix of a path; agy's other calls, inference; Google's other hosts | Three grants on `daily-cloudcode-pa.googleapis.com`, `POST` alone, on `^/v1internal:loadCodeAssist$`, `^/v1internal:retrieveUserQuotaSummary$` and `^/v1internal:retrieveUserQuota$`; everything else not covered; no other `POST`, no grant on the Internet. |
| C84 | Google's read: `loadCodeAssist` naming a project, as a string then as an object; naming none; answering 403 | `POST /v1internal:loadCodeAssist` with agy's metadata, then `POST /v1internal:retrieveUserQuotaSummary` with `{project}`, both as `antigravity/1.5.13 linux/amd64`, the token `agora limits`; the windows read. Without a project or with a 403: the summary not asked, no window, `stale`, why — the tiers and fields `loadCodeAssist` answered. |
| C85 | Xiaomi's answer as its documentation gives it ("Xiaomi's answer"); a month of a Lite plan part spent; no credit; more used than the total; an end it cannot read; another `object` | One window, `period`: 15 % until `2027-09-21T23:59:59.000Z`, the plan `pro`; used over total, unrounded, until its end; no window and no plan; 100 %; no reset; no window. |
| C86 | The `limits` grant on Xiaomi: the Token Plan's credits with `GET`, with `POST`, `DELETE`, a query, a suffix; inference; Xiaomi's other regions and hosts; the profile `xiaomi` | One grant on `token-plan-ams.xiaomimimo.com`, `GET` on `^/v1/platform/token_plan$`; every other request not covered; no grant on the Internet; `xiaomi` no base profile, refused like `limits`. |
| C87 | Pools declaring `chatgpt` and a repository's profile; then `anthropic` and `xiaomi`; then none | `chatgpt` and `xiaomi` read, `xiaomi` on `token-plan-ams.xiaomimimo.com` `/v1/platform/token_plan` under the `limits` grant, its billing period at 15 %; Claude not asked. Then `anthropic` and `xiaomi`, two requests. Then `xiaomi` alone. |
| C88 | Google's Gemini buckets in the other shapes ("Google's answer"): in `response`, in `summary`; the top-level `buckets`; other ids, the window from `window`, `_`, names alone; two buckets of one window; the oneof as `remaining`; Claude and GPT's and Argon's groups, `daily`, `gemini-session-history`, a `remainingAmount` not 0, a fraction above 1 or below 0, All Models | The same windows as the bare answer; Gemini's alone; the windows; 10 % and 20 % from "Five-Hour" and "Weekly"; the more spent; 75 % and 50 %; no window for each of the last. |
| C89 | Google's summary with no Gemini window, the per-model quota answering 404: the shared project's, Claude and GPT's week alone, a free tier with a paid tier, an email, the project and a token in a bucket's name and id; the account's own project in a bucket's id, All Models' placeholder; `loadCodeAssist` with no project and the tier it refuses. Then an email, a token and the project in every place the error looks, `disabled` a string and an array; an opaque token across separators, a telephone number, the project as a number in a fraction and in the oneof; a project made of Google's words; a summary that is not JSON; 200 answers of random strings in every place and as keys | No window, `stale`; the error naming the tiers' ids, the shared project, the fields, each group and bucket, Google's words lowercased and every other word `*`, a string with another character `withheld`; `ineligibleTiers` `free-tier` `google_tos_not_supported_by_client`; `disabled not a boolean`, `not a fraction`; the summary's part `withheld, as it would hold the project`; `retrieveUserQuota answered 404` last; `daily-cloudcode-pa.googleapis.com answered no JSON to /v1internal:retrieveUserQuotaSummary`; for the random answers, the per-model quota random too or a 400, no run of letters or digits in the error but the error's own words, `DIAGNOSTIC_WORDS`, `DIAGNOSTIC_FIELDS` and a fraction's digits, no piece of five sent with a digit in it. |
| C90 | Omarchy's answers (`test/shell.d/agent-usage-agy-test.sh` at `cafb698`): Google AI Ultra's summary, Claude and GPT alone, and its per-model quota — Claude's, `tab_`'s and Gemini's models, two Gemini buckets equally spent; an untouched Gemini bucket; a summary with its Gemini group; the per-model quota answering 404, 400, then 500 after a read; a per-model quota with no Gemini bucket it reads, an email in a model; a project of Google's words in a model; not JSON | `retrieveUserQuota` asked after the summary, with the same `{project}` and headers; the 5-hour window at 15 %, the earlier reset; 0 % without a reset; `retrieveUserQuota` not asked; no window, `stale`, the error ending `retrieveUserQuota answered 404` (`400`); the windows before, `stale`, `answered 500 to /v1internal:retrieveUserQuota`; the error naming each bucket's model in Google's words, its fraction, `disabled`, its fields, the email `withheld`; that part `withheld, as it would hold the project`; `answered no JSON to /v1internal:retrieveUserQuota`. |
| C91 | Omarchy's summaries (`test/shell.d/agent-usage-agy-limits-test.sh` at `7278346`, lines 75–130): Gemini's and Claude and GPT's groups; the Gemini group listed second; top-level buckets in snake case without a group, a fraction `plenty`, an infinite one; one without its fraction with a reset, one with neither; the amount arm at 800 and at 0, a disabled bucket; answers of another shape; another group's buckets not a list; the oneof's amount at 0 | 10 % and 5 % with their resets, Claude and GPT's left out; the week at 50 %; the 5-hour at 60 % alone; the 5-hour at 100 % alone; the week at 100 % alone; no window; the 5-hour at 50 %; 100 %. |

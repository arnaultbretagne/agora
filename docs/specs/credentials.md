# An execution's credentials

Contract to implement — agentgateway **1.5.0**, on top of the executions contract
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
| 403 from the gateway | None of the execution's grants covers this host, path and method. A host with no route of its own falls to the `internet` route: refused without `internet`. |
| 404 from the gateway, on `CONNECT` | A port other than 443: the gateway serves HTTPS on 443 only. |
| 503 from the gateway | The host cannot be reached: its name does not resolve, or the connection fails or times out — as it does for a private address, which the network keeps out of the gateway's reach. |
| TLS refused by the gateway (`access denied`) | An IP address instead of a name: the gateway issues certificates for names only. |

## The bridge

| Element | Rule |
| --- | --- |
| `PUT /credentials` | With Agora's token. The body gives the proxy (`host:port`), the token and its expiry. Replaces the previous token and closes the tunnels opened with it: later tunnels use the new one. |
| `GET /info`, `outbound` field | Proxy, expiry, when the credential was attached, number of tunnels, number of refusals, and for each target the number of tunnels and the last response to the `CONNECT`. Never the token. |
| Adapter's environment | `HTTPS_PROXY` and `https_proxy` set to `http://127.0.0.1:<port>`, `NO_PROXY` set to `localhost,127.0.0.1`, `NODE_USE_ENV_PROXY` set to `1` so that Node's own `fetch` goes through it too. Everything the agent runs inherits it. |
| The agent's access | At each `PUT /credentials`, before answering: the token's claims — its payload as JSON, never the token or its signature — written to `~/.agora/access.json`, replacing the previous ones as a whole, in the order the tokens came. A token whose claims cannot be read removes the file. |
| What is relayed | `CONNECT` only. An `http://` request is refused (501): the gateway serves HTTPS only. |

## Profiles and grants

An execution receives a list of **profiles**. Agora compiles them into **grants**: a host, a
regular expression anchored on the path and query, methods. The catalogue lives in Agora's code
(`packages/credentials`).

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything. |
| `zai` | `api.z.ai`, everything: z.ai's OpenAI- and Anthropic-compatible APIs. |
| `chatgpt` | `chatgpt.com`, only `/backend-api/codex…` and `/backend-api/wham…`: what codex uses. The session reaches the whole ChatGPT account, conversations included. |
| `internet` | `*`, everything: any host with no route of its own, with no credential set. Public addresses, HTTPS on port 443. |
| `github:owner/repo:read` | REST API `/repos/owner/repo…` with `GET` and `HEAD`; git `git-upload-pack` only (a clone also sends a `POST`). |
| `github:owner/repo:write` | REST API `/repos/owner/repo…`, all methods; git `git-upload-pack` and `git-receive-pack`. |

Grants are additive. GraphQL (`/graphql`) is covered by no profile.

`internet` never opens a host that has a route of its own: those routes compare the grant's host
with the request's, and only the `internet` route reads `*`. So a public repository outside the
execution's `github` profiles stays closed — `github.com` has its own route, and its credential.

### Base profiles

What a harness needs before any execution — its SDK initializing, for instance — is declared on
its pool, the `SandboxWarmPool`, in the annotation `agora.bretagne.dev/base-profiles`: profiles
separated by commas. Only profiles the catalogue marks as base may be declared: those naming a
service — never a repository, nor `internet`.

| Profile | Base |
| --- | --- |
| `anthropic` | Yes |
| `zai` | Yes |
| `chatgpt` | Yes |
| `internet` | No |
| `github:…` | No |

A pool without the annotation, or declaring a profile that is not a base one, gets no warm token;
the catalogue (`GET /api/pools`) shows its base profiles, or the refused one.

### Offered profiles

What an execution may be given beyond its pool's base profiles is declared on Agora, in
`OFFERED_PROFILES`: profiles separated by commas, each at the widest access it may be given. The
interface offers these (`assistant-ui.md`, "Access"); a Create or a Scope may name an offered
profile, or a narrower one of the same repository.

| Offered | May be named |
| --- | --- |
| `github:owner/repo:write` | `github:owner/repo:write`, `github:owner/repo:read` |
| `github:owner/repo:read` | `github:owner/repo:read` |
| `anthropic`, `zai`, `chatgpt`, `internet` | Itself |

Anything else is refused (`profile_not_offered`). Without the variable, any profile of the
catalogue may be named, and the interface offers none. A profile the catalogue does not know stops
the server at start.

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

The routes with a credential share one authorization rule: the request comes from the JWT's
`ip`, the path contains no `..`, `.`, `%2e` or `%2f`, and one of the JWT's grants covers the
host, the path with the query, and the method. If the rule fails, the request stops at the gateway; otherwise the gateway sets the
host's credential.

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
| `github-api` | `api.github.com` | `Authorization: Bearer` + the GitHub PAT. |
| `github-git` | `github.com` | `Authorization: Basic` + `x-access-token:` and the PAT, in base64. |
| `internet` | Any other | None. |

The PAT must reach every repository offered, with the access offered: the grants only narrow it.

The `internet` route can name any host, so the network bounds it: the gateway goes out to public
IPv4 addresses only, on port 443. The private ranges — `10.0.0.0/8`, `100.64.0.0/10`,
`169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16` — hold the operator's networks and the
cluster: a name resolving there times out (503); an address written as such is refused at TLS.

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
| C24 | `internet` alone, the mock's `/fetch` to `api.anthropic.com`, `api.z.ai`, `chatgpt.com`, `api.github.com/repos/A`, git on `github.com/A`; then `github:A:read` added | 403 from the gateway for each; then GitHub answers for A. |
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

**To be specified:** a harness initializing in the pool (claude-code's SDK); count the responses
to `CONNECT` by status, not just the last one; read access to GraphQL.

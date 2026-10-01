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
| 4 | Adapter | Trusts that authority through `NODE_EXTRA_CA_CERTS` and sends its request. |
| 5 | Gateway | Checks the JWT and the grants. Sets the host's credential in place of the `Authorization` it received, keeps the other headers, forwards to the host. |

| Response | Meaning |
| --- | --- |
| 503 from the bridge, on `CONNECT` | No credential attached to this execution. |
| 502 from the bridge, on `CONNECT` | Gateway unreachable. |
| 401 from the gateway | JWT missing, expired or signed by another key. |
| 403 from the gateway | None of the execution's grants covers this host, path and method. |
| 404 from the gateway | Host with no route. |

## The bridge

| Element | Rule |
| --- | --- |
| `PUT /credentials` | With Agora's token. The body gives the proxy (`host:port`), the token and its expiry. Installs the complete replacement and closes previous outbound tunnels, including connections still opening, before acknowledging success. Applied only while prompt admission is closed at a confirmed boundary. |
| `GET /info`, `outbound` field | Proxy, expiry, installation identity and owner, when the credential was attached, number of tunnels, number of refusals, and for each target the number of tunnels and the last response to the CONNECT. Never the token. |
| Adapter's environment | `HTTPS_PROXY` and `https_proxy` set to `http://127.0.0.1:<port>`, `NO_PROXY` set to `localhost,127.0.0.1`. |
| What is relayed | `CONNECT` only. An `http://` request is refused (501): it has no credential to carry. |

An installation is bound to the Pod UID, bridge instance and authorization owner. Agora orders
updates and the bridge rejects a stale owner or superseded installation. PUT acknowledgement
and GET /info identify the same applied installation, allowing Agora to establish the outcome
of a lost response. Neither installation metadata nor a retry exposes the JWT. Exact metadata,
conditional-update and error fields must be specified before implementing this extension.

Token installation and tunnel reset form one bridge operation: a concurrent CONNECT either
belongs to the previous installation and is closed, or uses the replacement. A successful
response cannot leave an old tunnel usable. The reset affects outbound connections only; it
does not restart the SDK, replace the ACP Session or close the ACP WebSocket.

## Profiles and grants

An execution receives a list of **profiles**. Agora compiles them into **grants**: a host, a
regular expression anchored on the path and query, methods. The catalogue lives in Agora's code
(`packages/credentials`).

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything. |
| `github:owner/repo:read` | REST API `/repos/owner/repo…` with `GET` and `HEAD`; git `git-upload-pack` only (a clone also sends a `POST`). |
| `github:owner/repo:write` | REST API `/repos/owner/repo…`, all methods; git `git-upload-pack` and `git-receive-pack`. |

Grants are additive. GraphQL (`/graphql`) is covered by no profile.

## Authorization lifecycle

Agora's credentials component issues and renews tokens for warm Pods as well as assigned
executions. It verifies the operator's pool/template catalogue and the actual Pod UID, image
digest and assignment through Kubernetes. A harness cannot select its own base profiles or
assert that a resource was provisioned. The grant policy lives in the reviewed catalogue;
tokens are created at runtime and stored only in the bridge's memory, never in an image,
template, claim, anchor or journal.

| Phase | Profiles | Identity and ownership |
| --- | --- | --- |
| Unassigned warm Pod | Reviewed base profiles of the selected harness image. For Claude Code, `anthropic`. | The Pod UID; managed by Agora's warmup authorization path. |
| Assigned execution, before the first prompt | Base profiles plus rights of resources actually provisioned and bound to this execution. | The execution, bound to that Pod/claim; managed by its driver. |
| Between turns | The full set recalculated from the current authorized bindings, including additions and removals. | The same execution; the dispatcher orders its applications and renewals. |

The `anthropic` profile covers the whole host, including inference. SDK preinitialization sends
no user prompt; its base profile is not a separate read-only initialization grant.

Warmup-to-execution ownership changes once, before the first prompt. Installation of execution
authorization supersedes the warm token and resets its tunnels. A delayed warmup update is
refused, including one minted before assignment but delivered after it. Warmup renewal ceases
for an assigned Pod. A used Pod is never returned to the pool.

Assignment during preinitialization also needs an ordered handoff: the driver cannot open a
competing SDK context or assume the warm process is compatible with the selected settings or
native restoration. Session readiness is established independently, as specified in
`executions.md`.

## Application between turns

Each turn uses one confirmed configuration. A resource change updates the desired authorized
profiles; its grants take effect before the next turn. Agora signs the entire recalculated set,
not an accumulation of tokens or a union with unverified old rights. The dispatcher in `log.md`
coordinates this operation with model and effort changes.

| Step | Required outcome |
| --- | --- |
| Wait for a boundary | The turn's final correlated answer is committed, with no saved, in-progress or uncertain turn or unresolved permission. Sending Cancel or observing a timeout is insufficient. |
| Keep Write closed | The pending change and application state are recorded; no next prompt can be accepted or dispatched during application. |
| Install authorization | Mint the execution's complete authorized set. The bridge installs it and closes the old outbound tunnels before acknowledging. |
| Apply settings | Apply the selected model, confirm it, then apply compatible effort and confirm it through ACP. Unchanged settings need no write. |
| Confirm readiness | Record the applied revision after all required acknowledgements and readback. Admit the next prompt only with that revision and sufficient token validity. |

The latest recorded desired revision is selected before application starts. Changes arriving
during application are ordered after it; a superseded revision cannot reopen admission while a
newer desired revision is pending. Changes after a prompt's admission apply to a later turn,
including when the admitted prompt is still saved and has not reached the harness.

Each stage can succeed independently. Failure or an unknown outcome keeps Write closed and
exposes the failed stage; it does not silently restore the previous rights or call a partially
applied configuration ready. After restart, Agora rechecks ownership and the actual installation
and settings before recording the applied revision. It never infers no effect from a missing
acknowledgement or resends a possibly dispatched prompt.

Reconnecting ACP to the same live bridge verifies and reuses its existing installation; it is
not a reason to mint a new token or reset outbound connections during a running or uncertain
turn. A missing or inadequate installation does not authorize a hidden mid-turn rotation.

An ordinary removal of rights takes effect at this boundary. It does not revoke an already
signed JWT or interrupt an admitted turn. An urgent halt uses Stop and its execution lifecycle.

## Token lifetime

Pool tokens are renewed while no execution owns the Pod. Execution tokens are renewed at a
confirmed idle boundary, including immediately before a new prompt after a long idle period.
Renewal uses the current authorized profiles and the same install/reset operation even when
the grants have not changed. It changes the installation identity, not the semantic settings
revision when their values are unchanged.

Immediately before prompt admission and again before its first dispatch, remaining token
validity must cover the full configured maximum turn duration plus a positive margin for clock
skew and dispatch delay. If this cannot be established, the prompt does not start. If validity
becomes inadequate after admission but before any dispatch attempt, record a local
`request.failed` with `credentials_expiring`, with no dispatch marker or transport write. Do not
rotate under that saved turn; a new user command is required. A possibly dispatched or uncertain
prompt is never treated as an idle boundary.

The margin's value must be specified and validated before implementation. A token's expiry is
not tied to the shorter sandbox lease, whose deadline can be renewed during a turn. A validity
failure is visible; no mid-turn reconnect or wider grant is used as a hidden fallback.

A harness with no authorized external services needs no JWT and keeps its outbound proxy
closed. Applying an empty authorized set clears the previous credential and closes its tunnels;
the clear operation belongs to the installation API extension. Credential-validity checks apply
only when the confirmed configuration requires external grants.

A terminal ACP reply does not certify that detached tools or subagents have stopped. Each
harness must establish its background-task/reset behavior before claiming this boundary safe.
If it cannot, application stays blocked or the execution must be stopped; the contract does not
promise uninterrupted detached tasks.

## The token

An EdDSA JWT signed by Agora's key (Secret `grants-key`), `kid` `agora-grants-1`.

| Claim | Content |
| --- | --- |
| `iss`, `aud` | `agora`, `agora-gateway`: required by the gateway. |
| `sub` | The warm Pod UID or the assigned execution (`agora <name>`), written in every gateway log line. Warmup and execution subjects are distinct. |
| `exp` | The duration requested when attaching, from 60 s to 24 h. |
| `jti` | One id per token. |
| `grants` | The compiled grants. |
| `profiles` | The requested profiles, for the record. |

The gateway reads it from the `Proxy-Authorization` of the `CONNECT`, which every request in the
tunnel sees (`source.connectHeaders`), and checks it with the JWKS from the `grants-jwks`
ConfigMap.

## The gateway

agentgateway in standalone mode, namespace `agora-gateway`, Service `gateway` port 3000
(`CONNECT`). Every tunnel to port 443 is terminated with the "Agora gateway CA" CA.

A single authorization rule, the same for every route: the path contains no `..`, `.`, `%2e` or
`%2f`, and one of the JWT's grants covers the host, the path with the query, and the method. If
the rule fails, the request stops at the gateway; otherwise the gateway sets the host's
credential.

| Route | Host | Credential set |
| --- | --- | --- |
| `anthropic` | `api.anthropic.com` | `Authorization: Bearer` + the operator's Claude setup-token. |
| `github-api` | `api.github.com` | `Authorization: Bearer` + the GitHub PAT. |
| `github-git` | `github.com` | `Authorization: Basic` + `x-access-token:` and the PAT, in base64. |

The credentials are in the SOPS Secret `upstream-credentials`, mounted as files. The gateway
watches these files: a rotation is a commit, with no restart. Verified: a replaced PAT was
reloaded about a minute after the merge, the time the kubelet takes to sync the Secret.

Every request leaves a log line: execution (`jwt.sub`), `jti`, method, host, path, status, and
the reason for a refusal.

## On Agora's side

| Element | Rule |
| --- | --- |
| `POST /api/executions/{name}/credentials` | Admin lab input: profiles and duration (3,600 seconds by default). It requests a change ordered at the next confirmed boundary; accepting a request is distinct from confirming its application. The request/response extension must preserve that distinction. Product rights are derived from authorized provisioned bindings, not browser-supplied profiles. |
| The token | Kept nowhere: not on the claim, not in memory after the call, not in the log. |
| After each turn | Agora reads the bridge's `outbound` field again: tunnels and responses become visible in the execution's state. |
| `GET /api/config` | `credentials` field: the gateway and the known profiles, or nothing. |
| Configuration | `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, and `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE`. Without `GATEWAY_PROXY`, no execution has a way out. |

The lab's explicit profile request exercises the same boundary contract. Warmup, assignment and
renewal use Agora's authorization lifecycle without an interface attachment step. Their
application evidence and API extensions are acceptance requirements measured separately below.

The claude-code image keeps `CLAUDE_CODE_OAUTH_TOKEN=agora-placeholder`. This value only puts the
CLI in OAuth mode: it then sends a Bearer and `anthropic-beta: oauth-…`. The gateway replaces the
Bearer and lets the rest through.

## What the template adds

| Element | Value |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | `/etc/agora/credential-proxy/ca.pem`, from the `credential-proxy-ca` ConfigMap: "Agora gateway CA", valid until 2028. |
| Network egress | DNS, and `gateway.agora-gateway` on port 3000. Nothing else to the Internet. |

On the other side, the gateway accepts only the sandboxes and goes out only on port 443.

## The model

The model is chosen over ACP: `session/set_config_option` with `configId` `model`, for example
`haiku`. It is sent after Session opening and confirmed before the first prompt, the first billed
call. Later model and effort changes follow the same between-turn boundary as grants. A
successful request alone does not substitute for the harness's required applied-value readback.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| C1 | Going out without a credential | The mock's `/fetch`: `CONNECT` refused, 503; one refusal counted. |
| C2 | The chain alone | `anthropic` profile, the mock's `/fetch https://api.anthropic.com/v1/models`: a response from Anthropic, neither a 403 from the gateway nor a TLS error. |
| C3 | Real harness | `anthropic` profile, claude-code on `haiku`: a real model response. |
| C4 | Composition | Profiles `github:A:write` and `github:B:read`. A: read, write, push; B: read and fetch, no write or push; C, GraphQL: refused. |
| C5 | A JWT missing, expired or signed by another key, sent straight to the gateway | 401 from the gateway. |
| C6 | Crafted paths (`..`, `.`, `%2e`, `%2f`) under a granted repo | 403 from the gateway. |
| C7 | A host with no route | 404 from the gateway. |

### Authorization lifecycle and rotation

The following cases are acceptance requirements. The earlier gateway runs and the
2026-09-30 startup measurements in `log.md` do not validate them. Code read at `bcd7643`:
PUT /credentials replaces credentials for future tunnels and leaves existing connections open;
the required installation/reset acknowledgement and automatic lifecycle remain unmeasured.

| # | Case | Expected | Measured |
| --- | --- | --- | --- |
| C1 | Unassigned Claude Pod receives base authorization | Anthropic allowed, GitHub refused; token issued for the Pod, no user prompt or execution grants. | Not measured. |
| C2 | Assignment races warmup or a delayed warm renewal | Execution identity and provisioned grants win; no later warmup install; compatible preinitialization and native restoration are handled without competing contexts. | Not measured. |
| C3 | Change requested during a turn | Desired state changes; current grants/model/effort and outbound tunnels stay unchanged until a confirmed end. | Not measured. |
| C4 | Add a repo on a reused GitHub host | Old tunnel closes before acknowledgement; the next turn reaches the added repo through a new CONNECT/JWT. | Not measured. |
| C5 | Remove write permission on a reused host | The next turn's write is refused by the gateway, read remains permitted; no old bridge tunnel can retain write access. | Not measured. |
| C6 | Concurrent change and Write | Dispatcher order selects one confirmed configuration for the admitted turn; no prompt enters an application interval. | Not measured. |
| C7 | Long idle period or insufficient token lifetime | Renew and reset before the next admission; validity covers the turn limit and margin. A failed renewal starts no turn. | Not measured. |
| C8 | Cancel sent, timeout or uncertain turn | No ordinary rotation until terminal evidence establishes the boundary; no prompt resend. | Not measured. |
| C9 | Install/reset acknowledgement lost or Agora restarts during application | Readback establishes ownership and applied state; admission stays closed until the application is durably confirmed. | Not measured. |
| C10 | Model succeeds, effort fails or readback differs | Partial application is visible; no silent fallback or prompt with unconfirmed values. | Not measured. |
| C11 | CONNECT in flight during replacement | It uses the new installation or is closed as old; successful acknowledgement leaves no usable old connection. | Not measured. |
| C12 | Detached task, subagent or background request at the boundary | Harness-specific reset policy is demonstrated; no blanket claim that final ACP reply means all work is idle. | Not measured. |
| C13 | Local-only harness or removal of the last external grant | No credential is required for a local turn; the proxy refuses outbound access and retains no usable old tunnel. | Not measured. |
| C14 | ACP reconnects during a running or uncertain turn | Same bridge installation verified and reused; no per-connection reissue/reset of outbound tunnels. | Not measured. |

**To be specified:** reviewed image-to-base-profile catalogue; installation identity/owner fields,
conditional-update errors, clear operation and acknowledgement/readback schema; configuration
command/entry schemas and asynchronous lab response; token validity margin;
background-task/reset policy per harness; count CONNECT responses by status; TLS trust for git
and codex; read access to GraphQL.

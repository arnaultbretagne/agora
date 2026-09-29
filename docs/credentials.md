# An execution's credentials

Contract to implement — agentgateway **1.5.0**, on top of executions (`executions.md`). The
decision and the options tried are in the gateway ADR.

**The sandbox holds no secret. It goes out through the gateway, which checks each request
against the execution's grants and sets the credential on the way through.**

A harness needs credentials: Claude, GitHub. They never enter the sandbox. Its only way out is
the gateway: it terminates TLS, decides whether the request is allowed and sets the host's
authentication header. The execution holds only a **short-lived JWT signed by Agora**, which
lists its grants. Agora hands it to the bridge after the claim, which keeps the pool warm.

## Who does what

- **The operator** stores the credentials as a SOPS Secret in infra-k8s.
- **The gateway** (agentgateway) is a prerequisite, like Kubernetes and Agent Sandbox, deployed
  and configured by infra-k8s. It holds the credentials, terminates TLS with its own certificate
  authority, checks the JWT and the grants, and sets the host's credential.
- **Agora** compiles the execution's profiles into grants, signs them and hands the token to the
  bridge. It sees no credential.
- **The bridge** opens a local outbound proxy for the harness and forwards each tunnel to the
  gateway, with the token.
- **infra-k8s** gives the sandboxes the gateway's certificate authority and lets them out only
  to the gateway.

## Why a proxy in the bridge

The adapter starts in the pool, before any claim: its environment cannot carry a token. Passing
the token through the claim forces a cold start (see `executions.md`, "Decisions and ruled-out
options").

So the bridge starts the adapter with `HTTPS_PROXY` pointing at its own local proxy, which
refuses everything until a credential is attached. Agora attaches the token later, through a
bridge route. Any harness that honours `HTTPS_PROXY` benefits.

The token stays in the bridge's memory: not in the adapter's environment, not on disk. The agent
can use the way out but not take the token with it, and the network lets it go nowhere else.

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
| `PUT /credentials` | With Agora's token. The body gives the proxy (`host:port`), the token and its expiry. Replaces the previous token: later tunnels use the new one, open tunnels carry on. |
| `GET /info`, `outbound` field | Proxy, expiry, when the credential was attached, number of tunnels, number of refusals, and for each target the number of tunnels and the last response to the `CONNECT`. Never the token. |
| Adapter's environment | `HTTPS_PROXY` and `https_proxy` set to `http://127.0.0.1:<port>`, `NO_PROXY` set to `localhost,127.0.0.1`. |
| What is relayed | `CONNECT` only. An `http://` request is refused (501): it has no credential to carry. |

## Profiles and grants

An execution receives a list of **profiles**. Agora compiles them into **grants**: a host, a
regular expression anchored on the path and query, methods. The catalogue lives in Agora's code
(`packages/credentials`).

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything. |
| `github:owner/repo:read` | REST API `/repos/owner/repo…` with `GET` and `HEAD`; git `git-upload-pack` only (a clone also sends a `POST`). |
| `github:owner/repo:write` | REST API `/repos/owner/repo…`, all methods; git `git-upload-pack` and `git-receive-pack`. |

Grants are additive: any combination of profiles composes, with no entity per combination.
GraphQL (`/graphql`) is covered by no profile: the target repo cannot be checked there.

## The token

An EdDSA JWT signed by Agora's key (Secret `grants-key`), `kid` `agora-grants-1`.

| Claim | Content |
| --- | --- |
| `iss`, `aud` | `agora`, `agora-gateway`: required by the gateway. |
| `sub` | The execution (`agora <name>`), written in every log line. |
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
reloaded about a minute after the merge, the time the kubelet takes to sync the Secret. The PAT
sets the maximum, the repos Agora can touch; the grants cut that maximum down per execution.

Every request leaves a log line: execution (`jwt.sub`), `jti`, method, host, path, status, and
the reason for a refusal.

## On Agora's side

| Element | Rule |
| --- | --- |
| `POST /api/executions/{name}/credentials` | Body: the profiles, the duration in seconds (3,600 by default). Agora compiles and signs, then hands the token to the bridge; the response is the bridge's `outbound` field. |
| The token | Kept nowhere: not on the claim, not in memory after the call, not in the log. |
| After each turn | Agora reads the bridge's `outbound` field again: tunnels and responses become visible in the execution's state. |
| `GET /api/config` | `credentials` field: the gateway and the known profiles, or nothing. |
| Configuration | `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, and `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE`. Without `GATEWAY_PROXY`, no execution has a way out. |

The lab attaches a credential by hand; attaching it when the execution is created is still to
be specified (below).

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
`haiku`. It is sent after `session/new` and before the first prompt, which is the first billed
call. The lab does it itself when the agent offers the option.

## Cases to validate

Continues the cases of `executions.md`, run on 28 and 29 September on g4 under Kata, by
`apps/lab/scripts/live-cases.ts`. For GitHub, a fine-grained PAT limited to two throwaway repos,
with write access to both: a refusal can only come from the gateway.

| # | Case | Expected | Measured |
| --- | --- | --- | --- |
| 23 | Going out without a credential | The mock's `/fetch`: `CONNECT` refused, 503; one refusal counted. | 503 from the bridge, one refusal counted. Before any credential is attached, the outbound attempts of the pool's Pod are refused too. |
| 24 | The chain alone | `anthropic` profile, the mock's `/fetch https://api.anthropic.com/v1/models`: a response from Anthropic, neither a 403 from the gateway nor a TLS error. | 400 from Anthropic ("anthropic-version: header is required"): TLS accepted, Bearer set by the gateway; tunnel → 200. |
| 25 | Real harness | `anthropic` profile, claude-code on `haiku`: a real model response. | "Paris." in 2.3 s, `end_turn`; gateway log: two `POST /v1/messages` at 200 under the execution's name. |
| 26 | Composition | Profiles `github:A:write` and `github:B:read`. A: read, write, push; B: read and fetch, no write or push; C, GraphQL: refused. | A: read 200, write 201, push 200; B: read 200, fetch 200; B write, B push, C, GraphQL: 403 from the gateway. Checked in GitHub: the created file exists on A, not on B. |

Outside the lab, against the same configuration: missing, expired or foreign JWT → 401; crafted
paths (`..`, `.`, `%2e`, `%2f`) → 403; host with no route → 404.

**To be specified:** attach at creation and renew the token when the deadline goes past it,
since a JWT cannot be revoked before it expires; count the responses to `CONNECT` by status, not
just the last one; TLS trust for git (libcurl does not read `NODE_EXTRA_CA_CERTS`) and for codex,
which are not Node; read access to GraphQL.

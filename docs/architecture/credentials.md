# Credentials

A harness needs credentials — Claude, z.ai, ChatGPT, GitHub — but its sandbox never holds one. Everything it
sends out goes through the gateway, which checks each request against the rights Agora gave the
execution, and sets the real credential on the way.

## Who does what

| Actor | Role |
| --- | --- |
| Agora | Turns profiles into grants, signs them into a token, hands the token to the bridge: in the pool, the pool's base profiles; for an execution, those and its own. It never sees a credential. |
| The bridge | Opens a local proxy for the harness and forwards each outbound connection to the gateway, with the token. |
| The gateway | A prerequisite (agentgateway). Holds the credentials, checks the token and the grants, sets the credential. |
| infra-k8s | Stores the credentials, deploys the gateway, lets sandboxes out only towards it, and declares each pool's base profiles. |

## Why a proxy in the bridge

The harness's adapter starts in the warm pool, before the execution exists: its environment
cannot carry a token, and passing one through the claim would force a cold start. So the bridge
starts the adapter with `HTTPS_PROXY` pointing at a local proxy of its own, which refuses
everything until Agora attaches a token. Any harness that honours `HTTPS_PROXY` benefits.

The token stays in the bridge's memory, neither in the adapter's environment nor on disk: the
agent can use the way out, not take the token with it, and the network lets it go nowhere else.

## Profiles and grants

A **profile** is a right expressed for humans: `anthropic`, `zai`, `chatgpt`, `github:owner/repo:read`,
`github:owner/repo:write`. Agora compiles each profile into **grants**, which the gateway can
check on a request: a host, a pattern on the path, and the allowed methods.

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything |
| `zai` | `api.z.ai`, everything |
| `chatgpt` | `chatgpt.com` on `/backend-api/codex…` and `/backend-api/wham…` |
| `github:o/app:write` | `api.github.com` on `/repos/o/app…`, every method; `github.com` git fetch and push on `o/app` |
| `github:o/docs:read` | `api.github.com` on `/repos/o/docs…`, `GET` and `HEAD` only; `github.com` git fetch on `o/docs` |

Grants add up: any mix of profiles is just a longer list.

Grants are the only restriction, so they stop at what the gateway can check: a host, a path, a
method. An ACP permission, an installed tool or an instruction given to the model restricts
nothing on the service's side. If the gateway refuses or does not answer, the request fails;
nothing ever widens the grants.

## From a warm Pod to an execution

A harness may need its services before anyone uses it: claude-code's SDK initializes against
Anthropic, and without a way out it retries for some twenty seconds. So the pool says which
services its harness needs from the start — its **base profiles**, `anthropic` for claude-code,
`zai` for opencode, `chatgpt` for codex, none for the mock — and Agora treats every pool alike.

| Moment | The bridge's token |
| --- | --- |
| In the pool | The pool's base profiles, naming the warm Pod. Renewed while the Pod waits. |
| At the claim, before `initialize` | The base profiles and the execution's own, naming the execution. |
| Between turns, when it would run out | The same rights in a new token. |

Agora is the only one handing tokens over: once it sees the claim bound to the Pod, it stops
warming it, and the execution's token replaces the warm one. Each replacement closes the tunnels
opened with the previous token, so the new one is the only one in use: between turns, the harness
has nothing in flight to cut.

```mermaid
sequenceDiagram
    participant Agora
    participant Bridge as Bridge (warm Pod)
    participant Harness
    Agora->>Bridge: warm token: base profiles
    Harness->>Bridge: may initialize against its services
    Note over Agora,Bridge: the claim binds the Pod
    Agora->>Bridge: execution token: base + the execution's profiles
    Bridge->>Bridge: closes the tunnels of the warm token
    Agora->>Harness: initialize, then the Session
```

A warm token makes initializing in the pool possible; whether a harness does it is its own
capability. Without it, the execution's token arriving before `initialize` is already what keeps
the Session opening from stalling.

## The token

The grants travel inside a short-lived JWT: a header, a content and a signature. The content is
plain JSON — the issuer, the audience, the execution or the warm Pod, the expiry, and the list of
grants. Agora signs header and content with its Ed25519 private key.

The content is not encrypted: the sandbox can read its own rights. It cannot change them:
editing a grant or pushing back the expiry breaks the signature. The gateway checks the signature
with Agora's public key, then the expiry, the issuer and the audience; it needs nothing else to
decide.

## A request

```mermaid
sequenceDiagram
    participant Harness
    participant Bridge
    participant Gateway
    participant GitHub
    Harness->>Bridge: CONNECT api.github.com:443
    Bridge->>Gateway: CONNECT + token
    Gateway-->>Harness: 200, then TLS with the gateway's CA
    Harness->>Gateway: PUT /repos/o/docs/contents/x
    Gateway-->>Harness: 403 (no grant allows PUT on o/docs)
    Harness->>Gateway: PUT /repos/o/app/contents/x
    Gateway->>GitHub: same request + the PAT
    GitHub-->>Harness: 201
```

The gateway applies a single rule to every request: some grant must cover its host, its path
and its method. The harness trusts the gateway's certificate authority, so the TLS it sees ends
at the gateway, which can read the request and set the credential.

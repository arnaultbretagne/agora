# Credentials

A harness needs credentials — Claude, GitHub — but its sandbox never holds one. Everything it
sends out goes through the gateway, which checks each request against the rights Agora gave the
execution, and sets the real credential on the way.

## Who does what

| Actor | Role |
| --- | --- |
| Agora | Turns the execution's profiles into grants, signs them into a token, hands the token to the bridge. It never sees a credential. |
| The bridge | Opens a local proxy for the harness and forwards each outbound connection to the gateway, with the token. |
| The gateway | A prerequisite (agentgateway). Holds the credentials, checks the token and the grants, sets the credential. |
| infra-k8s | Stores the credentials, deploys the gateway, lets sandboxes out only towards it. |

## Why a proxy in the bridge

The harness's adapter starts in the warm pool, before the execution exists: its environment
cannot carry a token, and passing one through the claim would force a cold start. So the bridge
starts the adapter with `HTTPS_PROXY` pointing at a local proxy of its own, which refuses
everything until Agora attaches a token, after the claim. Any harness that honours
`HTTPS_PROXY` benefits.

The token stays in the bridge's memory, neither in the adapter's environment nor on disk: the
agent can use the way out, not take the token with it, and the network lets it go nowhere else.

## Profiles and grants

A **profile** is a right expressed for humans: `anthropic`, `github:owner/repo:read`,
`github:owner/repo:write`. Agora compiles each profile into **grants**, which the gateway can
check on a request: a host, a pattern on the path, and the allowed methods.

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything |
| `github:o/app:write` | `api.github.com` on `/repos/o/app…`, every method; `github.com` git fetch and push on `o/app` |
| `github:o/docs:read` | `api.github.com` on `/repos/o/docs…`, `GET` and `HEAD` only; `github.com` git fetch on `o/docs` |

Grants add up: any mix of profiles is just a longer list.

## The token

The grants travel inside a short-lived JWT: a header, a content and a signature. The content is
plain JSON — the issuer, the audience, the execution, the expiry, and the list of grants. Agora
signs header and content with its Ed25519 private key.

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

## What follows

- **No state.** The gateway keeps nothing per execution and never calls Agora. Changing an
  execution's rights is issuing a new token.
- **No early revocation.** A token stays valid until it expires, so tokens are short and Agora
  reissues them during the execution's life.
- **The credential bounds, the grants cut.** One credential per host sets the maximum Agora can
  ever reach; each execution gets only its share.
- **Size.** The token grows with the grants: a few hundred bytes for a few repos.

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

The token stays in the bridge's memory, neither in the adapter's environment nor on disk. That
does not hide it from the agent, which runs under the bridge's user and can read that memory.
What makes the token worthless elsewhere is its address: it names the Pod's, and the gateway
takes it from there only (below, "The token").

## Profiles and grants

A **profile** is a right expressed for humans: `anthropic`, `zai`, `chatgpt`, `internet`,
`github:owner/repo:read`, `github:owner/repo:write`, `vault:read`, `vault:write`, `kubernetes:read`,
`previews`. Agora compiles each profile into **grants**, which the gateway can check on a request: a host, a
pattern on the path, the allowed methods, and for an MCP server the tools a call may name.

| Profile | Grants |
| --- | --- |
| `anthropic` | `api.anthropic.com`, everything |
| `zai` | `api.z.ai`, everything |
| `chatgpt` | `chatgpt.com` on `/backend-api/codex…` and `/backend-api/wham…` |
| `internet` | `*`, everything: any host without a credential of its own |
| `github:o/app:write` | `api.github.com` on `/repos/o/app…`, every method; `github.com` git fetch and push on `o/app` |
| `github:o/docs:read` | `api.github.com` on `/repos/o/docs…`, `GET` and `HEAD` only; `github.com` git fetch on `o/docs` |
| `vault:read` | `vault.bretagne.dev` on `/mcp`, the vault's MCP tools that only read |
| `vault:write` | `vault.bretagne.dev` on `/mcp`, everything the vault's MCP server offers |
| `kubernetes:read` | `kubernetes.agora.internal`, the cluster's API, `GET` and `HEAD` only; what may be read is the gateway's RBAC |
| `previews` | the hosts `pr-<n>-<app>.preview.bretagne.dev`, through each preview's gateway gate, which takes the gateway's own Pocket-ID client |

Grants add up: any mix of profiles is just a longer list.

Which repositories an execution may reach, and whether it may reach the Internet, is declared by
the operator — the **offered** profiles, each at its widest access — and picked by the user,
before the execution or between its turns.

Grants are the only restriction, so they stop at what the gateway can check: a host, a path, a
method — and on an MCP server, where every call is a `POST` to the same path, the tool named, which
the gateway reads in the protocol itself. An ACP permission, an installed tool or an instruction given to the model restricts
nothing on the service's side. If the gateway refuses or does not answer, the request fails;
nothing ever widens the grants.

A profile can open an **MCP server** too: the execution's `session/new` names it, by its public
address and with no secret, and the harness reaches it through the gateway like any host. The
gateway's route holds the server's credential — the identity of a machine client — and lets
through only the tools the grants name. With `vault:read` or `vault:write`, the execution gets the
Obsidian vault's server; without, none.

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
| Between turns, when the user changes its access | The base profiles and the new own ones, at once. |

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

The content also names the Pod's address, which Agora takes from Kubernetes, never from the Pod.
The gateway lets a request through only if it comes from that address. A Pod cannot send from
another's address, so a token carried out of its Pod opens nothing anywhere else. No secret could
play that part: anything the bridge keeps, the agent can read.

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

## The Internet

Every host the gateway holds a credential for has a route of its own. Any other host falls to one
more route, `internet`, which agentgateway picks last and which sets no credential. Its rule asks
for a grant on host `*`, which only the `internet` profile gives; the routes with a credential
compare the grant's host with the request's, which is never `*`. So the Internet adds the rest of
the Web, and GitHub as the public sees it.

GitHub is where a repository nobody granted still matters: an agent with the Internet reads public
code there all day. So `api.github.com` and `github.com` have a second route each, for what no grant
covers. It takes a grant on `*` too, and lets only reads through: a public repository can be cloned
and read, never written to or pushed to. It sets the same PAT as the routes with a grant — a
fine-grained PAT reads every public repository — so the gateway, not the credential, keeps it to
reads. Which of the two routes a GitHub request takes is decided before any route is picked: the
gateway marks the request covered or not by the execution's grants, and each route checks the request
again, so the mark cannot be forged into anything.

```mermaid
flowchart LR
    Request --> Named{host named by a route?}
    Named -- "yes: api.anthropic.com…" --> Grant{a grant on this host?}
    Grant -- yes --> Credential[credential set, sent]
    Grant -- no --> Refused[403]
    Named -- "GitHub" --> Covered{a grant covers it?}
    Covered -- yes --> Credential
    Covered -- no --> Read{a grant on *, and a read?}
    Read -- yes --> Credential
    Read -- no --> Refused
    Named -- no --> Star{a grant on *?}
    Star -- yes --> Sent[sent as is]
    Star -- no --> Refused
```

That holds while the PAT reaches no private repository: through the second route, an execution
with the Internet reads whatever the PAT reads. A private repository to offer would call for a
second credential there, one that reads public repositories only.

A route that takes any host could reach anything the gateway can, so the network bounds it: the
gateway goes out to public addresses only, on port 443. The operator's networks and the cluster
sit in private ranges it cannot reach, whatever name points there.

The Internet is the operator's to offer and the user's to keep. Credentials never leave the
gateway, but what the agent reads can steer it, and with the Internet it can send anything it holds
anywhere — a repository it was given included. Offered, the interface turns it on for a new
Workstream, since most tasks need the Web; the user turns it off per execution when the risk is not
worth it. A pool never gets it as a base profile, and an execution sent without it has none.

## The accounts' limits

The subscriptions behind the profiles — Claude's, ChatGPT's, z.ai's — each have limits: a 5-hour
window and a weekly one. Each provider says where an account stands at a usage endpoint of its own,
and Agora reads them the way an execution goes out: through the gateway, with a grant it signs for
itself, bound to the server's own Pod. The gateway sets the account's credential, so the server
holds none, and the grant opens those reads alone.

```mermaid
flowchart LR
  Screen[the screen] -- GET /api/limits --> Server
  Server -- CONNECT, the limits grant --> Gateway
  Gateway -- the account's credential --> Anthropic[api.anthropic.com]
  Gateway --> ChatGPT[chatgpt.com]
  Gateway --> ZAI[api.z.ai]
```

Claude's endpoint asks more of a credential than inference does: the operator's setup-token cannot
read it. The cluster keeps a Claude login of its own for that one path, renewed like the ChatGPT
session, while inference stays on the setup-token: renewing a login revokes its previous token at
once, and the gateway sees the new one a minute later. That login ends after about four weeks,
whatever its renewals; the operator logs in again before then.

The reads are few: when someone looks, and at most once every five minutes.

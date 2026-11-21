# ADR 000n — MCP

- **Status:** accepted
- **Date:** 2026-11-02

## Context

- An agent needs Agora's own primitives from inside its sandbox: find and read the person's
  Workstreams now, hand work to another agent next. In every harness Agora runs: Claude Code,
  Codex, opencode.
- No credential lives in the sandbox, and everything it sends out goes through the gateway, which
  checks the execution's token (ADR Gateway).
- The harnesses take MCP servers in `session/new`, and a server given there is `http`: a type, a
  URL, headers. What `session/new` carries is written in the log, so it carries no secret.
- Agora must know who calls: which execution, hence which Workstream and which person, to answer
  within that person's Workstreams and to open only what the execution's rights open.

## Decision

1. Agora serves an MCP server itself, in its server's process, on a port of its own that only the
   gateway reaches.
2. An agent reaches it as a host of the gateway, `mcp.agora.internal`, with its token, through a
   route that forwards the token it checked as `Authorization: Bearer`, over whatever the sandbox
   sent.
3. Agora checks that token again — its own signature, issuer, audience, expiry — and takes the
   caller from its subject alone: the execution, the Workstream it serves, that Workstream's
   person. Nothing else on the port names a caller.
4. A right opens the server, `agora:read` first. Which tools a right opens is Agora's to tell, by
   the rights its log records, not the gateway's.

```mermaid
sequenceDiagram
  participant H as Harness (sandbox)
  participant G as Gateway
  participant A as Agora, port 8082
  H->>G: CONNECT mcp.agora.internal:443, token
  G->>G: token, bound address, grant
  H->>G: POST /mcp (tools/call search)
  G->>A: POST /mcp, Authorization: Bearer token
  A->>A: token checked → execution → Workstream → person; rights; search
  A-->>H: the answer, through the gateway
```

## Why

- **One path.** The MCP server is reached as GitHub or the vault are: same proxy, same token, same
  checks, same log line. Nothing new runs in the sandbox, and nothing in `mcpServers` is secret.
- **A caller the sandbox cannot name.** The caller is the subject of a token Agora signed, which
  the gateway verified, bound to the sandbox's address, and Agora verifies again with its own key;
  whatever the sandbox writes in `Authorization` is replaced. Reaching the port proves nothing:
  the node, which runs the cluster, reaches it as it reaches every Pod's ports, and a network
  policy loosened or bypassed opens nothing.
- **The proof Agora already holds the key to.** Agora signs the grants; checking one takes its own
  public key, nothing fetched, nothing more to rotate.
- **Rights where they are recorded.** Agora wrote the execution's profiles into its log; it reads
  them there, so a Scope takes effect at Agora's next call without waiting for a token.

## What we tried

| Option | Why not |
| --- | --- |
| MCP over ACP: the client offers Agora's tools inside the ACP connection | ACP's MCP-over-ACP was an unstable schema; claude-agent-acp and codex-acp refuse servers of type `acp`, and opencode has none (code read, 2026-10-29). |
| The gateway's MCP backend, as the vault's: agentgateway speaks MCP to the server and checks the tools in the protocol | It builds its own client to the server, with the route's credential; the caller would need a header policy on that client, which no route uses (agentgateway 1.6.0 configuration, route `vault`; not tried). Checking tools there would also repeat what Agora must check anyway, with rights it does not hold. |
| The gateway naming the caller in a header, `x-agora-execution` from the token's subject, Agora trusting it because only the gateway's Pods reach the port | It held only while the network policy did: the node reaches the port, and anything there could name any execution (code read, `978fe4e`). The gateway keeps setting that header over the sandbox's, so that no server ever reads one the sandbox wrote. |
| A port the sandbox reaches directly, authenticated by the Pod's projected token, as the anchor receiver | The harness would carry that token in `mcpServers`' headers, which the log records, and its MCP client goes through the bridge's proxy whatever the host. |

## Consequences

- The server listens on a third port, 8082, and the network policies of the server and the
  gateway open it to the gateway alone.
- The gateway has a route of its own, `agora`, with no credential: it forwards the execution's
  token instead.
- The server needs its grants' key to serve the port: without the gateway, every message is
  refused.
- The MCP TypeScript SDK becomes a dependency of the server.
- Every tool added later, `spawn_agent` first, comes with a right and Agora's check.
- A Session keeps its servers once open: a Session opened without `agora:read` never gets the
  server; one scoped out of it keeps the server, which refuses its calls.

# MCP

The evidence behind the acceptance cases of `specs/mcp.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-02 | `231b28c` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own. M1 with the lab's executions and the mock harness; M2–M7 against the MCP server on a port of its own, through the MCP TypeScript SDK 1.32.2's own client; M8 through agentgateway 1.6.0 (`agentgateway-linux-amd64`, sha256 `496ed27e…`) on `packages/credentials/test/fixtures/agora-gateway.yaml`, tokens from Agora's `GrantSigner`, the bridge's outbound proxy, and a stand-in for the server's port. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| M1 | — | local | R1 | proven | With `agora:read`: `[{ type: http, name: agora, url: https://mcp.agora.internal/mcp, headers: [] }]`; with `internet` and a repository's read: `[]`. |
| M2 | — | local | R1 | proven | `search`, read-only, `pattern` … `workstream`, `pattern` required; `read`, read-only, `workstream`, `offset`, `limit`, `workstream` required. |
| M3 | — | local | R1 | proven | `<sub> · The sub-stream · 1 line`, `  2:a quokka in the sub-stream`, then `<root> · The root · 1 line`, `  4:a quokka in the root`; the other person's Workstream never; no tool error. |
| M4 | — | local | R1 | proven | From 2, limit 3: lines 2–4 and `(lines 2–4 of 9; next offset 5)`; from 8: lines 8–9 and `(lines 8–9 of 9)`; from 12: `(no line from 12; 9 lines)`; another person's: a tool error, `unknown_workstream`. |
| M5 | — | local | R1 | proven | No header, an unknown execution, the execution without `agora `: 401 `unknown_caller` each; the same message named as the gateway names it: 200; a `GET`: 405. |
| M6 | — | local | R1 | partial | An execution never given `agora:read`: no tool listed, `search` refused with `not_allowed`. One scoped out of it is not run. |
| M7 | — | local | R1 | proven | `(`: a tool error, `invalid_pattern`; `head_limit` 500: a tool error, `invalid_query: head_limit`. |
| M8 | — | local | R1 | proven | With `agora:read`, with and without an `x-agora-execution` of the sandbox's: two messages at the stand-in, `POST /mcp`, each naming its token's own subject; `anthropic`, `internet`, `agora:read` from 10.244.9.9, `agora:read` on `/api/workstreams`: 403, nothing at the stand-in; the control reaching it. |
| M9 | — | live | — | not verified | No live run yet. |

## Not covered

| Failure | Issue |
| --- | --- |
| The server's port 8082 reached from anything but the gateway, in the cluster: the network policy is infra-k8s's, and no run has the cluster | — |

# MCP

The evidence behind the acceptance cases of `specs/mcp.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-02 | `231b28c` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own. M1 with the lab's executions and the mock harness; M2–M7 against the MCP server on a port of its own, through the MCP TypeScript SDK 1.32.2's own client; M8 through agentgateway 1.6.0 (`agentgateway-linux-amd64`, sha256 `496ed27e…`) on `packages/credentials/test/fixtures/agora-gateway.yaml`, tokens from Agora's `GrantSigner`, the bridge's outbound proxy, and a stand-in for the server's port. |
| R2 | 2026-11-02 | `203d147` | live | `apps/server/scripts/live-cases.ts` against production, case M9: server `agora-server@sha256:6ad6106d…`, the pools `claude-code-ac7dcc0b2234`, `codex-249acf30983c`, `opencode-9fc3fd77cff0` and `mock-440d5648b04f`, agentgateway 1.6.0 with the route `agora` (infra-k8s `60da3c8`); each harness with its pool's default model; the cases' owner `c45e0000-…`. Output: `✔ M9 MCP, each real harness: search, then read, a past conversation — claude-code: ToolSearch, mcp__agora__search, mcp__agora__read; key-0e160c4d quoted \| codex: mcp.agora.search, mcp.agora.read; key-0e160c4d quoted \| opencode: agora_search, agora_read, agora_read, agora_read; key-0e160c4d quoted (50 s)`, `1/1 cases validated`. |
| R3 | 2026-11-03 | `c904f8c` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11; M10 and M11 against the MCP server on a port of its own, the lab's executions behind it, through the MCP TypeScript SDK 1.32.2's own client and plain `fetch`. |
| R4 | 2026-11-03 | `0451c69` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11; M10 now lists the tools as the delegate's Session opens, before its instructions, the engine held: it fails on `5ff8da9`'s engine, passes on this one (agora #179). |
| R5 | 2026-11-04 | `ea042cb` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:3def865e…`; the pools `claude-code-48de2cb17779` (claude-agent-acp 0.100.0, claude-code 2.1.316), `codex-7fc81aec7cce` (codex-acp 2.5.0, codex 0.165.0) and `opencode-9ed4fac4159e` (1.18.34), each harness with its pool's default model; the cases' owner. M9, on the new adapters. |
| R6 | 2026-11-04 | `fd0c720` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11; M10 and M11 against the MCP server on a port of its own, the lab's executions behind it, through the MCP TypeScript SDK 1.32.2's own client and plain `fetch`. |
| R7 | 2026-11-11 | `f433f48` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11; M10 to M12 against the MCP server on a port of its own, the lab's executions behind it, through the MCP TypeScript SDK 1.32.2's own client, as R6. |
| R8 | 2026-11-11 | `c27561b` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:6ffb1fdc…`; the pools `claude-code-220dcdea6c5d` (claude-agent-acp 0.106.0, claude-code 2.1.322), `codex-156dc39bef82` (codex-acp 2.6.0, codex 0.166.0) and `opencode-8ec41e3d2297` (1.19.5), each harness with its pool's default model; the cases' owner. M9, on the new harnesses (agora #204, infra-k8s #358). |

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
| M9 | — | live | R2 | proven | Claude Code, Codex and opencode, each given `agora:read`, called the server's `search`, then `read` — `mcp__agora__…`, `mcp.agora.…`, `agora_…` — through the gateway, and quoted `key-0e160c4d`, which only the past conversation held. |
| M9 | — | live | R5 | proven | Claude Code (`ToolSearch`, `mcp__agora__search`, `mcp__agora__read`), Codex (`mcp.agora.search`, `mcp.agora.read`) and opencode (`agora_search`, `agora_read`) each quoted `key-4ef265b4`, which only the past conversation held. |
| M9 | — | live | R8 | proven | Claude Code (`ToolSearch`, `mcp__agora__search`, `mcp__agora__read`), Codex (`mcp.agora.search`, `mcp.agora.read`) and opencode (`agora_search`, then `agora_read` three times) each quoted `key-8fd03b42`, which only the past conversation held. |
| M10 | — | local | R3 | proven | With `agora:delegate`: `delegate` alone, not read-only, `instructions`, `harness`, `model`, `effort`, `rights`, `output_schema`, `to`; from a delegate asked for a result, with `agora:submit` alone: `submit` alone, its input the delegation's schema. |
| M10 | — | local | R4 | proven | From a delegate asked for a result, as its Session opens, no turn yet: `submit` alone, its input the schema. |
| M11 | — | local | R3 | proven | `tools/list`: `application/json`; a `delegate` call held by an approval of 1.5 s: `text/event-stream`, 3 progress notifications or more, then the answer to request 2; the approval `expired`. |
| M10 | — | local | R6 | proven | With `agora:delegate`: `delegate` alone, not read-only, `instructions`, `harness`, `model`, `effort`, `rights`, `output_schema`, `to`. From a delegate asked for a result, as its Session opens: `submit` alone, `message` and `result`, `message` alone required. |
| M11 | — | local | R6 | proven | `tools/list`: `application/json`. A `delegate` call held by an approval of 1.5 s: `text/event-stream`, 3 progress notifications or more, then its answer; the element `expired`. |
| M10 | — | local | R7 | proven | With `agora:delegate`: `spawn_agent`, `send_message`, `stop_agent`, `list_agents`, the last alone read-only; their parameters `instructions`, `harness`, `model`, `effort`, `rights`; `to`, `message`; `to`; none. From a delegate, as its Session opens: `send_message` alone, `to` and `message`, both required. From one holding `agora:delegate` and `agora:submit`: the four, each once. |
| M11 | — | local | R7 | proven | As R6, the call held a `spawn_agent`. |
| M12 | — | local | R7 | proven | From a delegate, `stop_agent` and `list_agents`: `not_allowed`; from its delegator, `delegate` and `submit`: `not_allowed`; the delegate still `in_progress`, one sub-stream. A delegate that delegated, scoped down to `agora:submit`: `send_message` alone listed; to its own delegate: `not_a_delegate`, one Write in it. |

## Not covered

| Failure | Issue |
| --- | --- |
| The server's port 8082 reached from a Pod other than the gateway's: no case asserts it. Observed on R2's deployment from Prefect's worker: 8080 answered, 8082 not reached; from the node, 8082 answered 401, as the spec says | — |

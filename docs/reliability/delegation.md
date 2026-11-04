# Delegation

The evidence behind the acceptance cases of `specs/delegation.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-03 | `c904f8c` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own; the lab's executions on FakeKube, real bridges and the mock agent; the caller's MCP calls through the MCP TypeScript SDK 1.32.2's own client, its execution named as the gateway names it. An approval lives 3 s and its call hears progress every 500 ms (D8: 2 s and 400 ms), in place of 4 min 30 s and 30 s; D4 and D14 beat the engine themselves (its `manual` option). |
| R2 | 2026-11-03 | `5ff8da9` | live | `apps/server/scripts/live-cases.ts` against production, cases D15 and D16: server `agora-server@sha256:9e869380…`, the pools `claude-code-a4685a3a8cf1`, `codex-ef82ed06f6bf`, `opencode-9ed4fac4159e` and `mock-fdf7635e574d`, each harness with its pool's default model; the cases' owner `c45e0000-…`. Output: `✖ D15 … timed out: the result`; `✔ D16 … claude-code: the approval names toolu_017FYZJsr7Pg7Ggz1x2qL3hT ("mcp__agora__delegate") \| codex: the approval names exec-a1e2bdb5-8202-4540-a25e-030c02e5212b ("mcp.agora.delegate") \| opencode: the approval names call_8f5c9fbb3f56422db806cd9a ("agora_delegate") (38 s)`, `1/2 cases validated`. |
| R3 | 2026-11-03 | `651d122` | live | As R2, on the server `agora-server@sha256:2db145d0…`, with agora #179. Output: `✔ D15 … claude-code: delegate 61eadcc2, submitted { product: 1771 }, report at 60, answered "1771" \| codex: delegate a2c7e6ca, submitted { product: 804 }, report at 53, answered "804" \| opencode: delegate 76d3286e, submitted { product: 5360 }, report at 85, answered "5360" (82 s)`; `✔ D16 … claude-code: the approval names toolu_01GcShKfTyzzUPLUxUPmzbyc ("mcp__agora__delegate") \| codex: the approval names exec-c25e1693-d3a6-4346-b94a-2dcb678b24c4 ("mcp.agora.delegate") \| opencode: the approval names call_b1c2c7c220af44daba0ab225 ("agora_delegate") (49 s)`, `2/2 cases validated`. |
| R4 | 2026-11-04 | `ea042cb` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:3def865e…`; the pools `claude-code-48de2cb17779` (claude-agent-acp 0.100.0, claude-code 2.1.316), `codex-7fc81aec7cce` (codex-acp 2.5.0, codex 0.165.0) and `opencode-9ed4fac4159e` (1.18.34), each harness with its pool's default model; the cases' owner. D15 and D16, on the new adapters. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| D1 | — | local | R1 | proven | `started <id> · hello delegate` at once; the sub-stream's parent the caller's Workstream, its depth 1, its execution on `mock-test`; its first message `hello delegate`, `from` the caller's Workstream. |
| D2 | — | local | R1 | proven | A `report` element in the caller's Workstream, `delegates` the delegate alone, its text from `From Agora, not the person:`, then `<id> "report back": completed, its last message: Echo #1: report back.`; one `delegation.reported` in the delegate's. |
| D3 | — | local | R1 | proven | Two delegates done while the caller's `/sleep 4` ran: no report meanwhile; then one report naming both. |
| D4 | — | local | R1 | proven | The delegate done, the person's `/sleep 2` accepted before the engine's next beat: no report during its turn; one after it; two turns in the caller's. |
| D5 | — | local | R1 | proven | A caller at depth 3: a tool error, `depth_exceeded`; three `/sleep 10` delegates, then a fourth: `too_many_delegates`; the Workstreams counted: the three delegates alone added. |
| D6 | — | local | R1 | proven | `internet` beyond `agora:delegate`: the call held; a `question` element of kind `approval`, pending, one option, its text naming `internet`; the Answer `approve`: `started`, the delegate's profiles `[internet]`. |
| D7 | — | local | R1 | proven | A Write while the approval waits: the call's tool error `refused: use the read-only rights`; the caller's turns as before; the element `refused`, its note the words; no sub-stream. |
| D8 | real: the approval's time ran out | local | R1 | proven | The caller's `/sleep 5` running, its turn's maximum 30 s: the call's tool error `expired` after 2 s, 3 progress notifications or more meanwhile; the element `expired`; a deadline of the caller's claim at turn start + 30 s + 1.8 to 3 s. |
| D9 | — | local | R1 | proven | A second call needing approval while one waits: `approval_pending`; the first then `expired`. |
| D10 | — | local | R1 | proven | The delegate's `tools/list`: `submit` alone, its input the schema; `{ verdict: maybe }`: a tool error, `invalid_result: /verdict must be equal to one of the allowed values`; `{ verdict: ship }`: `submitted`; the report `completed, result: {"verdict":"ship"}`. |
| D11 | — | local | R1 | proven | No `submit`: one reminder in the delegate's Workstream, `you were asked for a result: call submit with it`; then the report `completed with no result, its last message: Echo #2…`. |
| D12 | real: Stop; simulated: fake-kube (the claim's end) | local | R1 | proven | `to` while its `/sleep 3` ran: `delegate_busy`; once done: `started <id> · next`, a second turn done; after Stop and its claim's end: `started <id> · after the end`, a second execution, a third turn done. |
| D13 | real: Stop; simulated: fake-kube (the claim's end) | local | R1 | proven | The caller's execution ended while its delegate worked; the report reached it once continued: two executions in the caller's Workstream, the report naming the delegate. |
| D14 | simulated: a second engine on the same log | local | R1 | partial | An outcome the first engine left unreported: reported by a second engine started on the same log, once; one `delegation.reported`; neither engine reports it again. The second engine stands for a restart: the server is not restarted. |
| D15 | — | live | R2 | not verified | Claude Code's delegate submitted `{ product: 4095 }`, its report reached the caller. Codex's delegate answered "No `submit` tool is available in this session": Codex lists its tools as its Session opens, before the instructions, and `submit` came only once they were written; reminded, its outcome was reported completed with no result, and the case timed out on the result. opencode was not reached. Fixed by agora #179. |
| D15 | — | live | R3 | proven | Claude Code, Codex and opencode, each given `agora:delegate`: `started`; each delegate, on its caller's harness, submitted `{ product }` — 1771, 804, 5360, each the product asked; the report reached the caller, which answered with that number. |
| D15 | — | live | R4 | proven | Each given `agora:delegate`: each delegate submitted `{ product }` — 1190, 4840, 1411, each the product asked; the report reached the caller, which answered with that number. |
| D16 | — | live | R2 | partial | On each harness, the approval named the caller's `delegate` line — `mcp__agora__delegate`, `mcp.agora.delegate`, `agora_delegate` — and a Write refused it. Whether by the line's id or by its arguments is not observed; at the local level, the mock agent's line is named by its arguments (`client.md`, R28). |
| D16 | — | live | R3 | partial | The same on `651d122`. |
| D16 | — | live | R4 | partial | The same on `ea042cb`: the approval named `toolu_01K6iZNxtf2HTPqhe6dmy9n7`, `exec-471ad841-…` and `call_27c7dadf4d04…`, each the caller's `delegate` line. |
| D17 | simulated: a second engine on the same log | local | R1 | partial | An approval waiting in a caller with no delegate yet: marked `expired` as the second engine starts, one `question.expired`, the caller's question cleared; the call the first engine held then answers `expired`, the fact not written twice. The server is not restarted. |

## Not covered

| Failure | Issue |
| --- | --- |
| A crash between a delegate's accepted Create and its `delegation.started`: a sub-stream that runs, never given its instructions, never reported | — |

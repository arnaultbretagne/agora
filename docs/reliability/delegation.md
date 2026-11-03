# Delegation

The evidence behind the acceptance cases of `specs/delegation.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-03 | `c904f8c` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own; the lab's executions on FakeKube, real bridges and the mock agent; the caller's MCP calls through the MCP TypeScript SDK 1.32.2's own client, its execution named as the gateway names it. An approval lives 3 s and its call hears progress every 500 ms (D8: 2 s and 400 ms), in place of 4 min 30 s and 30 s; D4 and D14 beat the engine themselves (its `manual` option). |

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
| D15 | — | live | — | not verified | |
| D16 | — | live | — | not verified | At the local level, the approval of the mock agent's `delegate` line names it, matched by its arguments (`specs/assistant-ui.md`, U61; `client.md`, R28). |
| D17 | simulated: a second engine on the same log | local | R1 | partial | An approval waiting in a caller with no delegate yet: marked `expired` as the second engine starts, one `question.expired`, the caller's question cleared; the call the first engine held then answers `expired`, the fact not written twice. The server is not restarted. |

## Not covered

| Failure | Issue |
| --- | --- |
| A crash between a delegate's accepted Create and its `delegation.started`: a sub-stream that runs, never given its instructions, never reported | — |

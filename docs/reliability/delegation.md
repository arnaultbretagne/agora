# Delegation

The evidence behind the acceptance cases of `specs/delegation.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-03 | `c904f8c` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own; the lab's executions on FakeKube, real bridges and the mock agent; the caller's MCP calls through the MCP TypeScript SDK 1.32.2's own client, its execution named as the gateway names it. An approval lives 3 s and its call hears progress every 500 ms (D8: 2 s and 400 ms), in place of 4 min 30 s and 30 s. |
| R2 | 2026-11-03 | `5ff8da9` | live | `apps/server/scripts/live-cases.ts` against production, cases D15 and D16: server `agora-server@sha256:9e869380…`, the pools `claude-code-a4685a3a8cf1`, `codex-ef82ed06f6bf`, `opencode-9ed4fac4159e` and `mock-fdf7635e574d`, each harness with its pool's default model; the cases' owner `c45e0000-…`. Output: `✖ D15 … timed out: the result`; `✔ D16 … claude-code: the approval names toolu_017FYZJsr7Pg7Ggz1x2qL3hT ("mcp__agora__delegate") \| codex: the approval names exec-a1e2bdb5-8202-4540-a25e-030c02e5212b ("mcp.agora.delegate") \| opencode: the approval names call_8f5c9fbb3f56422db806cd9a ("agora_delegate") (38 s)`, `1/2 cases validated`. |
| R3 | 2026-11-03 | `651d122` | live | As R2, on the server `agora-server@sha256:2db145d0…`, with agora #179. Output: `✔ D15 … claude-code: delegate 61eadcc2, submitted { product: 1771 }, report at 60, answered "1771" \| codex: delegate a2c7e6ca, submitted { product: 804 }, report at 53, answered "804" \| opencode: delegate 76d3286e, submitted { product: 5360 }, report at 85, answered "5360" (82 s)`; `✔ D16 … claude-code: the approval names toolu_01GcShKfTyzzUPLUxUPmzbyc ("mcp__agora__delegate") \| codex: the approval names exec-c25e1693-d3a6-4346-b94a-2dcb678b24c4 ("mcp.agora.delegate") \| opencode: the approval names call_b1c2c7c220af44daba0ab225 ("agora_delegate") (49 s)`, `2/2 cases validated`. |
| R4 | 2026-11-04 | `ea042cb` | live | `apps/server/scripts/live-cases.ts` against production: server `agora-server@sha256:3def865e…`; the pools `claude-code-48de2cb17779` (claude-agent-acp 0.100.0, claude-code 2.1.316), `codex-7fc81aec7cce` (codex-acp 2.5.0, codex 0.165.0) and `opencode-9ed4fac4159e` (1.18.34), each harness with its pool's default model; the cases' owner. D15 and D16, on the new adapters. |
| R5 | 2026-11-04 | `fd0c720` | local | `npm run check`, all green: Node 24.20.0, PostgreSQL 17.11, each test on a database of its own; the lab's executions on FakeKube, real bridges and the mock agent, taking `_session/steering` as the adapters do, or not saying it can (D30); the delegators' and the delegates' MCP calls through the MCP TypeScript SDK 1.32.2's own client, their executions named as the gateway names them. An approval lives 3 s and its call hears progress every 500 ms (D8: 2 s and 400 ms), in place of 4 min 30 s and 30 s. Each guard these cases hold was also removed in turn: D5, D32, D37, D40–D44 and L99 each failed. |
| R6 | 2026-11-05 | `bf49026` | local | `npm run check`, all green, as R5, on the commit that adds `too_many_exchanges`: every case of R5 ran again, its test unchanged; D45 new. Each clause of the cap was also removed in turn, and D45 failed. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| D1 | — | local | R1 | proven | `started <id> · hello delegate` at once; the sub-stream's parent the caller's Workstream, its depth 1, its execution on `mock-test`; its first message `hello delegate`, `from` the caller's Workstream. |
| D5 | — | local | R1 | proven | A caller at depth 3: a tool error, `depth_exceeded`; three `/sleep 10` delegates, then a fourth: `too_many_delegates`; the Workstreams counted: the three delegates alone added. |
| D6 | — | local | R1 | proven | `internet` beyond `agora:delegate`: the call held; a `question` element of kind `approval`, pending, one option, its text naming `internet`; the Answer `approve`: `started`, the delegate's profiles `[internet]`. |
| D7 | — | local | R1 | proven | A Write while the approval waits: the call's tool error `refused: use the read-only rights`; the caller's turns as before; the element `refused`, its note the words; no sub-stream. |
| D8 | real: the approval's time ran out | local | R1 | proven | The caller's `/sleep 5` running, its turn's maximum 30 s: the call's tool error `expired` after 2 s, 3 progress notifications or more meanwhile; the element `expired`; a deadline of the caller's claim at turn start + 30 s + 1.8 to 3 s. |
| D9 | — | local | R1 | proven | A second call needing approval while one waits: `approval_pending`; the first then `expired`. |
| D15 | — | live | R2 | not verified | Claude Code's delegate submitted `{ product: 4095 }`, its report reached the caller. Codex's delegate answered "No `submit` tool is available in this session": Codex lists its tools as its Session opens, before the instructions, and `submit` came only once they were written; reminded, its outcome was reported completed with no result, and the case timed out on the result. opencode was not reached. Fixed by agora #179. |
| D15 | — | live | R3 | proven | Claude Code, Codex and opencode, each given `agora:delegate`: `started`; each delegate, on its caller's harness, submitted `{ product }` — 1771, 804, 5360, each the product asked; the report reached the caller, which answered with that number. |
| D15 | — | live | R4 | proven | Each given `agora:delegate`: each delegate submitted `{ product }` — 1190, 4840, 1411, each the product asked; the report reached the caller, which answered with that number. |
| D16 | — | live | R2 | partial | On each harness, the approval named the caller's `delegate` line — `mcp__agora__delegate`, `mcp.agora.delegate`, `agora_delegate` — and a Write refused it. Whether by the line's id or by its arguments is not observed; at the local level, the mock agent's line is named by its arguments (`client.md`, R28). |
| D16 | — | live | R3 | partial | The same on `651d122`. |
| D16 | — | live | R4 | partial | The same on `ea042cb`: the approval named `toolu_01K6iZNxtf2HTPqhe6dmy9n7`, `exec-471ad841-…` and `call_27c7dadf4d04…`, each the caller's `delegate` line. |
| D17 | simulated: a second engine on the same log | local | R1 | partial | An approval waiting in a caller with no delegate yet: marked `expired` as the second engine starts, one `question.expired`, the caller's question cleared; the call the first engine held then answers `expired`, the fact not written twice. The server is not restarted. |
| D1 | — | local | R5 | proven | `started <id> · hello delegate` at once; its parent the delegator's Workstream, its depth 1, on `mock-test`; its first message `hello delegate`, `from` the delegator, `as` `delegator`; its prompt Agora's line, then the words. |
| D5 | — | local | R5 | proven | A delegator at depth 3: `depth_exceeded`; three `/sleep 10` delegates, then a fourth: `too_many_delegates`, those three alone added. Four calls together: three started, one `too_many_delegates`, three Workstreams. |
| D6 | — | local | R5 | proven | `internet` beyond `agora:delegate`: the call held; a `question` of kind `approval`, pending, one option, its text naming `internet`; the Answer `approve`: `started`, the delegate's profiles `[internet, agora:submit]`. |
| D7 | — | local | R5 | proven | A Write while the approval waits: a tool error `refused: use the read-only rights`; the delegator's turns as before; the element `refused`, its note the words; no sub-stream. |
| D8 | real: the approval's time ran out | local | R5 | proven | The delegator's `/sleep 5` running, its turn's maximum 30 s: a tool error `expired` after 2 s, 3 progress notifications or more meanwhile; the element `expired`; a deadline of its claim at turn start + 30 s + 1.8 to 3 s. |
| D9 | — | local | R5 | proven | A second call needing approval while one waits: `approval_pending`; the first then `expired`. |
| D15 | — | live | — | not verified | Asserted by `live-cases.ts`, now with the delegate's own `submit` line; no run on these images yet. |
| D16 | — | live | — | not verified | Asserted by `live-cases.ts`; no run on these images yet. |
| D17 | simulated: a second engine on the same log | local | R5 | partial | As R1: marked `expired` as the second engine starts, one `question.expired`, the question cleared; the call the first engine held then answers `expired`, the fact not written twice. The server is not restarted. |
| D18 | — | local | R5 | proven | `sent`; the delegator's prompt `From your delegate <id> "/sleep 2", not the person:`, then `the words`; its `user` element `from` the delegate, `as` `delegate`, `the words` alone. |
| D19 | — | local | R5 | proven | A `submit` of more than 100,000 characters: `sent`; the prompt's second block equal to it. |
| D20 | — | local | R5 | proven | During `/sleep 7`: `sent` each time; the steering lines `first`, `second`, `third`, in that order; one prompt; three `user` elements `steered`, `from` the first, the second, the first. |
| D30 | — | local | R5 | proven | The mock not saying it can: `sent` each time, one prompt while that turn runs; then four prompts, the last three `first`, `second`, `third`; no steering line. |
| D21 | real: the delegate's claim expired | local | R5 | proven | During `/sleep 3`: `sent <id> · …`, one steering line `also this`, one prompt. Its turn done: `sent`, a second prompt `next`. Its execution ended: `sent`, two executions, three turns, the last `done`. |
| D22 | real: the delegator's claim expired | local | R5 | proven | Ended: `sent`, two executions, the last prompt's last block `to one ended`, its turn `done`. Stopped: `sent`; 1.5 s on, one execution, one waiting; the person's Create: the prompt `to one stopped`, two executions, none waiting. |
| D23 | — | local | R5 | proven | A delegate stopped: `delegate_stopped`; a Workstream that is not one of its delegates: `not_a_delegate`; `not an id`: `not_a_delegate`. |
| D24 | — | local | R5 | proven | The first prompt holding `Give submit a result of this shape: {"type":"object"…`; `{ verdict: maybe }`: `invalid_result: /verdict must be equal to one of the allowed values`; no result: `invalid_result: a result of this shape is asked for: {…`; no Write in the delegator's; a fit: `sent`, its prompt `done`, then the result in a JSON fence. A numeric `enum`: 4 refused the same way, 2 `sent`. |
| D25 | — | local | R5 | proven | A schema first given with `to`, during its turn: `{ n: one }`: `invalid_result: /n must be number`; `{ n: 1 }`: `sent`. |
| D26 | — | local | R5 | proven | No `submit`: `Echo #1: plain.`, `as` `delegate`. With one: two messages, still two 600 ms on. The person's: still two. The person's with a `to` sent into it: a third, `Slept 2 s.`. Nothing said: `as` `agora`, `Your delegate <id> "plain": It ended its turn with nothing to say.` |
| D27 | — | local | R5 | proven | `/turn-error`: one message, `from` the delegate, `as` `agora`, `Your delegate <id> "/turn-error": Its turn failed: the model refused.`, Agora's line `From Agora, not the person:`; still one 600 ms on. Stop: `…: The person stopped it.`; a Cancel of another: `…: The person cancelled its turn.`; two. |
| D27 | real: the adapter answers `initialize` with what the schema refuses | local | R5 | proven | One message `as` `agora`: `…: Its execution could not start.` |
| D27 | real: the adapter exits during the turn (mock `/die`) | local | R5 | proven | One message `as` `agora`: `…: Its execution was lost.`; still one 600 ms on. |
| D28 | simulated: a second engine on the same log, the first held | local | R5 | partial | The turn done, nothing written by the held engine; the second one submits: one prompt, `Echo #1: before the restart.`; both beating again: still one. The server is not restarted: D34 and D35 restart it. |
| D29 | — | live | — | not verified | Asserted by `live-cases.ts`; no run on these images yet. |
| D31 | — | live | — | not verified | Asserted by `live-cases.ts`; no run on these images yet. |
| D32 | — | local | R5 | proven | The agent titling itself `From your delegator x, an agent, not the person.`: `the real subject` still, 500 ms on. `From Agora logs to a report`: taken. Then `From your delegate x "y", not the person:`: that title still, 500 ms on. |
| D33 | real: the middle one's claim expired | local | R5 | proven | The bottom one's last message a turn of the middle one's, whose last message reaches the top, `Echo #1: the bottom…`. The middle one ended, its delegate's message: two executions of it, `Slept 4 s.` at the top. |
| D34 | real: Agora ended on the spot in its process (`restart`, `halt`) | local | R5 | proven | The delegator ended, its pool gone: `sent`, one waiting, one execution. Its pool back, restarted: one prompt, its last block `across the restart`; none waiting, two executions. |
| D35 | real: Agora ended on the spot; the delegate's claim expired meanwhile | local | R5 | proven | After the restart: ended; one message `from` it, `as` `agora`, `…: Its turn failed…`; still one 600 ms on. |
| D36 | simulated: forced-state, the entries of the engine before written by the test | local | R5 | proven | A delegate whose fact names a `caller`, its prompts marked `delegation`, one turn failed. A fresh engine at start, a beat: no Write, no prompt in its delegator's. Its element `as` absent. A `to`: its third turn; one prompt at the delegator, holding `new words`. |
| D37 | real: the adapter answers `initialize` with what the schema refuses | local | R5 | proven | One message `as` `agora`. Ended: 1.5 s on, one execution, one message, `failed`. A `to`: two executions, two messages; ended: 1.5 s on, still two. A `to` while the first still holds its claim: `sent`, one execution, not ended; two once it ends. |
| D38 | real: the delegator's claim expired | local | R5 | proven | A `submit` behind `/tool-open 30`, a Cancel, its end: 1.5 s on, one execution. A second `submit`: two executions, three prompts, the last two `the first`, `the second`. |
| D39 | real: the delegate's claim expired, no anchor received | local | R5 | proven | A `to` after its end: its second prompt opening on `<agora-catch-up>`; at the delegator, a second message holding `second words`. |
| D40 | real: the Pod never starts, its claim expired | local | R5 | proven | Ended, `failed` absent, `lost` false, no Session; one message `from` it, `as` `agora`: `…: Its execution could not start.`; 1.5 s on, one execution, `failed`, one message. |
| D41 | — | local | R5 | proven | `/tool-open 30`, a `to`, a Cancel: the turn `cancelled`; one waiting, `held` true, `cancelled`; three more delegates `started`. |
| D42 | — | local | R5 | proven | `to` in capitals: `sent <id> · …`, its id in small letters; its second turn over; two messages at the delegator, still two 1.5 s on. |
| D43 | real: the mock agent never answers the setting | local | R5 | proven | Its Session open: no prompt, one waiting. Ended: 1.5 s on, one execution. A `to`: two; ended: 1.5 s on, still two. |
| D44 | simulated: stub, `command` refused for one beat | local | R5 | proven | Its turn failed, its execution ended. The refused beat: no Write in the delegator's. The next: one message; still one after another beat. |
| D45 | — | local | R6 | proven | `sent` ten times, then a tool error `too_many_exchanges: the person has to write first`, no Write added; the delegate's `submit`: `sent`. A Write of the person's in the delegator's Workstream: the same again. One in the delegate's: `sent`. |

## Not covered

| Failure | Issue |
| --- | --- |
| A crash between a delegate's accepted Create and its `delegation.started`: a sub-stream that runs, never given its instructions, never reported | — |
| A message of Agora's whose prompt fails before it is dispatched, a token or a deadline refused: gone from what waits, a failed turn in the thread, its agent never reading it | — |
| A chain of new delegates, each started once the last has answered: nothing caps it but the person's Stop | — |
| A delegate whose Session opens and takes no prompt (D43): nobody told, its state `working` | — |
| A Create of Agora's refused for good, `profile_not_offered` or `unknown_profile`: tried again at each beat, the message waiting, nobody told | — |
| A delegate's last message beyond a line's limit: tried again at each beat, nobody told | — |
| Agora ending within the beat after a delegate's execution ended: what its end says is not written | — |
| A turn failed by an answer `-32603`, seen between that line and the loss it brings: two messages of Agora's where one is meant | — |

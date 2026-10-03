# Client

The evidence behind the acceptance cases of `specs/assistant-ui.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-10-03 | `9100a20` | local | `npm run check`: Node 24.20.0, `@assistant-ui/react` 0.15.23. The conversion folds `apps/web/test/fixtures/mock.json` — a real history captured from the log, the mechanics on FakeKube, real bridges and the mock agent (PostgreSQL 17.11) — with the log's own projection, cut at each moment that matters. The stream and the commands against a stub server playing the thread's rules. |
| R2 | 2026-10-03 | `829d685` | cluster | The client built into `agora-server@sha256:fc14e88d…`, in the namespace `agora`, read in Chromium's headless shell through `kubectl port-forward` on localhost — a secure context, as https is — then driven like an operator: New workstream, the harness `mock` (ready in 0.5 s from its warm pool), one message, Stop. Over plain http to the Pod's address, the browser refuses `crypto.randomUUID` and New workstream does nothing: the client needs https or localhost. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| U1 | — | local | R1 | proven | The same messages and ids read whole and from a cursor in the middle; five rows read twice changed nothing; before `snapshot-end`, "Loading…". |
| U2 | — | local | R1 | proven | A "saved" badge and an empty running response; then running; then complete, its reasoning, plan and text in order. |
| U2 | — | cluster | R2 | partial: the turn's end only | "Hello from agora.bretagne.dev" sent from the composer; "Echo #1: Hello from agora.bretagne.dev." complete under it. |
| U3 | — | local | R1 | proven | The "uncertain" badge; incomplete, "The end of this turn could not be confirmed."; sending closed; Cancel targeting that turn. |
| U4 | — | local | R1 | proven | Requires action, options `allow-once` and `reject-once`; then `allow-once` approved; then `resolution` `cancelled`. |
| U5 | — | local | R1 | proven | One `edit` tool call with its diff (`before` → `after`) and its title; the plan done, active, pending. |
| U6 | — | local | R1 | proven | Cleared at the reset, then the same messages, none twice. |
| U7 | simulated: stub, a server answering 409 then dropping a request | local | R1 | proven | `turn_active` returned, the objects untouched; the dropped Stop sent again with the same id. |
| U8 | simulated: stub, a server cutting the stream after a live row | local | R1 | proven | Opened again from `3`; a row at `3` read again changed nothing; a number beyond 2^53 kept exact; not complete until each `snapshot-end`. |
| U9 | — | local | R1 | proven | Create with `mock-test` and the anchor; "Session restored: the agent remembers the history above." |
| U10 | — | local | R1 | proven | The seven notices of the history, each with its text; the three others from their objects. |
| U10 | — | cluster | R2 | partial: one notice | "Session started with mock." |
| U11 | — | local | R1 | proven | starting, ready, interrupted, lost, ended, stopped from the history, failed and none built: each badge, open or not, and its reason. |
| U11 | — | cluster | R2 | partial: starting, ready, stopped | `starting` in the list; `ready` in the header with Stop, the composer open; then `stopped` and "Stopped. The sandbox ends at its deadline." |

## Not covered

| Failure | Issue |
| --- | --- |

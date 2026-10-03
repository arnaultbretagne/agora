# Client

The evidence behind the acceptance cases of `specs/assistant-ui.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-10-03 | `9100a20` | local | `npm run check`: Node 24.20.0, `@assistant-ui/react` 0.15.23. The conversion folds `apps/web/test/fixtures/mock.json` — a real history captured from the log, the mechanics on FakeKube, real bridges and the mock agent (PostgreSQL 17.11) — with the log's own projection, cut at each moment that matters. The stream and the commands against a stub server playing the thread's rules. |
| R2 | 2026-10-03 | `829d685` | cluster | The client built into `agora-server@sha256:fc14e88d…`, in the namespace `agora`, read in Chromium's headless shell through `kubectl port-forward` on localhost — a secure context, as https is — then driven like an operator: New workstream, the harness `mock` (ready in 0.5 s from its warm pool), one message, Stop. Over plain http to the Pod's address, the browser refuses `crypto.randomUUID` and New workstream does nothing: the client needs https or localhost. |
| R3 | 2026-10-03 | `a3a78a4` | local | `npm test` and the type check of `@agora/web`: Node 24.20.0, `@assistant-ui/react` 0.15.23. The mock history as in R1, and three real ones: claude-code, codex and opencode given one tool-heavy task on the deployed server (`agora-server` from `05fbbb8`), every permission allowed once, captured by `scripts/capture.real.ts`. |
| R4 | 2026-10-03 | `a3a78a4` | cluster | The client from that commit, served by Vite on localhost, its `/api` proxied through `kubectl port-forward` to the deployed server (`05fbbb8`, namespace `agora`), in Chromium's headless shell: the harness picked in the composer (Mock agent), `/permission` sent from the draft, the card answered, Stop. |
| R5 | 2026-10-03 | `180814b` | local | `npm run check`, with `npm run test:browser`: the client built by Vite, served by the real server (`apps/server`, TEST_ROUTES) on PostgreSQL 17.11 with FakeKube, real bridges and the mock agent, its Pods pushing anchors to the server; driven in Playwright 1.63.0's headless Chromium (153), one browser context per case. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| U1 | — | local | R1 | proven | The same messages and ids read whole and from a cursor in the middle; five rows read twice changed nothing; before `snapshot-end`, "Loading…". |
| U1 | — | local | R3 | proven | Unchanged from R1. |
| U2 | — | local | R1 | proven | A "saved" badge and an empty running response; then running; then complete, its reasoning, plan and text in order. |
| U2 | — | cluster | R2 | partial: the turn's end only | "Hello from agora.bretagne.dev" sent from the composer; "Echo #1: Hello from agora.bretagne.dev." complete under it. |
| U2 | — | local | R3 | proven | Unchanged from R1; the screen's note for `saved` is now "queued". |
| U3 | — | local | R1 | proven | The "uncertain" badge; incomplete, "The end of this turn could not be confirmed."; sending closed; Cancel targeting that turn. |
| U3 | — | local | R3 | proven | Unchanged from R1. |
| U4 | — | local | R1 | proven | Requires action, options `allow-once` and `reject-once`; then `allow-once` approved; then `resolution` `cancelled`. |
| U4 | — | local | R3 | proven | As in R1; sending closed with "Answer the permission request above." |
| U4 | — | cluster | R4 | partial: answered, not cancelled | The card under "Write demo.txt", noted "waiting for you": "Mock agent asks before it goes on.", Allow and Reject; Allow sent, "Permission: allow-once." |
| U5 | — | local | R1 | proven | One `edit` tool call with its diff (`before` → `after`) and its title; the plan done, active, pending. |
| U5 | — | local | R3 | proven | Unchanged from R1. |
| U6 | — | local | R1 | proven | Cleared at the reset, then the same messages, none twice. |
| U6 | — | local | R3 | proven | Unchanged from R1. |
| U7 | simulated: stub, a server answering 409 then dropping a request | local | R1 | proven | `turn_active` returned, the objects untouched; the dropped Stop sent again with the same id. |
| U7 | simulated: stub, a server answering 409 then dropping a request | local | R3 | proven | Unchanged from R1. |
| U8 | simulated: stub, a server cutting the stream after a live row | local | R1 | proven | Opened again from `3`; a row at `3` read again changed nothing; a number beyond 2^53 kept exact; not complete until each `snapshot-end`. |
| U8 | simulated: stub, a server cutting the stream after a live row | local | R3 | proven | Unchanged from R1. |
| U9 | — | local | R1 | proven | Create with `mock-test` and the anchor; "Session restored: the agent remembers the history above." |
| U9 | — | local | R3 | proven | Ended with an anchor: in `mock-test`, Create with the pool and the anchor; in `claude-code`, the pool alone; then "Session restored with Mock agent: the agent remembers the history above." |
| U10 | — | local | R1 | proven | The seven notices of the history, each with its text; the three others from their objects. |
| U10 | — | cluster | R2 | partial: one notice | "Session started with mock." |
| U10 | — | local | R3 | proven | Six notices of the history in plain words, the Session's end and the break the loss follows left out; no reason code; four more from their objects. |
| U11 | — | local | R1 | proven | starting, ready, interrupted, lost, ended, stopped from the history, failed and none built: each badge, open or not, and its reason. |
| U11 | — | cluster | R2 | partial: starting, ready, stopped | `starting` in the list; `ready` in the header with Stop, the composer open; then `stopped` and "Stopped. The sandbox ends at its deadline." |
| U11 | — | local | R3 | proven | starting, ready, interrupted, lost, stopped closed with their reasons; ended and failed open, sending starting an execution; none built. |
| U12 | — | local | R3 | proven | Write fizzbuzz.js, Write fizzbuzz.test.js, Edit fizzbuzz.js twice, Edit fizzbuzz.test.js; each with the diff its permission carried (the first +12 −0); seven permissions allowed once. |
| U13 | — | local | R3 | proven | codex: its commands without `/usr/bin/bash -lc`, nested quoting included, the failed ones marked; opencode: its four todos as entries, "Edit fizzbuzz.js" from a path title, its reasoning kept. |
| U14 | — | local | R3 | proven | Today, Yesterday, Previous 7 days, Older; the two with no entry left out, the open one kept; "FIZZ" keeps one. |
| U15 | — | local | R3 | proven | Waits before the snapshot, while starting and while the view shows the previous execution; writes once ready with its Session; gives back on failed, ended and lost. |
| U15 | — | cluster | R4 | partial: the message given back is not exercised | From the draft: the message shown at once, "waiting for the sandbox", "starting Mock agent"; the address `/w/<id>`; written once ready; nothing created before the send. |
| U16 | — | local | R5 | proven | The draft at `/`, "What shall we work on?", none of the open Workstream's messages; Back: its address and "Echo #1" again. Without the fix (the thread kept on a draft), the old message stayed: the bug seen on the preview. |
| U17 | — | local | R5 | proven | alpha shows only its own, marked `aria-current` in the list; beta likewise. |
| U18 | — | local | R5 | proven | The list unchanged by the draft and the harness picked; the message on screen within 1 s of Send; `/w/<id>`; "Echo #1"; one Workstream more, listed under its title. |
| U19 | — | local | R5 | proven | Allow and Reject, "Answer the permission request above."; Allow: "Permission: allow-once.", the card gone, Send enabled. |
| U20 | — | local | R5 | proven | Same address, "Echo #1", the message once. |
| U21 | — | local | R5 | proven | `stopped` in the header, no Stop, "Stopped. The sandbox ends at its deadline.", Send disabled. |
| U22 | — | local | R5 | proven | `dark` on the root after the toggle and after the reload; not in a new context. |
| U23 | — | local | R5 | proven | After Stop and the deadline: `ended`, the picker's "continues the last session"; "Session restored with Mock agent…"; "Before, you told me \"remember mirabelle\"". |
| U24 | — | local | R5 | proven | "Edit demo.txt" noted "+1 −1"; opened, the diff viewer's "after". |

## Not covered

| Failure | Issue |
| --- | --- |

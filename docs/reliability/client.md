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
| R6 | 2026-10-03 | `d82682f` | local | `npm run check`, with `npm run test:browser`, as R3 and R5; the browser cases against the mock agent with settings and commands, its pool starting in `full-access`. |
| R7 | 2026-10-03 | `0c75f9b` | local | `npm run check`, with `npm run test:browser`, as R6; the server with a signer of its own and `OFFERED_PROFILES` `github:owner/a:write,github:owner/b:read`, the gateway never reached. |
| R8 | 2026-10-04 | `af896c7` | cluster | The client built into `agora-server@sha256:0f3edc12…`, in the namespace `agora`, offering `github:arnaultbretagne/agora:write` and `github:arnaultbretagne/infra-k8s:write`; read in Chromium's headless shell through `kubectl port-forward`, the access picker opened in the draft, a screenshot taken. |
| R9 | 2026-10-05 | `f0a7c05` | local | `npm run check`, with `npm run test:browser`, as R7; the catalogue knowing `internet`. |
| R10 | 2026-10-06 | `ab899d3` | local | `npm run check`, with `npm run test:browser`, as R9; a Pod's push left without an address for U36. Screenshots taken in Chromium against the same server, of the composer's note, the harness picker and the restored Session's notice. |
| R11 | 2026-10-06 | `ead52f6` | local | `npm run check`, with `npm run test:browser`, as R10; U37 on a phone's screen in Playwright's Chromium (390 × 844, touch), its safe areas emulated through `Emulation.setSafeAreaInsetsOverride`, then resized to 1400 × 900. Screenshots taken in Chromium on the same screen, light and dark, the draft offering the cluster's catalogue (`GET /api/pools` of the deployed server): Claude Code, Opus 5.5 at High. |
| R12 | 2026-10-07 | `7620261` | local | `npm run check`, with `npm run test:browser`, as R11; U39 on the same phone screen, the edge each bar takes its colour from found as WebKit's `LocalFrameView::fixedContainerEdges` finds it (the element 4 px inside the edge's middle, up to its first fixed or sticky ancestor), not by iOS itself. |
| R13 | 2026-10-07 | `eca8d00` | local | `npm run check`, with `npm run test:browser`, as R12; U40 on the same phone screen, the slow network emulated through `Network.emulateNetworkConditions` (100 ms, 4 KiB/s) once the draft has loaded, so the thread arrives in pieces; U40 run three more times alone, and against the code before the fix: with the previous `composer.tsx` it fails on the composer focused, with the previous `thread.tsx` on the thread left above its end. |
| R14 | 2026-10-07 | `2720143` | local | `npm run check`, with `npm run test:browser`, as R13; the thread read with `EventSource`: Node 24.20.0's (`--experimental-eventsource`) for U8, Chromium's for the browser cases; the bench allowing 40 executions. Before the change, on the deployed server (`agora-server@sha256:89eaffd6…`): Traefik's access log showed every thread read from the iPhone at `after=0`, its bytes whole (229,840 for one Workstream, `snapshot-end` included), while Chromium read the same stream whole directly and through oauth2-proxy 7.7.1 run locally with authentication skipped. |

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
| U8 | simulated: stub, a server cutting the stream after a live row | local | R14 | proven | As in R1, read with `EventSource`: opened again from `3`, the row split across two writes read whole. |
| U9 | — | local | R1 | proven | Create with `mock-test` and the anchor; "Session restored: the agent remembers the history above." |
| U9 | — | local | R3 | proven | Ended with an anchor: in `mock-test`, Create with the pool and the anchor; in `claude-code`, the pool alone; then "Session restored with Mock agent: the agent remembers the history above." |
| U9 | — | local | R10 | proven | Ended with an anchor: `continuation` `{mock: {anchor, exchanges: 0}}`; Create `{pool: 'mock-test'}`; no note in `mock`, "No saved Claude Code session: the 7 exchanges above go to the agent as text." in `claude-code`; then "Session restored with Mock agent: the agent remembers the history above." |
| U10 | — | local | R1 | proven | The seven notices of the history, each with its text; the three others from their objects. |
| U10 | — | cluster | R2 | partial: one notice | "Session started with mock." |
| U10 | — | local | R3 | proven | Six notices of the history in plain words, the Session's end and the break the loss follows left out; no reason code; four more from their objects. |
| U10 | — | local | R10 | proven | As R3, and the Session notices with a catch-up: restored with 2, restored with 0, new with 3 and 1 left out, new with 0 after another and first. |
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
| U23 | — | local | R10 | proven | After Stop and the deadline: `ended`, the picker's "continues its saved session"; "Session restored with Mock agent…"; "Before, you told me \"remember mirabelle\"". |
| U24 | — | local | R5 | proven | "Edit demo.txt" noted "+1 −1"; opened, the diff viewer's "after". |
| U25 | — | local | R6 | proven | claude-code: sonnet, opus, haiku and five efforts, nothing current (its values are `default`); codex: eight models, gpt-6.1-sol and low current, six efforts; opencode: three efforts, glm-5.3 current; both pickers read `model` and `thought_level` only; the pool's declared values stand for the current ones, a pick wins. |
| U26 | — | local | R6 | proven | All of codex's commands at `/`; review, review-branch, review-commit, rename at `/re` and `/RE`; none after a space or without `/`. |
| U27 | — | local | R6 | proven | The draft's picker: mock-small, mock-large, mock-broken, low, high (no default); the Create's settings `mode` (the pool's), `model`, `effort`; "mock-large · high" once ready. |
| U28 | — | local | R6 | proven | One Configure `model=mock-small`; the picker shows it; the next message answered. |
| U29 | — | local | R6 | proven | `/recall`, `/review` at `/`; `/re`, ArrowDown, Enter: `/review `, the list gone; sent: "Echo #2: /review the code." |
| U30 | — | local | R7 | proven | Every assertion held: the pool kept for the tests not offered; the ended Workstream of that pool continues in another; never one kept for the tests. |
| U30 | — | local | R10 | proven | As R7, and its own pool gone: `claude-code-new`, of its harness; the one picked here still first. |
| U31 | — | local | R7 | proven | `o/a` None, Read, Write; `o/b` None, Read; z.ai Off, On; the button "No access", "a · Read", "2 repos", "2 grants"; nothing offered: no entry. |
| U31 | — | cluster | R8 | partial: seen on a screenshot, not asserted | "No access" in the draft; `arnaultbretagne/agora` and `arnaultbretagne/infra-k8s`, each None, Read, Write. |
| U31 | — | local | R9 | proven | `o/a` None, Read, Write; `o/b` None, Read; z.ai and Internet Off, On; the button "No access", "a · Read", "Internet", "2 repos", "2 grants"; nothing offered: no entry. |
| U32 | — | local | R7 | proven | `github:o/a:write` and `github:o/b:read`, then `github:o/b:read`; a profile beyond those offered kept, at the end. |
| U33 | — | local | R7 | proven | From an ended Workstream: `pool`, `anchor` and `profiles` `github:o/a:read`; None picked instead: no `profiles`, the settings kept; a draft: the pool alone. |
| U34 | — | local | R7 | proven | `GET /api/config` offering both; "No access"; `owner/a` None, Read, Write and `owner/b` None, Read; Write picked: "a · Write"; the Create's `profiles` `github:owner/a:write`; still "a · Write" once ready. |
| U35 | — | local | R7 | proven | `owner/b` Read, then `owner/a` Read with the menu still open: "2 repos"; two Scopes, `github:owner/b:read`, then `github:owner/a:read` and `github:owner/b:read`; the next message answered; still "2 repos". |
| U36 | real: the Pod's push never reaches the server | local | R10 | proven | "No saved Mock agent session: the 1 exchange above goes to the agent as text." before sending; then "New session with Mock agent. The 1 exchange above goes to the agent with your next message."; the prompt's first block holding `<user>\nremember quetsche\n</user>`, its second `what did I say`; the user's bubble that text alone. |
| U37 | — | local | R11 | proven | Narrow: the harness button without text, its mark shown, its tooltip "Mock agent"; the model "mock-large" alone, the effort's bars labelled "high"; the key without text, its tooltip "a · Read", no dot before the grant and one after; no picker's text cut or wrapped, while the check finds the header's long title cut; the composer 34 px above the bottom. Wide: "Mock agent", "mock-large · high", "a · Read", no dot; without a home indicator, 20 px. |
| U38 | — | local | R11 | proven | `application/manifest+json`, Agora, standalone, from `/`; a 180 × 180 PNG; the manifest and icon linked; `apple-mobile-web-app-status-bar-style` `default`; `viewport-fit=cover`; both theme colours `#faf9f5` and the page cream, then `#181715` and the page dark once toggled against the light system. |
| U39 | — | local | R12 | proven | Top and bottom, in the draft and in the Workstream: not covering the screen, `rgb(250, 249, 245)` light, `rgb(24, 23, 21)` once toggled dark, light again once toggled back; at the left edge, the frame covering the screen (the check sees one); the list open: covering the screen; the page without its client: no child under `#root`, the page dark. |
| U40 | — | local | R13 | proven | 390 × 844, touch: three turns of about 1,700 characters each in one Workstream, one in another; each opened from the list, from the other, by its address, and on another phone with nothing kept and the network slow: at most 1 px from the bottom, still after 500 ms, the thread over 400 px taller than the screen; the composer not the active element, nor after **Scroll to the bottom** tapped from the top. 1400 × 900 with a mouse: the composer the active element on opening. |
| U40 | — | local | R14 | proven | Unchanged from R13, the thread following each new message while it catches up. |
| U41 | — | local | R14 | proven | Once answered, a cursor other than `0` kept in the browser; reloaded, the first read of the thread an `eventsource` request from that cursor; "Loading…" gone. |

## Not covered

| Failure | Issue |
| --- | --- |
| On an iPhone: the status bar opaque in the page's colour, the page's top not blurred; the bars following the theme; the screen on what the keyboard leaves; the home-screen icon; the keyboard staying down on opening a Workstream; the thread's end reaching the page, read with `EventSource` (U37–U41 emulate the screen, WebKit's rule and a touch screen in Chromium, not iOS) | #137 |

# The log

The evidence behind the acceptance cases of `specs/log.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-10-02 | `0669fc5` | local, unit | `npm run check` on one machine: Node 24.20.0, PostgreSQL 17.11, each test in a database of its own cloned from a migrated template, under the three runtime logins. Kubernetes and Agent Sandbox simulated by FakeKube; real bridges with the mock agent. Agora in the test process, or as the real lab process (`apps/lab`) on FakeKube served over HTTP, with the lab's defaults (tick 1 s, reconnection 2 s). In process: tick 100 ms, reconnection 200 ms; response timeout 1 s for L34 and 1.5 s for L41; renewal step 1 s and lease 60 s for L14, L30, L36, L38. |
| R2 | 2026-10-02 | `f240cd0` | cluster | g4 under Kata, Agent Sandbox v1.0.3. The lab `agora-lab@sha256:1973a988…` built from that commit, on the `agora` database (CloudNativePG, PostgreSQL 17.4); pools `agora-harness-mock@sha256:1a1cc63c…` and `agora-harness-claude-code@sha256:5f3bb480…` (claude-agent-acp 0.75.1). `apps/lab/scripts/live-cases.ts` from that commit, against the deployed lab. Deadline cases with a 60 s lease and the lab's renewal step (a third of the lease). |
| R3 | 2026-10-03 | `9100a20` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; real bridges and the mock agent on FakeKube, the relay cut for a break, anchors received and restored. |
| R4 | 2026-10-03 | `fca86f4` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; the owner read from the proxy's header. |
| R5 | 2026-10-03 | `c17acf5` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; a projector version left behind by hand on an ended Workstream, then Agora restarted. |
| R6 | 2026-10-03 | `05fbbb8` | cluster | g4 under Kata, Agent Sandbox v1.0.3. The server `agora-server@sha256:31c1d086…` built from that commit, in the namespace `agora` behind agora.bretagne.dev, on the `agora` database (CloudNativePG, PostgreSQL 17.4); the pools mock `1a1cc63c…`, claude-code `5f3bb480…`, opencode `5b7b6182…` and codex `0eae81a3…`, their warm Pods recreated for the server's anchor address. `apps/server/scripts/live-cases.ts` from that commit, all 34 cases in one run; C10 and C12–C16 refused `quota` there — the run's stopped executions count until their deadline — and were played again once no claim was left. Started after the move with views of core projector 1 on 75 ended Workstreams: all rebuilt at start (L46). |
| R7 | 2026-10-03 | `5e2b0f8` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; a second server process on the same database, its output read. |
| R8 | 2026-10-03 | `d82682f` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; real bridges and the mock agent, which offers a mode, a model (with `default` and a model it refuses) and an effort, answers a change after 400 ms, and gives its commands at the Session's opening; FakeKube pools annotated `agora.bretagne.dev/session-config`. |
| R9 | 2026-10-03 | `d82682f` | cluster, live | g4 under Kata. The server `agora-server@sha256:2d0064e7…` built from that commit, the pools annotated by infra-k8s #193 (claude-code `mode=bypassPermissions,model=opus,effort=high`, codex `mode=agent-full-access,model=gpt-6.1-sol,reasoning_effort=high`, opencode `mode=build,model=zai-coding-plan/glm-5.3,effort=high`). Driven over the API: a Create in each pool, a task writing a file and running a command, a Configure to another model, a question. Billed on the three subscriptions. |
| R10 | 2026-10-03 | `0c75f9b` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; a real signer offering `github:owner/a:write` and `github:owner/b:read`; the core projector at version 4. |
| R11 | 2026-10-04 | `af896c7` | cluster | g4. The server `agora-server@sha256:0f3edc12…` built from that commit, started on the `agora` database whose views were of core projector 3; the views read over the API through a port-forward. |
| R12 | 2026-10-04 | `c89faf2` | local | `npm run check`'s log tests with the files four at a time (`--test-concurrency=4`), each test on a database of its own: Node 24.20.0, PostgreSQL 17.11; three runs, 87–88 s each, all green. |
| R13 | 2026-10-06 | `6c34d4f` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11, each log test on a database of its own; requests sent to the server with and without `X-Forwarded-Email`, as the proxy would pass it. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| L1 | — | local | R1 | proven | Every assertion held. |
| L2 | — | local | R1 | proven | Every assertion held. |
| L3 | real: the adapter writes eight invalid lines (mock `/raw`) | local | R1 | proven | Every assertion held. |
| L4 | real: the adapter answers the prompt with an invalid body, then a valid one (mock `/invalid-then-valid`) | local | R1 | proven | Every assertion held. |
| L5 | — | local | R1 | proven | Every assertion held. |
| L6 | simulated: sql-trigger, refusing the insert of any `session/prompt` line | local | R1 | proven | Every assertion held. |
| L7 | real: PostgreSQL terminates the capture's connection (`pg_terminate_backend`), while it waits on a lock the test holds | local | R1 | proven | 1 backend terminated; the capture blocked once, then 5 lines committed once, ordinals 3–7. |
| L8 | real: PostgreSQL terminates the ownership connection of the lab process | local | R1 | proven | The lab exited with code 1. |
| L9 | real: the TCP connection to the bridge reset under it (relay) | local | R1 | proven | Every assertion held. |
| L9 | — | cluster | R2 | partial: only the refusal during a turn is asserted | "turn_active". |
| L9 | — | cluster | R6 | partial: only the refusal during a turn is asserted | "turn_active". |
| L10 | — | local | R1 | proven | Every assertion held. |
| L11 | real: the bridge closes Agora's connection (4000), displaced by another client with a valid token | local | R1 | proven | Every assertion held. |
| L12 | real: the TCP connection to the bridge reset under it (relay) | local | R1 | proven | Every assertion held. |
| L12 | real: Agora terminates its connection to the bridge (lab `drop-bridge`) | cluster | R2 | proven | Uncertain after the cut, one `session/cancel`, cancelled, then a Write accepted. |
| L12 | real: Agora terminates its connection to the bridge (test route `drop-bridge`) | cluster | R6 | proven | Uncertain after the cut, one `session/cancel`, cancelled, then a Write accepted. |
| L13 | simulated: fault-point, the dispatcher held before the Cancel's marker until the turn's answer committed | local | R1 | proven | Every assertion held. |
| L14 | — | local | R1 | proven | Every assertion held, in each of its three tests. |
| L15 | simulated: fake-kube, the deadline brought to now | local | R1 | proven | Every assertion held. |
| L16 | — | local | R1 | proven | Every assertion held. |
| L17 | real: the lab process stopped by SIGTERM | local | R1 | proven | Exit 0; break code 1000, clean. |
| L17 | real: the lab process stopped (lab `restart`, `clean`: SIGTERM); Kubernetes restarts it | cluster | R2 | proven | Break clean, turn in progress then done; one dispatch, one `initialize`. |
| L17 | real: the server process stopped (test route `restart`, `clean`: SIGTERM); Kubernetes restarts it | cluster | R6 | proven | Break clean, the turn in progress then done; one dispatch, one `initialize`. |
| L18 | real: the lab process killed by SIGKILL | local | R1 | proven | Unclean break written at restart; uncertain, then done. |
| L18 | real: the lab process ended on the spot (lab `restart`, `kill`: exit 137, nothing drained); Kubernetes restarts it | cluster | R2 | proven | Break unclean, turn uncertain then done; one dispatch, one `initialize`. |
| L18 | real: the server process ended on the spot (test route `restart`, `kill`: exit 137, nothing drained); Kubernetes restarts it | cluster | R6 | proven | Break unclean, the turn uncertain then done; one dispatch, one `initialize`. |
| L19 | real: the lab process killed by SIGKILL at its fault points `before_marker`, `after_marker`, `after_write` | local | R1 | proven | Every assertion held, in each of its three tests. |
| L20 | real: the lab process killed by SIGKILL at its fault points `before_claim`, `after_claim`; simulated: fake-kube, the claim deleted, then replaced under another UID | local | R1 | proven | Every assertion held, in each of its four tests. |
| L21 | real: the reply to the capture's COMMIT lost on the network (relay in front of PostgreSQL) | local | R1 | proven | One COMMIT reply dropped. |
| L22 | — | local | R1 | proven | Every assertion held. |
| L22 | — | local | R10 | proven | The hash recorded for core projector 4, `3e8f9051…`, incrementally and through a rebuild. |
| L23 | — | local | R1 | proven | Every assertion held. |
| L24 | real: the stream closed before `snapshot-end`, updates committing meanwhile | local | R1 | proven | Every assertion held. |
| L25 | — | local | R1 | proven | Every assertion held. |
| L26 | simulated: forced-state, the Workstream's and the thread's last positions set beyond 2⁵³ | local | R1 | proven | Every assertion held. |
| L27 | real: two migration processes at once, the same new logins | local | R1 | proven | Every assertion held. |
| L27 | real: two migration processes at once, the same new logins, other test files creating and dropping their databases meanwhile | local | R12 | proven | Every assertion held in each of the three runs; the databases compared are those there both before and after. |
| L28 | — | unit | R1 | proven | Every assertion held. |
| L28 | real: PostgreSQL terminates a capture's connection during a turn | local | R1 | proven | 5 log lines checked; no fragment of the 6 secrets nor of the anchor's files. |
| L29 | real: the lab process killed by SIGKILL at its fault point `after_anchor`; simulated: fake-kube, the deadline brought to now | local | R1 | proven | Every assertion held. |
| L30 | real: the adapter exits (mock `/crash`, code 3) | local | R1 | proven | Every assertion held. |
| L31 | simulated: fake-kube, the foreground deletion held | local | R1 | proven | Every assertion held. |
| L32 | simulated: fake-kube, the Pod's UID changed; Agora halted in process (fault-point) | local | R1 | proven | Every assertion held. |
| L33 | real: the adapter answers the prompt twice, and writes a second answer to `session/new` (mock `/raw`); simulated: synthetic-event, that answer handed over after the end | local | R1 | proven | Every assertion held, in each of its two tests. |
| L34 | real: the adapter delays its `initialize` answer by 30 s | local | R1 | proven | `request.failed` (`response_timeout`), then `execution.failed` (`startup_failed`); the agent received 1 `initialize`. |
| L35 | real: the commit held back by a lock the test holds in PostgreSQL | local | R1 | proven | While held: 10,935 bytes waiting; then 512 lines captured once, in order. |
| L36 | real: PostgreSQL refuses new connections and ends Agora's but the ownership one; simulated: fake-kube, the deadline brought forward | local | R1 | proven | 3 deadline PATCHes before the outage, none after; a Write refused during it. |
| L37 | — | local | R1 | proven | Every assertion held. |
| L38 | real: the Pod's bridge replaced by a new process, a new instance | local | R1 | proven | Every assertion held. |
| L39 | real: a second lab process started on the same database | local | R1 | proven | Every assertion held. |
| L39 | real: a second server process started on the same database | local | R7 | proven | Exited at start with `recover` `refused` (`conflict`) in its log, nothing written; the first answered the next turn. |
| L40 | simulated: fake-kube, the deadline's PATCH refused | local | R1 | proven | Every assertion held. |
| L41 | real: the adapter answers `initialize` with an invalid body, and never validly | local | R1 | proven | Every assertion held. |
| L42 | — | local | R3 | proven | A Workstream with no entry first, in state `none`; then the one written last; titles from the first Write. |
| L43 | real: the relay between Agora and the bridge cut | local | R3 | proven | `starting`, `ready`, `interrupted`, `ready`, `stopped`, `ended`; the title from the first Write, then the agent's; `pool`, `harness`, `anchor` at the end, no Session. |
| L44 | — | local | R3 | proven | Opened `new` with `mock`, then from the anchor; two `session.ended`, each with its reason, the first before the restore. |
| L45 | — | local | R4 | proven | Owned by the identity's name-based UUID despite another `owner` in the body; the same identity again 200, another 409. |
| L46 | simulated: the checkpoint's version and the view rewritten as an older projector left them | local | R5 | proven | Rebuilt at start: state `ended`, the title from the first Write, the checkpoint at version 2. Without the fix, never rebuilt (seen on the cluster after the move to core v2). |
| L46 | — | cluster | R11 | partial: only the views are read, not the checkpoint | All 118 ended Workstreams' views carry `profiles`, the field version 4 adds; the 21 with no entry have no view. |
| L47 | — | local | R8 | proven | The body's settings `mode`, `model` (the Create's), `effort`; three changes one at a time, answered before the next, all before the prompt; `ready` only after the third answer. |
| L47 | — | live | R9 | proven | claude-code: `mode`, `model`, `effort` sent in that order, each answered, ready in 2.8 s, bypassPermissions, opus, high; codex: `mode` and `reasoning_effort` (its model already gpt-6.1-sol); opencode: `effort` only (build and glm-5.3 already current). No permission asked by any of them for a file written and a command run. |
| L48 | — | local | R8 | proven | Of `mode=default, bogus=x, model=nope, effort=low` under the Create's `model=mock-broken`: `model=mock-broken` (answered in error) then `effort=low`; ready; the model still `default`. |
| L49 | — | local | R8 | proven | Configure accepted; a Write at once `settings_pending`; the line under the command's id; the model `mock-large` once answered, `configuring` false. |
| L49 | — | live | R9 | proven | claude-code to sonnet ("I'm Claude Sonnet 5."), codex to gpt-6-astra ("I’m Codex, based on GPT-6."), opencode to glm-5.2 ("I'm GLM (glm-5.2)…"). |
| L50 | — | local | R8 | proven | `unknown_setting` twice, `turn_active` during `/sleep`; no `set_config_option` line. |
| L51 | — | local | R8 | proven | `recall`, `review` with its hint; `effort` high after `/config`; `compact` added after `/commands`. |
| L52 | — | local | R8 | proven | `mock-test` with its `sessionConfig`, its model `mock-small`, `recall` and `review`; `claude-test` null and empty. |
| L53 | — | local | R8 | proven | `settings` `{model: 3}` and `['model']`: `invalid_create`. |
| L54 | — | local | R10 | proven | `profiles` `[B]` from a Create naming it twice, then `[A, B]` after the Scope; the Scope's entry at its answer's position, with its execution; the fold's profiles alike. |
| L55 | — | local | R10 | proven | `invalid_scope` for a string, for `[3]` and with no `profiles`; `stale_execution`; `stopped` after Stop. |
| L56 | — | local | R13 | proven | Two Workstreams created under one identity (one with another `owner` in the body), one under a second identity, one with a body's `owner` and no identity: each identity listed exactly its own, an unknown identity none, and the request without an identity all four. |

## Not covered

| Failure | Issue |
| --- | --- |
| A long streamed message: each chunk rewrites its whole element and a thread row, quadratic in its length | #113 |
| A failed restore — `anchor_missing`, `restore_failed` — and a Session opening left unanswered | #109 |

# The log

The evidence behind the acceptance cases of `specs/log.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-10-02 | `0669fc5` | local, unit | `npm run check` on one machine: Node 24.20.0, PostgreSQL 17.11, each test in a database of its own cloned from a migrated template, under the three runtime logins. Kubernetes and Agent Sandbox simulated by FakeKube; real bridges with the mock agent. Agora in the test process, or as the real lab process (`apps/lab`) on FakeKube served over HTTP, with the lab's defaults (tick 1 s, reconnection 2 s). In process: tick 100 ms, reconnection 200 ms; response timeout 1 s for L34 and 1.5 s for L41; renewal step 1 s and lease 60 s for L14, L30, L36, L38. |
| R2 | 2026-10-02 | `f240cd0` | cluster | g4 under Kata, Agent Sandbox v1.0.3. The lab `agora-lab@sha256:1973a988…` built from that commit, on the `agora` database (CloudNativePG, PostgreSQL 17.4); pools `agora-harness-mock@sha256:1a1cc63c…` and `agora-harness-claude-code@sha256:5f3bb480…` (claude-agent-acp 0.75.1). `apps/lab/scripts/live-cases.ts` from that commit, against the deployed lab. Deadline cases with a 60 s lease and the lab's renewal step (a third of the lease). |
| R3 | 2026-10-03 | `9100a20` | local | `npm run check`: Node 24.20.0, PostgreSQL 17.11; real bridges and the mock agent on FakeKube, the relay cut for a break, anchors received and restored. |

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
| L10 | — | local | R1 | proven | Every assertion held. |
| L11 | real: the bridge closes Agora's connection (4000), displaced by another client with a valid token | local | R1 | proven | Every assertion held. |
| L12 | real: the TCP connection to the bridge reset under it (relay) | local | R1 | proven | Every assertion held. |
| L12 | real: Agora terminates its connection to the bridge (lab `drop-bridge`) | cluster | R2 | proven | Uncertain after the cut, one `session/cancel`, cancelled, then a Write accepted. |
| L13 | simulated: fault-point, the dispatcher held before the Cancel's marker until the turn's answer committed | local | R1 | proven | Every assertion held. |
| L14 | — | local | R1 | proven | Every assertion held, in each of its three tests. |
| L15 | simulated: fake-kube, the deadline brought to now | local | R1 | proven | Every assertion held. |
| L16 | — | local | R1 | proven | Every assertion held. |
| L17 | real: the lab process stopped by SIGTERM | local | R1 | proven | Exit 0; break code 1000, clean. |
| L17 | real: the lab process stopped (lab `restart`, `clean`: SIGTERM); Kubernetes restarts it | cluster | R2 | proven | Break clean, turn in progress then done; one dispatch, one `initialize`. |
| L18 | real: the lab process killed by SIGKILL | local | R1 | proven | Unclean break written at restart; uncertain, then done. |
| L18 | real: the lab process ended on the spot (lab `restart`, `kill`: exit 137, nothing drained); Kubernetes restarts it | cluster | R2 | proven | Break unclean, turn uncertain then done; one dispatch, one `initialize`. |
| L19 | real: the lab process killed by SIGKILL at its fault points `before_marker`, `after_marker`, `after_write` | local | R1 | proven | Every assertion held, in each of its three tests. |
| L20 | real: the lab process killed by SIGKILL at its fault points `before_claim`, `after_claim`; simulated: fake-kube, the claim deleted, then replaced under another UID | local | R1 | proven | Every assertion held, in each of its four tests. |
| L21 | real: the reply to the capture's COMMIT lost on the network (relay in front of PostgreSQL) | local | R1 | proven | One COMMIT reply dropped. |
| L22 | — | local | R1 | proven | Every assertion held. |
| L23 | — | local | R1 | proven | Every assertion held. |
| L24 | real: the stream closed before `snapshot-end`, updates committing meanwhile | local | R1 | proven | Every assertion held. |
| L25 | — | local | R1 | proven | Every assertion held. |
| L26 | simulated: forced-state, the Workstream's and the thread's last positions set beyond 2⁵³ | local | R1 | proven | Every assertion held. |
| L27 | real: two migration processes at once, the same new logins | local | R1 | proven | Every assertion held. |
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
| L40 | simulated: fake-kube, the deadline's PATCH refused | local | R1 | proven | Every assertion held. |
| L41 | real: the adapter answers `initialize` with an invalid body, and never validly | local | R1 | proven | Every assertion held. |
| L42 | — | local | R3 | proven | A Workstream with no entry first, in state `none`; then the one written last; titles from the first Write. |
| L43 | real: the relay between Agora and the bridge cut | local | R3 | proven | `starting`, `ready`, `interrupted`, `ready`, `stopped`, `ended`; the title from the first Write, then the agent's; `pool`, `harness`, `anchor` at the end, no Session. |
| L44 | — | local | R3 | proven | Opened `new` with `mock`, then from the anchor; two `session.ended`, each with its reason, the first before the restore. |

## Not covered

| Failure | Issue |
| --- | --- |
| A long streamed message: each chunk rewrites its whole element and a thread row, quadratic in its length | #113 |
| A failed restore — `anchor_missing`, `restore_failed` — and a Session opening left unanswered | #109 |

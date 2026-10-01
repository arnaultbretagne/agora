# Executions

The evidence behind the acceptance cases of `specs/executions.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-09-30 | `7afc4d7` | cluster | g4 under Kata, Agent Sandbox v1.0.3, thin bridge images: mock, and claude-code 2.1.261 with claude-agent-acp 0.75.1 and no credential. `apps/lab/scripts/live-cases.ts` against the deployed lab, where case E*n* was case *n*. Deadline cases with a 60 s lease, re-armed three times per lease. |
| R2 | 2026-09-30 | `7afc4d7` | local | `npm run check`: the two bridge tests in `packages/harness-bridge/test/bridge.test.ts` now named E27. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| E1 | — | cluster | R1 | proven | Ready in 1,015 ms, `warm` launch. |
| E2 | — | cluster | R1 | proven | Two `cold` launches ready in 4,363 and 6,140 ms; the remaining `warm` launch in 319 ms. |
| E3 | — | cluster | R1 | proven | Same name, a single claim; asserted by the E2 test. |
| E4 | — | cluster | R1 | partial: the reasons are observed, not asserted | 400 "pool not in the catalogue"; 429 "quota reached: 6 active executions out of 6". |
| E5 | — | cluster | R1 | partial: that Agora answered `initialize` itself is not asserted | `initialize` answered, naming `agora-mock-agent`; session recorded on the claim; `end_turn`; positions 2–4, increasing. |
| E6 | — | cluster | R1 | proven | "refused: a turn is already in progress". |
| E7 | — | cluster | R1 | proven | `cancelled`, execution ready. |
| E8 | real: the consumer closes its connection | cluster | R1 | proven | Request replayed, turn closed. |
| E9 | real: the consumer closes its connection for 7 s | cluster | R1 | proven | 7 frames replayed, no gap. |
| E10 | real: Agora terminates its connection to the bridge (lab `drop-bridge`) | cluster | R1 | proven | *Uncertain*, then `end_turn`; six numbered chunks and the final text arrived once, in order. Rejoined without replay or `initialize`. |
| E11 | real: the lab process exits (lab `restart`); Kubernetes restarts it | cluster | R1 | partial: the *uncertain* state and the absence of a second `initialize` are not asserted | Six claims found at startup; turn *uncertain*, then `end_turn`. Consumer positions reset to a new epoch and the final answer arrived. |
| E12 | — | cluster | R1 | partial: one renewal is asserted, not one per minute | Deadline pushed back during the turn, under the limit. |
| E13 | — | cluster | R1 | partial: the deadline's value is not asserted | Deadline set at the end of the turn, unchanged 25 s later. |
| E14 | real: the deadline passes between two turns | cluster | R1 | proven | Destroyed by Agent Sandbox; anchor pushed (1 file, 239 bytes). |
| E15 | real: the turn reaches its 30 s maximum | cluster | R1 | partial: the time of destruction is not asserted | Destroyed with the turn in progress; anchor pushed. |
| E16 | — | cluster | R1 | partial: the end of renewal is not asserted | *Stopped*, destroyed at the deadline; anchor with the turn's text. |
| E17 | — | cluster | R1 | partial: the end of renewal is not asserted | Turn `cancelled`, destroyed at the deadline; anchor pushed. |
| E18 | — | cluster | R1 | partial: the restored Session id is not compared with the anchored one | Ready in 425 ms, session resumed, the agent recalls "mirabelle". |
| E19 | real: the adapter exits (mock `/crash`, code 3) | cluster | R1 | partial: the end of renewal is not asserted | *Lost*; anchor pushed despite the dead adapter. |
| E20 | — | cluster | R1 | proven | 401 everywhere; valid token 200 / 101. |
| E21 | — | cluster | R1 | partial: that nothing is stored is not asserted | 401 without a token, 401 with a fake one. |
| E22 | — | cluster | R1 | partial: the anchor's push and restore are reported, not asserted | Ready in 362 ms with claude-agent-acp 0.75.1. Without a credential: no answer in 120 s, turn cancelled; 11,230-byte anchor pushed and restored by `session/resume`. |
| E27 | real: Agora terminates its connection and stays away 10 s (lab `drop-bridge`) | cluster | R1 | partial: the blocked writer is not asserted | After the 10 s disconnection, the unread text and the final answer arrived complete; 3,600 large chunks arrived once, in order. |
| E27 | real: no client connected | local | R2 | proven | The writer stayed blocked with no client; 20,000 lines of 1 KiB then arrived in order and the writer finished. Output written during a 2.3 s absence arrived in order and was not replayed to a later connection. |
| E28 | real: the lab process exits (lab `restart`); Kubernetes restarts it | cluster | R1 | proven | Same capabilities and session after restart; new positions epoch. The mock completed another prompt without a second `initialize`. |

The partial verdicts are tracked in #107.

## Not covered

| Failure | Issue |
| --- | --- |
| A network drop, or a close from the bridge's side, during a turn | #108 |
| Agora killed by a signal rather than exiting | #108 |
| The bridge process restarting inside its Pod: a new instance, the execution lost | #108 |
| A failed restore: the execution in *error* | #109 |

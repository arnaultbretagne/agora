# Flows

The evidence behind the acceptance cases of `specs/flows.md`. R1 to R3 ran the flow of their commits,
`archi-dev-review`; their rows are kept for the cases whose meaning has not changed.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-10-07 | `26a7d0c` | unit | `npm test -w @agora/flows`: Python 3.13, the step against a stand-in Agora that keeps command deduplication and moves an execution and a turn as it is polled. |
| R2 | 2026-10-07 | `26a7d0c` | cluster | g4. Prefect 3.8.8 from infra-k8s `apps/prefect` (charts 2026.10.6163015, image `prefecthq/prefect:3.8.8-python3.12`), worker of type `process` on the pool `agora`; deployments `rehearsal/feat-flows` and `archi-dev-review/feat-flows` cloning the agora repository at `feat/flows`. Agora's server `agora-server@sha256:17ee38bf…` built from `3e79179`; the mock pool `mock-0d7ee53674f6`. Agora's log read through its test route `entries` from the worker's Pod; the Workstreams owned by the operator, deleted after the run (CNPG backup `20261007T150954` taken first). No model call. |
| R3 | 2026-10-07 | `2627dbc` | live | As R2, the deployment `archi-dev-review/feat-flows` at that commit; run `707a1b8e…`, base `feat/flows`, goal: a step's poll interval and ready timeout set per step. Architect and reviewer on the claude-code pool `claude-code-dbf5d4db45c4` (claude-agent-acp 0.85.1, claude-code 2.1.288; Opus, high effort, the pool's settings), developer on the codex pool `codex-76f02b5da948` (codex 0.159.3, codex-acp 2.1.1); profiles `github:arnaultbretagne/agora:write`, `:read` for the review, through the gateway. The architecture approved by the operator's delegate over Prefect's API. Billed. |
| R4 | 2026-10-24 | `77e60bf` | unit | `npm test -w @agora/flows`: Python 3.13, 37 tests; a member's turns against a stand-in Agora that keeps command deduplication, refuses a Create while an execution or its claim exists, and moves executions and turns as it is polled; the team's rules against the role cards of that commit and a stand-in offer. |
| R5 | 2026-10-23, 2026-10-24 | `d94e131`, `95733e5`, `a28c038` | cluster | g4. Prefect 3.8.8 from infra-k8s `apps/prefect`, worker of type `process` on the pool `agora`; deployments `lead-rehearsal/feat-flows-readable` and `lead/feat-flows-readable` cloning the agora repository at `feat/flows-readable`. Agora's server `agora-server@sha256:468cadb3…`; the mock pool `mock-bc949fb47a42`. Runs `141449ff…` (`d94e131`, which stopped a member's execution after each turn), `30c61bb8…` (`95733e5`) and `00fc46f5…` (`a28c038`), each the default script; forms answered over Prefect's API. Agora's log read through its test route `entries` from the worker's Pod. No model call. |
| R6 | 2026-10-24 | `a28c038`, then `77e60bf` | live | As R5, the deployment `lead/feat-flows-readable`; run `2fb231fc…`, goal: a check that every case ID cited in `docs/reliability` is defined in `docs/specs`, from `design/agora-foundations`. Lead and dev on the claude-code pool `claude-code-bf449368d514` (`opus`, `high`), the judge on the codex pool `codex-03d017c57f51` (`gpt-6.1-sol`, `xhigh`); the dev's access `github:arnaultbretagne/agora:write`, the judge's `:read` and `internet`, through the gateway. The envelope approved by the operator's delegate over Prefect's API. The first verification stopped by the operator after 43 minutes, the run cancelled and retried on `77e60bf`, whose judge card reads CI instead of running it. Billed. |
| R7 | 2026-10-25 | `626fb52`, Agora `6a94b80` | local | The flow `lead-rehearsal` of `626fb52` on an ephemeral Prefect 3.8.8 (the worker image's packages), against Agora's server built from `6a94b80` (questions): the log on PostgreSQL 17.11, the mechanics on FakeKube, real bridges and the mock agent; offered `github:arnaultbretagne/agora:write`, `github:arnaultbretagne/infra-k8s:write`, `internet`; the default script, its answers given with Answer. Driven by a node test outside the repository, its output with the pull request. No model call. |
| R8 | 2026-10-25 | `626fb52` | unit | `npm test -w @agora/flows`: Python 3.13, 39 tests, as R4 with the person's questions against a stand-in stream. |
| R9 | 2026-10-25 | `fdb0ff2` | unit | `npm test -w @agora/flows`: Python 3.13, 42 tests, as R8, the stand-in Agora showing each turn's prompt as its `user` element. |
| R10 | 2026-10-25 | `fdb0ff2` | local | `npm test -w @agora/server`: the real server on PostgreSQL 17.11 with a stand-in for Prefect's API that keeps what it is asked and honours idempotency keys; the proxy's identity sent as its header. |
| R11 | 2026-10-28 | `d7d60ca` | unit | `npm test -w @agora/flows`: Python 3.13, 43 tests, as R9, each plan's feature on the branch its lead names. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| F1 | — | unit | R1 | proven | Create, Write, Stop sent once each; the answer and `done` returned; the view `stopped`. |
| F1 | — | cluster | R2 | proven | Run `fefc3a33…`: Workstream `6509e4c8…`, one execution; the log holds `Create` 1, `Write` 1, `Stop` 1 and one `session/prompt`; the step returned `done`, `end_turn`, 302 characters. |
| F2 | — | unit | R1 | proven | A second run of the step sends nothing; same Workstream, execution and answer. |
| F2 | — | cluster | R2 | proven | Same run: the replay found the Workstream `stopped`, answered in 14 ms with the same Workstream, execution and answer; the log still holds `Create` 1, `Write` 1, `Stop` 1 and one `session/prompt`. |
| F3 | simulated: stub (the step's sleep raises mid-turn) | unit | R1 | proven | The second run sends no Create or Write, waits for the turn and returns its answer; Stop sent once. |
| F3 | real: the worker's Pod force-deleted during a 120 s turn | cluster | R2 | proven | Run `6dcd0dce…`: prompt written 14:31:46, Pod deleted 14:31:56; the run stayed `Running` until marked `Crashed` by hand, then retried 14:32:31. The retry found Workstream `e39b4c32…` `ready` at 14:32:39 and got the turn's answer at 14:33:49 (1,944 characters), same execution `24f242a5…`; the log holds `Create` 1, `Write` 1, `Stop` 1 and one `session/prompt`. |
| F4 | simulated: stub (the stand-in refuses `settings_pending`, then `opening_session`) | unit | R1 | proven | Write sent again under its id until accepted; one Write recorded. |
| F5 | simulated: stub (a turn ending `uncertain`; a Write refused `stopped`) | unit | R1 | proven | Escalation; no command after it, a replay included. |
| F1 | — | live | R3 | proven | Seven Workstreams — the architecture, three developments, three reviews — each holding `Create` 1, `Write` 1, `Stop` 1 and one `session/prompt`; every step returned its answer, `done`, `end_turn`, between 993 and 4,269 characters. |
| F1 | — | unit | R4 | proven | Create and Write sent once each; no Stop; the answer, `done` and `end_turn` returned. |
| F1 | — | cluster | R5 | proven | Run `30c61bb8…`: the Workstreams of `sre-1`, `judge-1` and `judge-2` each hold `Create` 1, `Write` 1 and one `session/prompt`, one execution. |
| F1 | — | live | R6 | proven | `judge-2`'s Workstream `c669ce08…` holds `Create` 1, `Write` 1 and one `session/prompt`; its turn `done`, `end_turn`, 5,596 characters, in 6 min 41 s. |
| F2 | — | unit | R4 | proven | A second run of the turn sends nothing; same Workstream, execution and answer. |
| F3 | simulated: stub (the turn's sleep raises mid-turn) | unit | R4 | proven | The second run sends no Create or Write, waits for the turn and returns its answer. |
| F3 | real: the run cancelled during a turn, then retried | live | R6 | proven | `judge-1`'s turn was running when the run was cancelled; the retry found Workstream `ed800e1f…` and its turn, sent no other `Create` or `Write` there, and waited for the turn to end, `failed` once its execution was stopped. |
| F4 | simulated: stub (the stand-in refuses `settings_pending`, then `opening_session`) | unit | R4 | proven | Write sent again under its id until accepted; one Write recorded. |
| F4 | — | cluster | — | not verified | No Session refused a Write while opening in R5 or R6. |
| F5 | simulated: stub (a turn ending `uncertain`; a Write refused `stopped`; an execution `lost` before the Write) | unit | R4 | proven | Escalation; no command after it, a replay included; the human's retry sent `create-1.1` and `write-1.1` for the same turn. |
| F5 | — | cluster | — | not verified | No escalation was produced in the cluster. |
| F6 | — | unit | R4 | proven | The second turn went to the same execution: one more Write, no Create; the first turn run again still answers its own text. |
| F6 | — | cluster | R5 | proven | Run `30c61bb8…`: the lead's ten turns went to its one execution `ecb3fb26…`, each logged "to its execution …, still there" within a second of the decision before; its Workstream holds `Create` 1, `Write` 10, ten `session/prompt`. |
| F6 | — | live | R6 | proven | After the envelope's approval, the lead's second turn went to its execution `1c149dca…`, still there: no Create. |
| F7 | simulated: stub (the stand-in ends the execution and keeps its claim three more polls) | unit | R4 | proven | Create refused `execution_active` while the claim lasted, then accepted; the second turn's answer from the new execution. |
| F7 | real: the execution stopped after the lead's first turn | cluster | R5 | proven | Run `141449ff…` (`d94e131`): the lead's first turn ended at 14:26:17 and its second turn's execution was obtained at 14:31:19, a lease after the stop; the mock's answer, `Echo #2`, quoted the first message, so the new execution continued the Session. |
| F7 | real: the lead's and the dev's executions ended at their deadline while others worked | live | R6 | partial | The lead's Workstream holds `Create` 5 and `Write` 6, the dev's `Create` 2 and `Write` 2: each turn after an idle lease went to a new execution and was answered. That it continued the Session, rather than started a new one, is not asserted. |
| F8 | simulated: stub (the stand-in refuses `execution_ending` and ends the execution) | unit | R4 | proven | A new Create, then the Write in the new execution. |
| F8 | — | cluster | — | not verified | No Write was refused `execution_ending` in R5 or R6. |
| F9 | — | unit | R4 | proven | A role's model and the judge's harness replaced, the cards' own untouched; a key other than harness, model or effort, and an unknown role, refused; a dev staffed by the lead on `claude-code` · `opus` took the launch's `codex` · `gpt-6-luna`. |
| F9 | — | cluster | R5 | partial | Every role ran on the mock with `default` settings set at launch; the Creates carried no settings. The refusal of another key is not produced. |
| F10 | — | unit | R4 | proven | The plan accepted; the branch `flow/01234567/retry`; the card's settings for a member on its card's harness, `default` for one on another; the envelope lists every member with its settings and access, the judge and the criteria. |
| F10 | — | cluster | R5 | proven | Run `30c61bb8…` suspended under `envelope-2`; resumed `approve`; the page `The envelope` published once. |
| F10 | — | live | R6 | proven | Suspended under `envelope-1` 2 min 37 s after the start: one feature `case-id-check` on `flow/2fb231fc/case-id-check` with eight criteria, one member `dev-1` on `claude-code` · `opus` · `high` with `github:arnaultbretagne/agora:write` only. Resumed `approve`. |
| F11 | — | unit | R4 | proven | Refused, each with its reason: access not offered, a repository not offered, a judge staffed, `lead` or `judge-…` as a name, a model the harness does not offer (its models listed), no criterion. |
| F12 | — | unit | R4 | proven | `steps` and `done` refused before the plan; `ask` and `stop` accepted. |
| F12 | — | cluster | R5 | proven | Runs `141449ff…` and `30c61bb8…`: decision 1, `steps`, refused and counted; in `141449ff…` the mock's echo of the lead's second prompt opens with the refusal's reason. |
| F13 | — | unit | R4 | proven | The dev's card in its first turn's prompt and not in its second; the branch and criteria in both; a dev without a feature, an unknown feature and the lead as a member refused. |
| F13 | — | live | R6 | proven | Decisions 2 and 4: `dev-1`'s turns 1 and 2, the second's prompt without the card; the dev pushed `flow/2fb231fc/case-id-check` and opened draft pull request #149; each turn's report and answer opened the lead's next prompt. |
| F14 | — | unit | R4 | proven | The judge's access `github:acme/app:read` and `internet`; the question in a text block; R1–R7 and C1 owed. |
| F14 | — | live | R6 | proven | Verifications 1 and 2 in new Workstreams `judge-1` and `judge-2`, access `github:arnaultbretagne/agora:read` and `internet`. The second read CI run `40106200846` on the pull request's head `7e41ac9` and returned R1–R7, C1–C8 and two checks of its own. |
| F15 | — | unit | R4 | proven | Pass with every owed check passed; fail with one missing, one failed, a `fail` verdict, or no report. |
| F15 | real: the first judge's execution stopped by the operator | live | R6 | proven | Verification 1's turn ended `failed`: the lead's next prompt read "CUT before its verdict (turn failed): nothing was judged, and it counts", with the judge's findings so far; verification 2 passed, every check `pass`. |
| F16 | — | unit | R4 | proven | `done` refused before a pass and after a change following a pass; accepted after a pass newer than the last change. |
| F16 | — | cluster | R5 | proven | Run `30c61bb8…`: decision 5, `done`, refused after a failed verification; decision 10 accepted after verification 2 passed. |
| F16 | — | live | R6 | proven | Decision 6, `done`, accepted after verification 2 passed at decision 5, the dev's last change at decision 4; the run `Completed`, outcome `done`. |
| F17 | — | unit | R4 | proven | `yes` added a member's access, a member and a feature; an access not offered refused. |
| F17 | — | cluster | R5 | proven | Run `30c61bb8…` suspended under `ask-8`; resumed `yes`; `sre-1`'s turn carried `github:arnaultbretagne/infra-k8s:read` and `internet`. |
| F18 | — | unit | R4 | proven | `verify` accepted with one verification left and refused with none. |
| F18 | — | — | — | partial | The run ending at `max_decisions` is not produced. |
| F19 | — | cluster | R5 | proven | Runs `30c61bb8…` and `00fc46f5…`, resumed twice on the same commit: 29 pages, none twice; the lead's Workstream `Create` 1, `Write` 10. |
| F19 | real: the run retried on a later commit | live | R6 | partial | No command twice in any of its four Workstreams. The pages `The run` and `3 · dev-1 · case-id-check` were published again: the retry cloned `77e60bf`, whose link and dev card changed their content. |
| F1 | — | local | R7 | proven | The Workstreams of `sre-1`, `judge-1` and `judge-2` each hold `Create` 1 and `Write` 1; `dev-1`'s `Create` 1 and `Write` 2. |
| F10 | — | local | R7 | proven | Decision 2, `plan`: the question `Approve the envelope: …` asked in the lead's Workstream, answered `approve`; decision 3 carried out within the envelope. |
| F17 | — | local | R7 | proven | Decision 8, `ask`: the question `The lead asks: Give sre-1 read access to infra-k8s?` asked, answered `yes`; decision 9 carried out. |
| F20 | — | local | R7 | proven | Each question asked once — the lead's Workstream holds `Ask` 2 and `Answer` 2 beside `Create` 1 and `Write` 10 — its answer read on the stream 20 ms after the Ask; no question left waiting; the run `done` after 10 decisions and 2 verifications, in 118 s. |
| F20 | simulated: stub (a stream that idles out twice) | unit | R8 | proven | Asked once under the same key; the answer read on one connection; idled out, opened again from cursor `41`, twice. |
| F21 | simulated: stub (a Write of the person's in the member's execution) | unit | R9 | proven | The member's second turn found by its prompt, the third turn of the Workstream, "Answer 3."; its first found again, "Answer 1."; no command sent twice; a given Workstream the member's, the only one created. |
| F22 | — | local | R10 | proven | `GET /api/teams` `{"available":true}`; launched: 200, the Workstream in the person's list, Prefect asked once with the goal, the Workstream, the person's identity, their agents folder's and `agora-team-<id>`, the run's address in Prefect's UI; sent again, the same run. A blank goal 400 `invalid_goal`; another's Workstream 409 `workstream_conflict`; Prefect down 502 `teams_unreachable`, nothing asked. |
| F24 | — | unit | R11 | proven | `feat/credentials-vault`, a branch another run started, kept as named; no branch, `feat/upload retry`, `feat/../x`, `-x`, `feat/x.lock`, `feat/x/` refused as no branch git accepts; `develop` as its own base, `main` from `develop`, refused; a second feature on `feat/upload-retry`, in the plan and by an `ask`, refused as carried by `retry`; the dev's prompt: "Your branch: `feat/upload-retry`. If it exists, continue it". |

## Not covered

| Failure | Status |
| --- | --- |
| A run whose process dies is not marked `Crashed` by Prefect on its own. | Seen in R2 (F3); a heartbeat automation is to be set. |
| A change pushed while a run is suspended or retried: the resumed run clones it, and the pages whose content it changes are published again. | Seen in R6. |
| A criterion that shows only on the change running: no preview deployment exists yet, and the judge reads only. | Not produced. |
| Prefect's server restarting while a run is suspended. | Not produced. |

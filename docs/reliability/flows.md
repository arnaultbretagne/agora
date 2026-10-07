# Flows

The evidence behind the acceptance cases of `specs/flows.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-10-07 | `26a7d0c` | unit | `npm test -w @agora/flows`: Python 3.13, the step against a stand-in Agora that keeps command deduplication and moves an execution and a turn as it is polled. |
| R2 | 2026-10-07 | `26a7d0c` | cluster | g4. Prefect 3.8.8 from infra-k8s `apps/prefect` (charts 2026.10.6163015, image `prefecthq/prefect:3.8.8-python3.12`), worker of type `process` on the pool `agora`; deployments `rehearsal/feat-flows` and `archi-dev-review/feat-flows` cloning the agora repository at `feat/flows`. Agora's server `agora-server@sha256:17ee38bf…` built from `3e79179`; the mock pool `mock-0d7ee53674f6`. Agora's log read through its test route `entries` from the worker's Pod; the Workstreams owned by the operator. No model call. |

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
| F4 | — | cluster | — | not verified | The mock's Session opened with nothing to settle: no refusal was seen. |
| F5 | simulated: stub (a turn ending `uncertain`; a Write refused `stopped`) | unit | R1 | proven | Escalation; no command after it, a replay included. |
| F5 | — | cluster | — | not verified | The suspension on escalation was not produced in the cluster. |
| F6 | — | cluster | R2 | proven | Run `c1716787…` suspended under `approve-architecture`; its description named the goal, the branch `flow/c1716787` and the summary; resumed with notes over Prefect's API. The architecture step answered from its persisted result (`Cached`); only the first development's prompt carried the notes, not the architecture's nor the review's. |
| F7 | — | cluster | R2 | proven | Same run, verdicts forced on the mock: `changes` in round 1, then a second development and review in new Workstreams (`d29c7f44…`, `5e10532a…`), the second development's prompt alone carrying the review's comment; `approve` in round 2 ended the run `Completed`. Each of the five Workstreams holds `Create` 1, `Write` 1, `Stop` 1 and one `session/prompt`. |
| F8 | — | — | — | not verified | |

## Not covered

| Failure | Status |
| --- | --- |
| A run whose process dies is not marked `Crashed` by Prefect on its own. | Seen in R2 (F3); a heartbeat automation is to be set. |
| A real harness running the three roles, with a push and a review on a real branch. | Not run: billed, and writes to the repository. |
| Prefect's server restarting while a run is suspended. | Not produced. |

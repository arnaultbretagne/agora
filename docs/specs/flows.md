# Flows

Contract to implement — Prefect **3.8.8** (`prefecthq/prefect:3.8.8-python3.12`), on top of the
log's commands and thread (`log.md`). How it fits together is explained in `architecture/flows.md`;
why, in the workflows ADR.

**A step is one Workstream. Every id it sends is derived from the step's identity, so running the
step again finds it where it is and never starts a second agent.**

## A step's identity

| Name | Value |
| --- | --- |
| Identity | The flow run's id, the step's name, its round. |
| Workstream | The name-based UUID (version 5) of `<run>/<step>/<round>` in the flows' namespace, itself the name-based UUID of the URL `https://agora.bretagne.dev/flows`. |
| Commands | The name-based UUID, in the Workstream's id as namespace, of the command's place: `create`, `write-1`, `stop`. |
| Owner | The worker's `AGORA_OWNER`, unless the run names another. A rehearsal names the live cases' owner, `c45e0000-0000-4000-8000-000000000000`. |

## A step's course

The step reads its Workstream's thread from its last cursor, through the snapshot's end, every 5 s.

| Stage | Rule |
| --- | --- |
| Workstream | `POST /api/workstreams` with its id and owner. 409, another owner's: escalation. |
| Create | Sent only while the Workstream's view is absent or `none`. Body: the first pool of the catalogue with the step's harness; `limits` with the lease (300 s, a rehearsal's 120 s) and the turn cap (3600 s); `settings` and `profiles` when the step has any. Refused `quota` or `unavailable`: sent again under the same id every 15 s. Any other refusal: escalation. |
| Write | Sent only while the Workstream has no turn, once its view is `ready`, not `configuring`, with a Session. Target: the view's execution and Session; body: the step's prompt as one text block. Refused `settings_pending`, `opening_session`, `disconnected` or `unavailable`: sent again under the same id. Any other refusal; the view `ended`, `failed`, `lost` or `stopped` first; or not `ready` within 15 minutes: escalation. |
| Turn | The Workstream's first turn by request position. Waited for until `done`, `cancelled` or `failed`. `uncertain`: escalation, and nothing is sent again. A pending permission is logged once and left to be answered in Agora. |
| Answer | The text of the turn's `agent_message_chunk` elements, in the order of their first positions. |
| Stop | Sent once the turn has ended, unless the view is `ended`, `failed`, `lost` or `stopped`. Refused `stopped` or `execution_unavailable`: nothing more. |

A step's task is retried by Prefect 3 times, 20 s apart, on any error but an escalation. Its
result is persisted; Prefect's default cache (inputs, task source, run) answers a step already
completed in the same run without running it.

## Escalation

A step that escalates suspends its flow run with the input `Decision` — `action`, `retry` or
`abort` — under the key `escalation-<step>-<round>-<attempt>`, the escalation's reason in the
form's description. `retry` runs the step again with the next attempt number; `abort` fails the
flow run.

## The flows

### `rehearsal`

| Parameter | Default | Role |
| --- | --- | --- |
| `prompt` | `/sleep 20` | The step's prompt. |
| `harness` | `mock` | The step's harness. |
| `replays` | 1 | How many times the same step runs again after it. |
| `owner` | the live cases' owner | The Workstream's owner. |

It runs the step `rehearsal`, round 1, then runs it again `replays` times, and logs whether every
replay gave the same Workstream, execution and answer.

### `archi-dev-review`

| Parameter | Default | Role |
| --- | --- | --- |
| `goal` | — | What the work is. |
| `repo` | `arnaultbretagne/agora` | The GitHub repository. |
| `base` | `design/agora-foundations` | The branch the work starts from. |
| `architect`, `developer`, `reviewer` | `claude-code`, `codex`, `claude-code` | Each step's harness. |
| `max_rounds` | 3 | Development and review rounds at most. |
| `rehearsal_verdicts` | none | For the mock, which echoes its prompt: the verdict the review's prompt ends with, per round. |
| `owner` | the worker's | The Workstreams' owner. |

The work's branch is `flow/<the run id's first 8 characters>`. Each prompt's first line is
`[flow <those 8>] <Step>, round <n>: <goal>` — the Workstream's title — then the repository, the
base and the branch, the step's instructions, and the JSON object its answer must end with.

| Step | Harness, profile | The prompt asks | Its JSON |
| --- | --- | --- | --- |
| `architecture`, round 1 | `architect`, `github:<repo>:write` | Create the branch from the base, write the design where the repository's rules put it, not the implementation; push before answering. | `summary`, `files` |
| Approval | — | The run suspends under the key `approve-architecture` with the input `Approval` — `approved` (default true), `notes` — the goal, the branch and the design's summary in the description. Refused: the flow ends, outcome `architecture refused`. | — |
| `development`, round n | `developer`, `github:<repo>:write` | Check out the branch, implement the design under the repository's rules, run its checks if possible; push before answering. Round 1 carries the approval's notes; a later round, the previous review's comments. | `summary`, `checks` |
| `review`, round n | `reviewer`, `github:<repo>:read` | Review the branch against the base; do not push. | `verdict` (`approve` or `changes`), `comments` |

The review's verdict is the last JSON object of its answer, when it has `verdict`. `approve` ends
the flow, outcome `approved`. Anything else starts the next round with its `comments` — or, with
none, one comment saying changes were asked without details. After `max_rounds`, the flow ends,
outcome `not approved after <n> rounds`. An answer whose last JSON object is missing or has no
`verdict` suspends the run under the key `verdict-review-<round>` with the input `Approval`, the
answer's last 4,000 characters in the description: approved counts as `approve`, refused as
`changes` with the notes as comment.

## Deployment

| What | Value |
| --- | --- |
| Prefect | Server and one worker, deployed by infra-k8s (`apps/prefect`). |
| Work pool | `agora`, type `process`, at most 3 flow runs at once. |
| Deployments | `rehearsal/<branch>` and `archi-dev-review/<branch>`, the branch's `/` written `-`; each run clones the agora repository at that branch and loads `apps/flows/flows.py`. |
| Environment | `AGORA_URL`, Agora's server in-cluster; `AGORA_OWNER`, the operator's identity UUID. |
| Results | Persisted in the worker's local storage. |

## To be specified

- A flow run whose process dies — its worker's Pod killed — stays `Running`: nothing marks it
  `Crashed` without a heartbeat automation.
- What the steps cost: no budget, no token count.
- Opening the pull request once the review approves.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| F1 | A step from nothing | One Workstream, the step's; its log holds one `Create`, one `Write`, one `Stop` and one `session/prompt`; the step returns the agent's answer and the turn's status. |
| F2 | The same step again, after it ended | The same Workstream, execution and answer; its log still holds one `Create`, one `Write`, one `Stop` and one `session/prompt`. |
| F3 | The same step again, its process killed during the turn | The run retried finds the Workstream `ready` and waits for the turn begun before; the same execution; its log holds one `Create`, one `Write`, one `Stop` and one `session/prompt`. |
| F4 | A Write refused while the Session opens | Sent again under the same id until accepted; one `Write` and one `session/prompt` in the log. |
| F5 | An uncertain turn, or a refusal the step cannot clear | Escalation; no command sent after it, a replay included. |
| F6 | The architecture's approval | The run suspends under `approve-architecture` with the goal, the branch and the summary; resumed with notes, the first development's prompt carries them and no other step's does; the architecture step is not run again. |
| F7 | The review's verdicts | `changes` in round 1 starts round 2 in new Workstreams, the development's prompt carrying the review's comments and no other step's; `approve` in round 2 ends the flow `approved`. |
| F8 | A review that ends without its verdict | The run suspends under `verdict-review-<round>`; the answer approved ends the flow `approved`. |

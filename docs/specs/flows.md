# Flows

Contract to implement — Prefect **3.8.8** (`prefecthq/prefect:3.8.8-python3.12`), on top of the
log's commands and thread (`log.md`). How it fits together is explained in `architecture/flows.md`;
why, in the workflows ADR.

**A lead decides and the flow carries out. Each member of the team is one Workstream, kept across
its turns; every id a turn sends is derived from the turn's identity, so running it again finds it
where it is and never starts a second agent. What needs the person is a question in the lead's
Workstream, and the run waits for its answer on the thread's stream.**

## A turn's identity

| Name | Value |
| --- | --- |
| Identity | The flow run's id, the member's name, the member's turn number from 1, the attempt — 0, or the number of retries the person asked for. |
| Workstream | The name-based UUID (version 5) of `<run>/<member>` in the flows' namespace, itself the name-based UUID of the URL `https://agora.bretagne.dev/flows`. One per member, for all its turns. |
| Commands | The name-based UUID, in the Workstream's id as namespace, of `create-<turn>` and `write-<turn>`, each followed by `.<attempt>` once the attempt is not 0. |
| Owner | The worker's `AGORA_OWNER`, unless the run names another. A rehearsal names the live cases' owner, `c45e0000-0000-4000-8000-000000000000`. |

## A turn's course

The turn reads its Workstream's thread from its last cursor, through the snapshot's end, every 5 s.
The member's turn is the Workstream's turn whose prompt — its `user` element's text — is the turn's: a
turn already in the thread is never written again, whatever a person wrote in between. A member's
prompts differ from one turn to the next: the lead's by its decision's number, a step's by its turn's.

| Stage | Rule |
| --- | --- |
| Workstream | `POST /api/workstreams` with its id and owner. 409, another owner's: escalation. |
| Execution | The Workstream's execution, while its view is neither absent, `none`, `ended`, `failed`, `lost` nor `stopped`. Otherwise a Create. |
| Create | Body: the first pool of the catalogue with the member's harness; `limits` with the lease (300 s, a rehearsal's 120 s) and the turn cap (3600 s); `settings` and `profiles` when the member has any. Refused `execution_active`: sent again under the same id every 5 s while the last execution's claim goes at its deadline; `quota` every 15 s; `unavailable` every 5 s. Refused `command_conflict`: the view's execution, unless it is gone — then escalation. Any other refusal, or 15 minutes of refusals: escalation. |
| Write | Sent once the execution's view is `ready`, not `configuring`, with a Session. Target: that execution and Session; body: the turn's prompt as one text block. Refused `settings_pending`, `opening_session`, `disconnected`, `unavailable` or `turn_active` — a person's own turn in the Workstream —: sent again under the same id. An execution taken from the member's last turn that is gone, refuses `execution_ending`, or is no longer the view's: a Create, as above. Any other refusal; a created execution gone first; or not `ready` within 15 minutes: escalation. |
| Turn | Waited for until `done`, `cancelled` or `failed`. `uncertain`: escalation, and nothing is sent again. A pending permission is logged once and left to be answered in Agora. |
| Answer | The text of the turn's `agent_message_chunk` elements, in the order of their first positions. Its report is its last JSON object. |
| After the turn | Nothing is sent. Agora renews an execution only during its turns: idle, it ends at its deadline, a lease after its last turn. A Stop would free its claim no sooner. |

A turn's task is retried by Prefect 3 times, 20 s apart, on any error but an escalation. Its
result is persisted; Prefect's default cache (inputs, task source, run) answers a turn already
completed in the same run without running it.

## The person's questions

The envelope, what the lead asks, and a turn the flow cannot settle are questions to the person
(`log.md`, "Commands": Ask), in the lead's Workstream, answered in Agora's client.

| Stage | Rule |
| --- | --- |
| Ask | In the lead's Workstream, created if it does not exist yet, under the command id of `ask-<key>`: the same key finds the question already asked. Its title, one line of at most 150 characters; its text, Markdown; its options; a note offered, but for an escalation. |
| Keys | `envelope-<decision>`, `ask-<decision>`, `escalation-<member>-<turn>-<attempt>`. |
| Wait | The thread read from its start, then followed live on one connection, until the question at the Ask's position is `answered`. A connection with nothing to read for 600 s, or one that drops, is opened again from the cursor, 5 s later on an error. Nothing is polled. |
| Answer | The question's `answer`: its `optionId`, and its `note` when the person wrote one. |
| Task | `Waiting for you: <title>`, retried by Prefect 3 times, 20 s apart; its result persisted. |

| Question | Options | Then |
| --- | --- | --- |
| An escalation | Retry (`allow_once`), Abort the run (`reject_always`); no note | `retry` runs the turn again with the next attempt; anything else fails the flow run. |
| The envelope | Approve (`allow_once`), Revise (`reject_once`), Stop (`reject_always`) | Below, "The decisions". |
| An `ask` | Yes (`allow_once`), No (`reject_once`) | Below, "The decisions". |

## Role cards

| Name | Value |
| --- | --- |
| File | `apps/flows/roles/<role>.md`: a front matter of `key: value` lines between two `---` lines — `role`, `summary`, `harness`, `model`, `effort` — then the persona in Markdown. |
| Roles | `lead`, `dev`, `sre`, `judge`; a run without one of the four fails at its start. |
| Base rubric | The judge's numbered list under its heading `## Base rubric`; its items are R1, R2… in order. |
| Overrides | The run's `overrides`: a role's `harness`, `model` or `effort`. Any other key, or an unknown role, fails the run at its start. An override wins over what the lead proposes for a member of that role. |
| Settings | `model` goes as the setting `model`; `effort` as `effort` or `reasoning_effort`, whichever the pool offers. `default` sends none. A value the pool does not offer refuses the decision proposing it; for the lead's own, it fails the run at its start. |

| Role | Default harness · model · effort |
| --- | --- |
| `lead` | `claude-code` · `opus` · `high` |
| `dev` | `claude-code` · `opus` · `high` |
| `sre` | `claude-code` · `opus` · `medium` |
| `judge` | `codex` · `gpt-6.1-sol` · `xhigh` |

A member staffed on another harness than its card's takes `default` for what the lead does not set.

## The flow `lead`

| Parameter | Default | Role |
| --- | --- | --- |
| `goal` | — | What the run must achieve: the lead's only brief. |
| `overrides` | none | A role's harness, model or effort. |
| `max_verifications` | 25 | Verifications by the judge, at most. |
| `max_decisions` | 100 | Decisions of the lead, at most, refused ones included. |
| `lead_workstream` | none | The lead's Workstream, when Agora created it ("Launching from Agora"); else derived from the run. |
| `owner` | the worker's | Who owns the lead's Workstream and is asked: an identity UUID. |
| `members_owner` | `owner` | Who owns the members' Workstreams — the judge's included: the person's agents' folder (`log.md`, "HTTP"). |

The run's harnesses are the catalogue's but `mock`. Its offer — the pools and the profiles of
`GET /api/config`'s `credentials.offered` — is read again for each decision and kept with it.

### The lead

| Name | Value |
| --- | --- |
| Member | `lead`, on its card's settings, with `:read` of each offered `github:` profile and `internet`. |
| First prompt | `[flow <the run id's first 8 characters>] lead: <goal>`, its card, then the run: the goal; the roles it can staff with their summaries and settings, those set at launch marked; the judge's harness and model, with the advice to staff the work on another; each harness with its models and efforts; the access it can propose; its own; the limits; the decisions and their JSON. |
| Later prompts | `[flow <8>] lead: decision <n>`, the outcome of the decision before, the decision's number out of `max_decisions`, the verifications left, the features judged shippable. |
| Decision | The last JSON object of its answer, its `decision` one of `plan`, `steps`, `verify`, `ask`, `done`, `stop`, with `why`. |
| Refused | A turn not `done`, an answer without a decision, or a decision outside the rules below: nothing is carried out, the reason opens the lead's next prompt, and it counts. |
| Limit | After `max_decisions`, the run ends, outcome `decision limit reached`. |

### The decisions

| Decision | Accepted | The flow |
| --- | --- | --- |
| `plan` | Before the plan is approved. `title`, one line of at most 120 characters. `features`, 1 to 8: `id` (lowercase letters, digits and dashes, at most 40), `title`, `repo` among the offered repositories, `base`, `branch`, `criteria` 1 to 15. The `branch` is named by the lead after what the feature carries, never after the run: a branch git accepts, of at most 100 characters, neither the base, `main` nor `master`, nor another feature's; an existing branch is continued, with its pull request. `team`, 1 to 8: `name` as an id, neither `lead` nor beginning with `judge`; `role` `dev` or `sre`; `harness`, `model`, `effort` the pool offers; `access`, each profile offered, or a repository's `:read` where its `:write` is. | Asks the person, key `envelope-<n>`, titled by the plan's `title`, its text the plan's reason, then each feature with its branch and criteria, each member with its settings and access, the judge, the limits. `approve`: the envelope holds them; `revise`: the note goes to the lead; `stop`: the run ends, outcome `stopped by the person at the plan`. |
| `steps` | Once approved. 1 to 10 steps, each a member of the team but the lead, a `brief`, and a `feature` of the envelope — required of a dev. | Each step, in order, is the member's next turn. A dev's step, or one by a member with `:write` on the feature's repository, changes the feature. The outcome gives each step's turn status, report, and answer cut to 6,000 characters. |
| `verify` | Once approved, with a verification left. `question`; `feature` of the envelope or none; `shippable`, true only with a feature. | A turn of a new member `judge-<k>`, k the verification's number, on the judge's card. Its access: the feature's repository `:read` and `internet`; without a feature, `:read` of every repository in the team's access, and `internet`. A pass needs the verdict `pass`, no check but `pass`, and, when shippable, each base rubric item and each criterion among the checks by its id. A shippable pass makes the feature shippable at this decision. A judge's turn not `done` is a verification cut: nothing judged, the lead told so with what the judge had said, and it counts. |
| `ask` | At any time. `question`; `add`, once approved: `features` and `team` as in a plan, `access` mapping a member to its whole access after the change. | Asks the person, key `ask-<n>`, title `The lead asks: <question>`, its text the question and what `add` holds, each access shown before and after. `yes` adds what `add` holds; the answer and the note go to the lead either way. |
| `done` | Once approved, every feature shippable since its last change. | Ends the run, outcome `done`, with its `summary`. |
| `stop` | At any time, with a `reason`. | Ends the run, outcome `stopped by the lead`. |

### The members' prompts

| Prompt | Content |
| --- | --- |
| A step | `[flow <8>] <member>: <the feature's title, or the brief's first line>`; on the member's first turn, its card, the run's goal and its access; then the brief; where the work is — the feature's repository and base, its branch and its criteria C1, C2…, a dev told to continue the branch if it exists, brought up to date with the base first, or else start it from the base, push there and keep one draft pull request open to the base, the one already open if there is one — or the repositories the member can reach; and the report it ends with: `status` `done` or `blocked`, `summary`, `pull_request`. |
| A verification | `[flow <8>] judge: verification <k>`, its card, the run's goal for context, the lead's question in a text block as what to look at and never what to conclude, the feature's repository, base and branch, the ids it owes when shippable, its access, and the verdict it ends with: `verdict`, `checks` each with `id`, `check`, `result`, `evidence`, and `summary`. |

### The graph

| Node | Name | Holds |
| --- | --- | --- |
| The lead's turn | Task `<n> · lead`, the decision's number | One turn of the lead; the next waits for it. |
| A decision carried out | Subflow `decision`, run `<n> · <kind>` | Its members' turns, task `<member>[ · <feature>]` each, or its question, task `Waiting for you: <title>`; each waits for the one before. |

A refused decision, `done` and `stop` carry nothing out: no subflow.

### Pages

Each run publishes, as Prefect artifacts: the run, with its parameters and links to the flow and the
role cards at the commit it cloned; each decision, accepted with its JSON or refused with its reason;
the envelope once approved; each turn, with its settings, access, Workstream, execution, status,
report, answer and exact prompt; and a summary table of the decisions and their outcomes. Each has a
key, `flow-<8>-<name>`: published again — a run retried — it is a new version, not a second page.

## Launching from Agora

A team is launched from Agora's client (`assistant-ui.md`, "Teams"): Agora's server creates the
lead's Workstream and asks Prefect for the run; the person never opens Prefect.

| Name | Rule |
| --- | --- |
| Configured | `TEAM_PREFECT_API`, Prefect's API in-cluster; `TEAM_DEPLOYMENT`, `<flow>/<deployment>`, `lead/main` by default. Without the first, `/api/teams` answers 404 `teams_unavailable`. |
| `GET /api/teams` | `available` true. |
| `POST /api/teams` | `id` and `goal`, 1 to 4,000 characters once trimmed. The Workstream `id` is created, the person's — the identity the proxy passes, the body's `owner` without one — then the deployment's run created with the parameters `goal`, `lead_workstream` the id, `owner` the person's identity, `members_owner` the person's agents' folder (`log.md`, "HTTP") — the person's identity without the proxy —, and the idempotency key `agora-team-<id>`: the same launch sent again finds the same run. 200 with `workstream`, `flowRun`, and its address in Prefect when `TEAM_PREFECT_UI` is set. |
| Refused | 400 `invalid_goal`, `invalid_identifier`, `invalid_body`; 409 `workstream_conflict` for another's Workstream; 502 `team_deployment_missing`, `team_refused`, `teams_unreachable` when Prefect does not answer as it should. |
| Owners | The lead's Workstream, its questions and the person's answers are the person's; every member's Workstream, the judge's included, in the person's agents' folder: out of their list, in reach (`assistant-ui.md`, "Accounts"), and in no one else's. |

## The flow `lead-rehearsal`

The flow `lead` on the mock, whose answer echoes its prompt: each prompt ends with what its `script`
makes the lead, the members and the judge answer. From its second message on, the mock quotes the
message before after its echo; the rehearsal reads the answer before that quote.

| Parameter | Default | Role |
| --- | --- | --- |
| `goal` | `Rehearsal on the mock: the lead's mechanics` | Shown in the pages and the prompts. |
| `script` | ten decisions, verdicts `fail` then `pass`, the envelope approved and the `ask` granted | `decisions`, the lead's in order, then `stop`; `verdicts`, the judge's in order, then `pass`; `answers`, the person's to `envelope` and `ask`, given with Answer under the command id of `answer-<key>` as soon as asked — without one, the run waits for an answer in Agora. A member reports `done`. |
| `max_verifications`, `max_decisions` | 25, 100 | As for `lead`. |

Every role runs on the mock with its default settings; the Workstreams belong to the live cases'
owner.

## The flow `rehearsal`

| Parameter | Default | Role |
| --- | --- | --- |
| `prompt` | `/sleep 20` | The turn's prompt. |
| `harness` | `mock` | The turn's harness. |
| `replays` | 1 | How many times the same turn runs again after it. |
| `owner` | the live cases' owner | The Workstream's owner. |

It runs the member `rehearsal`'s first turn, then runs it again `replays` times, and logs whether
every replay gave the same Workstream, execution and answer.

## Deployment

| What | Value |
| --- | --- |
| Prefect | Server and one worker, deployed by infra-k8s (`apps/prefect`). |
| Work pool | `agora`, type `process`, at most 3 flow runs at once. |
| Deployments | `lead/<branch>`, `lead-rehearsal/<branch>` and `rehearsal/<branch>`, the branch's `/` written `-`; each run clones the agora repository at that branch and loads `apps/flows/flows.py`. |
| Environment | `AGORA_URL`, Agora's server in-cluster; `AGORA_OWNER`, the operator's identity UUID. |
| Results | Persisted in the worker's local storage. |

## To be specified

- A flow run whose process dies — its worker's Pod killed — stays `Running`: nothing marks it
  `Crashed` without a heartbeat automation.
- The flow reads no CI result itself; only the judge does.
- The flow holds no GitHub right: a dev starts the feature's branch and opens its pull request.
- Steps in parallel.
- Nothing keeps the work off the judge's model: the lead is only told which one judges.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| F1 | A member's first turn | One Workstream, the member's; its log holds one `Create`, one `Write` and one `session/prompt`; the turn returns the agent's answer and the turn's status. |
| F2 | The same turn again, after it ended | The same Workstream, execution and answer; nothing more in its log. |
| F3 | The same turn again, its process killed during the turn | The run retried finds the turn begun before and waits for it; no other `Create` or `Write`. |
| F4 | A Write refused while the Session opens | Sent again under the same id until accepted; one `Write` and one `session/prompt` in the log. |
| F5 | An uncertain turn, or a refusal the turn cannot clear | Escalation, asked of the person; no command sent after it, a replay included. Retried by the person: new command ids, the same turn. |
| F6 | The member's next turn, its execution still there | One more `Write` in the same execution; no `Create`. |
| F7 | The member's next turn, its execution ended | A `Create`, sent again while the last claim goes; the new execution continues the member's Session. |
| F8 | The member's next turn, its execution ending | Refused `execution_ending`, the turn goes to a new execution. |
| F9 | A launch's overrides | A role's harness, model or effort replaced, its text never; another key fails the run; a member takes the launch's value over the lead's. |
| F10 | A plan within the offer | The person asked, key `envelope-<n>`, with the features, criteria, branches, team, settings, access and limits; `approve` makes them the envelope, `revise` sends the note to the lead, `stop` ends the run. |
| F11 | A plan beyond the offer | Access or a repository not offered, a judge staffed, a reserved name, a model the harness does not offer, no criterion: refused, the reason in the lead's next prompt, counted. |
| F12 | A decision other than `plan`, `ask` or `stop` before the plan is approved | Refused. |
| F13 | Steps | Each a turn of its member, in order; the card only in the member's first turn; the feature's branch and criteria in each; every step's outcome in the lead's next prompt. |
| F14 | A verification | A new Workstream `judge-<k>`, read-only access, the question as data, the base rubric and the criteria owed when shippable. |
| F15 | A verdict | Pass only with `pass`, no check failed, and each owed id passed; a judge's turn cut before its verdict judges nothing. |
| F16 | `done` | Refused until every feature has been judged shippable since its last change; then the run ends `done`. |
| F17 | An `ask` | The whole run waits for the person, key `ask-<n>`; `yes` adds what it asks for, `no` nothing; the note reaches the lead. |
| F18 | The limits | No verification left: `verify` refused. `max_decisions` reached: the run ends `decision limit reached`. |
| F19 | A run retried after its process died | Completed turns answer from their persisted results or find their Workstreams; no command twice; each page one, in its last version. |
| F21 | A person writes in a member's Workstream between two of its turns; a Workstream given | The member's next turn found by its prompt, the person's left aside; the turn before found again by its own; the given Workstream the member's. |
| F24 | A plan's branches | Each feature on the branch the lead names, an existing one kept as named; missing, not a branch git accepts, the base, `main` or `master`, or another feature's: refused, with the reason; the dev told to continue the branch if it exists, brought up to date with the base, keeping its pull request. |
| F22 | A team launched from Agora; again; refused | The lead's Workstream the person's; the run asked once with the goal, the Workstream, both owners and the key `agora-team-<id>`; the same run when sent again; no goal, another's Workstream, Prefect unreachable refused with their reasons, no run asked. |
| F20 | A question to the person | Asked once, the same key finding it again; its answer read on the thread's stream, on one connection while nothing drops; a connection idle or dropped opened again from its cursor. |

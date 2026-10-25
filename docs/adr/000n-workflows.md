# ADR 000n — Workflows

- **Status:** proposed
- **Date:** 2026-10-23

## Context

- Work worth automating takes several agents — someone who builds, someone who checks, sometimes
  someone who knows how it will run — and loops: a check that fails sends the work back.
- Which steps a goal needs is not known in advance: the steps change from one goal to the next, and
  so do the repositories and the rights.
- The human wants one approval, when the work is launched, with the team and its rights already
  decided — not a judge to approve at 2 a.m. — then only the questions nobody else can answer.
- Agents overrate their own work: whoever checks must not be whoever built, nor be steered by them.
- Agora already runs each agent in a sandbox and keeps every exchange in its log; a member of the
  team should be a Workstream like any other, which a person can open and take over.
- A turn lasts up to an hour, a human's answer as long as they take. The orchestrator restarts,
  retries and resumes; none of that may start a second agent on the same work.
- Credentials stay in the gateway: whatever orchestrates holds no model key and no repository token.
- Agora configures what it relies on and reimplements none of it: an orchestrator that exists is
  adapted before one is built.

## Decision

1. **Prefect** (open source, self-hosted on infra-k8s) runs the workflows: a server with its UI
   behind the identity proxy, one worker of type `process` on the work pool `agora`.
2. **The flows live in Agora's repository** (`apps/flows`), in Python, on the standard library and
   Prefect only; each run clones them at its deployment's branch, role cards included.
3. **A lead decides, the flow carries out.** The lead, an agent, answers each turn with one decision
   from a fixed vocabulary — `plan`, `steps`, `verify`, `ask`, `done`, `stop`. The flow checks it
   against its rules and the envelope, carries it out, and comes back with the outcome. The lead
   never reaches Prefect or Agora.
4. **Roles are cards in the repository**: lead, dev, sre, judge — a persona and one default per
   setting (harness, model, effort), which a launch may override. Rights are not a role's: the lead
   proposes each member's access in its plan.
5. **One approval: the envelope.** The plan — features with acceptance criteria, team, access — is
   approved once; anything beyond it goes through `ask`, and the whole run waits. The person answers
   in Agora: each is a question in the lead's Workstream, which the run waits for on its stream.
6. **The judge is the flow's**: read only, a fresh Workstream for each verification, the lead's
   question taken as data, a base rubric locked in its card plus the approved criteria when it
   decides whether a feature ships. `done` needs each feature judged shippable since its last
   change. At most 25 verifications and 100 decisions per run.
7. **A member is one Workstream across its turns**, driven through Agora's server API in-cluster.
   Every id it sends is derived from the turn's identity (run, member, turn); Agora's command
   deduplication makes running a turn again find it instead of repeating it.
8. **Work moves through the repository**: a branch per feature, named by the flow; the human merges.

## Why

- Prefect coordinates and owns nothing of the work: the agents, their workspaces and their
  credentials stay in Agora's sandboxes and gateway.
- Flows are ordinary Python: a loop over decisions read at run time, with no graph compiled in
  advance — which a lead choosing the steps needs.
- The person answers in Agora, where the run's story is: a question in the lead's Workstream, shown
  with the same card as an agent's permission. The run waits on the thread's stream, one connection,
  so nothing is polled; a waiting run's process holds 94 MiB (measured in the worker on 2026-10-25).
  Prefect's own suspension was tried and dropped (below).
- The cluster runs it in about 435 MiB — server 185, its PostgreSQL 130, worker 99, gate 21
  (`kubectl top`, 2026-10-07).
- A lead that only decides keeps the plan with someone who sees the whole run, and the work with
  members who each keep their own context. Anthropic's guidance says to split agents by context, not
  by kind of task, and that handing work from planner to builder to tester loses it at each step
  ("Building multi-agent systems: when and how", 2026-01-23, documentation); the dev both designs
  and builds its feature.
- A separate evaluator is what lifts results, because agents judge their own work too kindly
  ("Harness design for long-running application development", 2026-03-24, documentation); a
  grader in its own context added about 10 points of task success to Managed Agents (2026-05-19,
  documentation).
- An agent that orchestrates without code it runs: Managed Agents' dynamic workflows let the lead
  write the orchestration as a program the platform runs and bounds (2026-10-09, documentation).
  Here the bounds are the flow's code, and the lead writes decisions, not programs.
- Making a turn idempotent took no change to Agora: command ids chosen by the client and their
  deduplication already exist for the browser.
- Proven on g4 on 2026-10-23: a rehearsal of ten decisions, two of them refused, resumed twice,
  sent one `Create` and ten `Write`s to the lead's Workstream and published no page twice.

## What we tried

Each orchestrator was studied on 2026-10-07 — code read where it says so, otherwise its
documentation — and Kestra and Airflow were run on g4 on 2026-10-21 with the same workflow as Prefect.

| Option | What it is | What we found | Why not |
| --- | --- | --- | --- |
| Archon (coleam00, v0.11.1, MIT) | A workflow engine for coding agents: YAML nodes, loops, approval gates, a plan → implement → review pack. | Code read: providers can be external processes (provider plugin protocol 1); its events follow ACP. Bash nodes and the git worktree run on Archon's host. | The work would sit in two places — Archon's worktree and the sandbox — kept in step by syncing git around every turn, on a contract not yet stable. |
| acpx flows (openclaw, 0.19.4, MIT) and agentprism-workflows | TypeScript workflows over ACP agents, with checkpoints. | Agents are local stdio processes; a custom agent is any command speaking ACP on stdio. | Needs an adapter that turns Agora into a stdio ACP agent; both tools are young. |
| GitHub Actions, gh-aw | Workflows triggered by issues and pull requests. | The official actions and gh-aw run the agent in the runner. | Only the triggers would serve; no workflow language for loops; a runner on g4 to reach Agora. |
| Temporal, Restate, DBOS, Hatchet, Argo Workflows | Durable execution engines. | Documentation: durability, signals and waits; nothing about agents or approval forms. | Durability only, without Prefect's UI and forms. Restate is under BSL. |
| Kestra 2.0.7 | A YAML orchestrator on a JVM, with a Pause task. | Run on g4: the best UI for reading a workflow — YAML, docs and topology side by side; 2.4 GB of memory; a loop resets its tasks at each round, so state between rounds goes through its key-value store. | Heavier, and a loop chosen at run time fights its model. |
| Airflow 3.3.2 | A DAG orchestrator with human-in-the-loop operators. | Run on g4: code tab read-only, its form shows the design; 1.3 GB in standalone mode; the graph is static, so the loop was unrolled into 14 tasks. | A static graph cannot follow a lead's decisions. |
| Windmill, n8n, Dagster | General orchestrators. | Windmill has approval steps under AGPL; n8n a fair-code licence; Dagster is built around data assets. | A licence or a model that fits less. |
| A fixed pipeline: architect, approval, developer, reviewer | The first flow, `archi-dev-review`. | Run live on 2026-10-07: three rounds until the review approved, and the review caught an evidence row for a run that never happened. | The same steps for every goal; the design handed from architect to developer; the human approving mid-run. |
| A lead that drives Prefect or Agora itself | A tool in the lead's sandbox to start steps. | — | A sandbox treated as hostile could start sandboxes, and the rules would have to move into an API it reaches. |
| A lead that writes the orchestration as code | Its program run by the worker. | — | Code written by an agent would run outside any sandbox. |
| A judge on a second default harness | The judge switching to another harness when the work used its own. | — | Two defaults for one setting; the launch overrides the judge's settings instead, and the lead is told which model judges. |
| Prefect's forms, the run suspended | The person answers in Prefect's UI; the run, suspended, holds no process. | Run on g4 on 2026-10-24: each resume ran the flow again from its start; of its 48 tasks, 12 were turns and 19 replays from the cache. | The graph unreadable, the run's story split between Prefect and Agora, and the person answering outside the client they use. |
| The process polling Agora, or Agora resuming Prefect | The run asks in Agora and reads the answer every few seconds; or Agora calls Prefect back when the person answers. | — | Polling rejected by the person; a call back ties Agora to Prefect and runs the flow again on every answer. |
| Stopping a member's execution after each turn | So that an idle lead holds no sandbox. | Measured on g4 on 2026-10-23: the next turn's Create was refused `execution_active` for 5 minutes. A stopped execution's claim lasts until its deadline, like an idle one's. | It frees nothing sooner and makes every next turn wait for the lease. |
| An agent orchestrating Workstreams through the gateway | An agent in a sandbox opening other Workstreams. | — | A hostile sandbox able to open sandboxes. |
| A runner of our own | A script driving the API. | — | Durability, retries, forms and a UI to rebuild. |

Google AX (September 2026, Apache-2.0, alpha) was seen too: a Kubernetes runtime for agents —
tasks, workspaces, a gateway injecting credentials — on Agent Substrate. It overlaps Agora's own
execution layer rather than orchestrating it.

## Consequences

- A second language in the repository: the flows are Python; `npm test` runs their unit tests.
- Prefect's server and database are one more component to run and back up (infra-k8s).
- The worker reaches Agora's server without the identity proxy and names the owner itself: the
  network policy is the only bound on who acts on Agora from inside the cluster.
- The role cards are part of the flow's contract: changing a persona changes every run after it.
- The prompts and the decisions' JSON are part of the flow's contract (`specs/flows.md`); what an
  agent does with them is checked only by the judge and by what the repository shows.
- An idle member holds its sandbox and a place of the quota until its lease ends.
- A run whose process dies stays `Running` in Prefect until it is marked `Crashed`: a heartbeat
  automation is still to be set.

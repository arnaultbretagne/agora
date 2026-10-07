# ADR 000n — Workflows

- **Status:** proposed
- **Date:** 2026-10-07

## Context

- Work worth automating takes several agents in turn — an architect, a developer, a reviewer — with
  a human's approval between some of them, and loops: a review that asks for changes sends the
  work back to development.
- Agora already runs each agent in a sandbox and keeps every exchange in its log; a step should be
  a Workstream like any other, which a person can open and take over.
- A step lasts up to an hour, an approval as long as a human takes. The orchestrator restarts,
  retries and resumes; none of that may start a second agent on the same work.
- Credentials stay in the gateway: whatever orchestrates holds no model key and no repository
  write token.
- Agora configures what it relies on and reimplements none of it: an orchestrator that exists is
  adapted before one is built.

## Decision

1. **Prefect** (open source, self-hosted on infra-k8s) runs the workflows: a server with its UI
   behind the identity proxy, one worker of type `process` on the work pool `agora`.
2. **The flows live in Agora's repository** (`apps/flows`), in Python, on the standard library and
   Prefect only; each run clones them at its deployment's branch.
3. **A step is one Workstream**, driven through Agora's server API in-cluster. Every id it sends is
   derived from the step's identity (run, step, round); Agora's command deduplication makes
   running a step again find it instead of repeating it.
4. **Humans decide through suspended runs**: Prefect's typed inputs (approval, verdict, retry or
   abort) — and Agora's client for an agent's permission.
5. **Work moves through the repository**: a branch per run; each step pushes before it answers.

## Why

- Prefect coordinates and owns nothing of the work: the agents, their workspaces and their
  credentials stay in Agora's sandboxes and gateway, so no step needs a second place to run.
- Flows are ordinary Python: loops and branches decided by an answer at run time, with no graph
  compiled in advance.
- Suspension with typed input is in the open-source server: its routes `/flow_runs/{id}/input`,
  and events with triggers, are in its code (3.8.8, read 2026-10-07); a suspended run holds no
  process.
- The cluster runs it in about 435 MiB — server 185, its PostgreSQL 130, worker 99, gate 21
  (`kubectl top`, 2026-10-07).
- Making a step idempotent took no change to Agora: command ids chosen by the client and their
  deduplication already exist for the browser.

## What we tried

Each option was studied on 2026-10-07 — code read where it says so, otherwise its documentation.

| Option | What it is | What we found | Why not |
| --- | --- | --- | --- |
| Archon (coleam00, v0.11.1, MIT) | A workflow engine for coding agents: YAML nodes, loops, approval gates, a plan → implement → review pack. | Code read: providers can be external processes (provider plugin protocol 1); its events follow ACP. Its own direction says remote isolation will come as plugins, the provider contract after the forge and chat ones. Bash nodes and the git worktree run on Archon's host. | The work would sit in two places — Archon's worktree and the sandbox — kept in step by syncing git around every turn, on a contract not yet stable. |
| acpx flows (openclaw, 0.19.4, MIT) and agentprism-workflows | TypeScript workflows over ACP agents, with checkpoints. | Agents are local stdio processes; a custom agent is any command speaking ACP on stdio. | Needs an adapter that turns Agora into a stdio ACP agent, rebuilding ACP from the projected thread; both tools are young. |
| GitHub Actions, gh-aw | Workflows triggered by issues and pull requests; gh-aw writes them in Markdown. | The official actions and gh-aw run the agent in the runner. | Only the triggers would serve; no workflow language for loops; a runner on g4 to reach Agora. |
| Temporal, Restate, DBOS, Hatchet, Argo Workflows | Durable execution engines. | Documentation: durability, signals and waits; nothing about agents or approvals forms. | Durability only: the roles, approvals and loops would be written by hand, as with Prefect, without its UI and forms. Restate is under BSL. |
| Airflow 3.3, Kestra 2.0, Windmill, n8n, Dagster | General orchestrators. | Airflow has approval operators since 3.1; Kestra a Pause task and a JVM; Windmill approval steps under AGPL; n8n a fair-code licence; Dagster is built around data assets. | Heavier, or a licence or model that fits less; Windmill stays the alternative if TypeScript flows are wanted. |
| An agent that orchestrates | An agent in a sandbox opening other Workstreams through the gateway. | — | A hostile sandbox able to open sandboxes. |
| A runner of our own | A script driving the API. | — | Durability, retries, forms and a UI to rebuild. |

Google AX (September 2026, Apache-2.0, alpha) was seen too: a Kubernetes runtime for agents —
tasks, workspaces, a gateway injecting credentials — on Agent Substrate. It overlaps Agora's own
execution layer rather than orchestrating it.

## Consequences

- A second language in the repository: the flows are Python; `npm test` runs their unit tests.
- Prefect's server and database are one more component to run and back up (infra-k8s).
- The worker reaches Agora's server without the identity proxy and names the owner itself: the
  network policy is the only bound on who acts on Agora from inside the cluster.
- A run whose process dies stays `Running` in Prefect until it is marked `Crashed`: a heartbeat
  automation is still to be set.
- Prompts are part of the flow's contract (`specs/flows.md`); what an agent does with them is not
  checked beyond the JSON it ends with and what the repository shows.

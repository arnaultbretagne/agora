# ADR 000n — Roles

- **Status:** proposed
- **Date:** 2026-11-16

## Context

- Work worth automating takes several agents — someone who builds, someone who checks, sometimes
  someone who knows how it will run — and loops: a check that fails sends the work back. Which
  steps a goal needs is not known in advance.
- Agents overrate their own work: whoever checks must not be whoever built, nor be steered by them.
- A member of a team should be a Workstream like any other, which a person can open and take over.
- Agora had two ways to hand work to another agent. The team flow, from 2026-10-23: a `lead`
  answering each turn with one decision in JSON — `plan`, `steps`, `verify`, `ask`, `done`, `stop` —
  which Python flows on Prefect checked and carried out. Delegation, from 2026-11-05 (ADR
  Delegation): the gestures the harnesses give their own sub-agents, on Agora's MCP server, and from
  2026-11-12 a delegate started as a role, `agent_type`.
- The flow was chosen when an agent starting agents was refused: "a sandbox treated as hostile
  could start sandboxes, and the rules would have to move into an API it reaches" (the record of
  that decision, 2026-10-23). Delegation is that API: a delegate's rights never go beyond its
  delegator's without the person's approval, three work at once, three levels deep, ten messages to
  one delegate until the person writes again.
- A role was a card of the flow: a persona and one default per setting. Only the flow and
  `spawn_agent` could start an agent as one; a person could not.
- Harnesses start a sub-agent as a type picked from a catalogue, by one parameter of the gesture
  that starts it, and give it its instructions as a system prompt (read on 2026-11-12: Claude Code,
  Codex 0.166.0, opencode 1.19.5; ADR Delegation).

## Decision

1. A role is a card of the repository: a persona, the harness, model and effort it works with by
   default, and the access a person's draft starts with.
2. A role is the Workstream's. Its first Create names it — a person's, from the client; an agent's,
   by `agent_type` — and it is kept.
3. Agora gives the persona itself: a block of its own ahead of the first prompt of every Session
   that opens with no history. One way, whoever named the role.
4. A team is a `lead`: a role whose card coordinates by delegation. Nothing orchestrates from
   outside: Prefect, the flows and the team's launcher are removed.
5. What a team must respect is what delegation enforces. The rest — a plan before any work, a fresh
   judge for each verification, nothing called finished that no judge passed — is the lead's card.

Decided on 2026-11-13 and 2026-11-16.

## Why

- **One way to hand work.** A lead that delegates uses the gestures every harness already gives its
  model, under rules the person already knows; the flow's lead answered in a vocabulary of its own
  that only the flow read.
- **One place to read a team.** A lead's delegates are sub-streams of its Workstream, in the tree:
  the person opens one, reads it, writes to it or stops it, as any delegate.
- **Work in parallel.** Three delegates work at once; the flow ran a decision's steps one after the
  other.
- **A role for anyone.** The same card serves a person who wants a judge on a pull request and a
  lead that starts one.
- **Less to run.** Prefect's server, its PostgreSQL, its worker and its gate held about 435 MiB
  (`kubectl top`, 2026-10-07), with a second language in the repository and a database to back up.

## What we tried

| Option | What we found |
| --- | --- |
| The team flow on Prefect: a lead deciding in JSON, the flow carrying out; one envelope — features, criteria, team, access — approved once; the judge started by the flow, the lead's question taken as data, a rubric and the criteria added by the flow; `done` refused until each feature was judged since its last change; 25 verifications and 100 decisions a run; every turn's ids derived from its identity, so that a retry found it | Built, and proven on g4 on 2026-10-23: a rehearsal of ten decisions, two refused, resumed twice, sent one Create and ten Writes and nothing twice. It enforced by code what a card can only ask. Dropped on 2026-11-16: a second way to hand work beside delegation, which had become the API the flow stood in for. |
| An orchestrator of another kind — Archon, acpx flows, Temporal and its kin, Kestra, Airflow, Windmill, n8n, Dagster | Studied on 2026-10-07, Kestra and Airflow run on g4 on 2026-10-21, to choose Prefect. With no orchestrator, none is needed. |
| A fixed pipeline: architect, approval, developer, reviewer | Run live on 2026-10-07: three rounds until the review approved. The same steps for every goal, the design handed from one agent to the next, the person approving mid-run. |
| A lead that writes its orchestration as code, run by a worker | Code written by an agent would run outside any execution. |
| A role's persona in the delegator's own words, at the head of its instructions | The delegate's title and its first message in its thread would be the card's, not the task's. |
| The persona in Agora's line of a delegate's first message | Built, live from 2026-11-12. A person's Workstream has no such line, and a Session opened anew after a lost anchor had the persona only through its catch-up, which leaves the oldest exchanges out of a long thread. Moved to a block of Agora's own. |
| The persona as the harness's system prompt | Each harness has its own way in — an agent file, a configuration layer, a field of its adapter — and Agora's executions are warm: their Pods start before anyone knows who they will be. Not built. |
| A role prefixed to its Workstream's title | Observed live on 2026-11-12: an agent given a role titles itself after its card ("Senior code review judge role"). Decided on 2026-11-13: a Workstream names itself as any other. |

## Consequences

- Nothing checks a team's course. A lead may start work before its plan is approved, call finished a
  feature no judge passed, or brief its judge toward a verdict; the flow refused each. The person
  reads the tree and the pull requests.
- A team's rights are the lead's own, or approved one call at a time: a lead given write access to a
  repository, so that its devs start at once, can write there itself.
- A team has no budget of its own. Delegation's bounds are its only ones.
- Nothing retries a team. A lead whose execution ended is continued by the next message written to
  it — the person's, or a delegate's last message.
- A persona is a message, not a system prompt: a harness that compacts a long conversation may lose
  it. A new Session is given it again.
- The cards ship in the server's image: a card changed reaches new Sessions with the next image.
- The Workstreams of the flow's runs stay in the log, read as any.

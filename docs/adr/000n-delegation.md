# ADR 000n — Delegation

- **Status:** accepted
- **Date:** 2026-11-12

## Context

- An agent needs to hand work to another: a review by another model, a read-heavy search in a
  context of its own, independent work in parallel or on a cheaper model, steps that follow each
  other under a lead.
- Each agent is a Workstream with its own sandbox; a Workstream takes one turn at a time; a message is
  the only way to speak to an agent, going into the running turn or as the next (ADR Log, ADR Steering).
- The person keeps control of rights: no agent may give another more than the person agreed to.
- Harnesses cut a tool call that lasts: Codex at 300 s whatever it receives; Claude Code after
  5 minutes without progress; opencode keeps a call open while progress comes (code read on
  2026-10-30: Claude Code 2.1.312, codex 0.165.0, opencode 1.19.5). Without progress, opencode's
  limit is its MCP client's: the SDK's default is 60 s; opencode's own setting is not verified.
- Harnesses list their tools when they choose: Codex once, as its Session opens, before any message
  (measured live on 2026-11-03: a Codex delegate answered "No `submit` tool is available").
- Harnesses have sub-agents of their own, driven by the same few gestures under near names (read on
  2026-11-11: the tools a Claude Code session lists, `Agent`, `SendMessage`, `TaskStop`, `ListAgents`;
  codex 0.165.0, `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`,
  `wait_agent`, `close_agent`; opencode 1.18.34, `task`, written to again by its `task_id`; Pi's
  prototype p2, `subagent` with spawn, send, stop, status and answer, and `team` for its sub-agents).
  In each, a sub-agent's work ends with its turn, and its last message goes to its parent by itself;
  none has a tool to end it, and none types a message between agents. A result of a given shape exists
  only for a one-shot agent started by a script, checked on its final answer by what started it (Pi's
  `tools.agent`, Claude Code's workflow scripts), and for a whole run (`codex exec --output-schema`).
- Three of them start a sub-agent as a type picked from a catalogue, by one parameter of the gesture
  that starts it (read on 2026-11-12): Claude Code's `Agent`, `subagent_type`, optional — measured in a
  capture of 2026-11-11, always `general-purpose` —; codex 0.166.0's `spawn_agent`, `agent_type`,
  optional, "omit unless explicitly asked"; opencode 1.19.5's `task`, `subagent_type`, required. A
  type is a description the caller reads, instructions the sub-agent is given — a system prompt, or
  Codex's developer instructions —, and a model, an effort, tools. The caller never writes that
  prompt: it names the type and gives the task. Pi's p2 has no type: its `subagent` takes a model, a
  thinking level and tools at each spawn; the sub-agent example of the Pi before it took an `agent`,
  a Markdown file's name.
- Agora already has such a catalogue: the flows' role cards — a persona, a harness, a model, an effort
  each —, which a flow puts at the head of a member's first message.

## Decision

1. Delegation is asynchronous: a call on Agora's MCP server (ADR MCP) answers as soon as its message
   is accepted.
2. A delegate is a sub-stream of its delegator's Workstream: three levels deep at most, three at once
   per delegator. A delegate may delegate in turn.
3. One gesture, both ways: a message written in the other's Workstream, by the primitive the person
   uses. `spawn_agent` and `send_message` write in the delegate's; a delegate's turn, once done, sends its
   last message to its delegator's, and `send_message` to `parent` writes there before that. Agora then
   decides as for any message: into the running
   turn when the agent can take it there, as the next turn otherwise (ADR Steering). Unlike the
   person's, nothing refuses it: it waits until its Workstream can take it.
4. Agora carries the words, whole, and decides nothing about them: no outcome, no report, no verdict.
   The delegator reads, and writes again if it wants more.
5. Rights beyond the delegator's: the call itself waits for the person, at most 4 min 30 s — one
   button, Approve; writing refuses, and the words are the call's answer. An approval holds for that
   call alone.
6. At most ten `send_message` to one delegate since the person last wrote, in either Workstream.
   Decided on 2026-11-05.
7. The tools bear the names of the gestures the harnesses give their own sub-agents — `spawn_agent`,
   `send_message`, `stop_agent`, `list_agents` — and do what those do: no tool ends a delegate's work,
   its last message does; no message is typed; stopping cancels the running turn and leaves the
   delegate within reach; listing says who is working. Decided on 2026-11-11.
8. `spawn_agent` takes an optional `agent_type`, as the harnesses' own gesture does: one of Agora's
   roles, the flows' cards. The card gives the delegate its persona, in Agora's line of its first
   message, and the harness, model and effort it works with unless the call names others. Decided on
   2026-11-12.

## Why

- **The delegator keeps working.** It can delegate more, or answer the person, while its delegates
  work; several delegations run side by side in Agora instead of one after the other in Claude Code.
- **Nothing waits, nothing polls.** Waiting for the work would hold a turn and outlast every
  harness's patience; polling would spend turns. A message is the one way to speak to an agent.
- **The delegator judges.** It knows what it asked. Agora does not, and every outcome it computed was
  a guess about a conversation it does not understand.
- **One primitive is enough.** A result, a question, a correction, a failure are all a message from
  someone, on the path the person's take. There is no state to keep in step with the log but the log's
  own, and no second way for a message to reach an agent.
- **One counter is enough for a loop.** A delegate only speaks after a message, and its delegator
  can only answer it by `send_message`: every loop between two agents goes through that one call.
  Refusing there loses no words, and the log already counts it.
- **Nothing to learn.** A model knows these gestures from its own harness: started, written to, stopped
  and listed under the names it expects, a delegate is used as a sub-agent is, and its last message is
  its answer, as everywhere else. Measured live on 2026-11-05: a Codex delegate not told of `submit` by
  name answered in its last message, which reached its delegator whole; the case's script then had to
  name the tool (`reliability/delegation.md`, R7).
- **Nothing invented.** Each gesture is one four harnesses already run, with the meaning they give it;
  what none of them does — a tool to hand a result in, a typed message — Agora does not do either.
- **One catalogue of roles.** A delegate started as a `judge` is the judge a flow runs: the same card,
  the same model. A role is written once, and what improves it improves both.

## What we tried

| Option | What we found |
| --- | --- |
| Reports written by Agora when a delegate's turn ended: an outcome, a result if submitted, else the last message cut at 2,000 characters, "Read `<id>` for the rest" | Built, then used once, on 2026-11-03: a caller given no `read` could not fetch the rest of an 8-minute research. It asked for it through `submit`, unavailable to its Codex delegate, then page by page: 28 `to`, 29 reports, 15 minutes; the delegate went on writing in 1,500-character parts when the person spoke to it directly hours later. |
| `to` refused while a delegate's turn runs (`delegate_busy`) | The same run: the person's correction, a minute after the start, could not reach the delegate. |
| A delegate's message only ever as its delegator's next turn | A delegator could work a long time without a result that changes its work, and a second rule would decide what the person's messages do not have to. Decided on 2026-11-04: one path. |
| A `submit` tool listed to every delegate, for its result, its questions and its news; a turn with a `submit` sending nothing more by itself | Built, live from 2026-11-03. No harness gives a sub-agent a tool to end its work (read on 2026-11-11, the versions above): Agora already sent the last message of a turn with no `submit`, and a Codex delegate not told of the tool never called it. The rule on what a turn with a `submit` leaves unsent had to be taught by the tool's description. Dropped on 2026-11-11: the last message ends the work, `send_message` to `parent` speaks before it. |
| A result typed by an `output_schema` its delegator gives, checked by `submit` | Built and proven: a result that does not fit refused as a tool error, three harnesses returning the shape asked, live on 2026-11-03 and 2026-11-05. No harness types a message between agents; a shape is checked only on a one-shot agent's final answer. Here its reader is a model, which reads prose as well. Dropped with `submit` on 2026-11-11. |
| Names of Agora's own: `delegate`, and `to` on it to write again | One tool for two gestures, under a name no harness uses: a model learned it from its description alone. Renamed on 2026-11-11. |
| A2A (v1.0.1, read on 2026-11-04): tasks, states, artifacts, its own wire protocol | No coding harness speaks it (read on 2026-10-29): an MCP tool would stand in front of it all the same, and Agora would still decide how words reach an agent. Its separation of a deliverable from messages was the right diagnosis of the reports; a message carried whole answers it with one primitive. |
| MCP Tasks | Only Claude Code implements it, in beta (read on 2026-10-29). |
| A synchronous `delegate`, answering with the result | The call outlasts the harnesses' limits; the delegator cannot answer the person meanwhile; Claude Code would run several delegations one after the other. |
| A `wait` tool, or polling | Waiting holds a turn; polling spends turns. |
| Rights narrowing at each level, with no way beyond | A lead could never hand a delegate more than it holds itself; an approval covers that case, once, by the person. |
| An approval for the rest of the conversation | Decided against: the person sees each grant; one approval for a chain of runs comes with teams built of delegations. |
| An envelope approved once, the Prefect team flow | A fixed plan; delegations compose instead, each call under its own rule. |
| MCP's `outputSchema` | It types a tool's own answer; `spawn_agent` answers before the work is done. |
| MCP elicitation | It asks the person, not the model. |
| A role's persona as the harness's system prompt | Each harness has its own way in — an agent file, a configuration layer, a field of its adapter — and Agora's executions are warm: their Pods start before anyone knows who they will be. Not built: the persona goes where the flows already put it, in the first message, by the one way every harness reads. |
| The persona in the delegator's words, at the head of the instructions | The delegate's title and its first message in its thread would be the card's, not the task's. In Agora's line, the thread and the title stay the delegator's. |
| The card's text first in Agora's line | An agent that titles itself with the first line it reads would be named after its card: the line opens `From Agora,`, which the title's rule already leaves out (`specs/delegation.md`, D32). |

## Consequences

- The log gains a mark saying who wrote a message, and a Write of Agora's that nothing refuses; earlier
  reports and facts stay in the log, read as they were.
- A message reaching a running turn cuts its generation, as the person's does (ADR Steering); it never
  disturbs a running tool. A Write of Agora's re-arms what a Cancel held, as any Write: a Workstream
  the person wants silent is one they stop.
- A delegator never waits for words that will not come: a delegate's turn, once done, sends its last
  message, whole; failures reach it the same way.
- A delegate that writes to `parent` during its turn still sends its last message at its end: Agora
  cannot tell news from a result. A deliverable sent both ways is written twice; the tool's description
  says what `parent` is for.
- No result is checked: a delegator that needs a shape asks for it in its instructions, and reads the
  answer.
- The names are near a harness's own: Codex lists a `spawn_agent` of its own beside Agora's (codex
  0.165.0, its sub-agents on by default, measured on 2026-11-11). The server's name and the tool's
  description tell them apart; a model that picks its harness's own starts a sub-agent Agora does not run.
- A delegator's `stop_agent` cancels a turn and nothing else: the delegate's own delegates go on, and
  the next message written to it, one of theirs included, starts it again.
- Earlier `delegate` and `submit` lines stay in the log, drawn as they were; a call to either name is
  refused. A turn that called `submit` under that contract stays silent: the engine reads the mark that
  `submit` left, or the first start of this one would send each such turn's last words to its delegator.
- An execution that took no prompt is not continued by itself, or a delegate that cannot start would
  make Pods without end: a message coming once it was over tries once more, as the person's Create does.
  There are never more Creates of Agora's than messages.
- A message the person retracts reaches nobody, and Agora tells nobody: the person did it, and can say so.
- A chain of new delegates, each started once the last has answered, is under no cap but the person's
  Stop: it is not a loop between two agents.
- What does not fit in a message has no way across yet: Agora has no persistent store for files.
- A turn's maximum duration no longer counts the time its approvals waited.
- A role's persona is a message, not a system prompt: a harness that compacts a long conversation may
  lose it, as a flow's member may. It is in the log: a catch-up gives it back with the first exchange,
  unless the thread has grown past what a catch-up carries, which leaves the oldest exchanges out.
- The cards ship in the server's image: a card changed reaches delegations with the next image, and a
  flow's run with its next clone. The two may differ for the time of a deploy.
- A role gives no right: a `judge` started without read access to the repository it judges cannot read
  it. The delegator names the rights, and the person approves those beyond its own.
- A delegate's view and its row in the list carry its state, which its delegator's `spawn_agent` line
  shows and `list_agents` says.
- A call Agora holds answers in an SSE stream; every other message stays one JSON answer.
- The Prefect lead flow becomes one composition among others, to retire once teams are built of
  delegations.

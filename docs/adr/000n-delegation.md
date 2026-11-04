# ADR 000n — Delegation

- **Status:** proposed
- **Date:** 2026-11-04

## Context

- An agent needs to hand work to another: a review by another model, a read-heavy search in a
  context of its own, independent work in parallel or on a cheaper model, steps that follow each
  other under a lead.
- Each agent is a Workstream with its own sandbox; a Workstream takes one turn at a time; a turn is
  the only way to speak to an agent (ADR Log).
- The person keeps control of rights: no agent may give another more than the person agreed to.
- Harnesses cut a tool call that lasts: Codex at 300 s whatever it receives; Claude Code after
  5 minutes without progress; opencode keeps a call open while progress comes (code read on
  2026-10-30: Claude Code 2.1.312, codex 0.165.0, opencode 1.19.5). Without progress, opencode's
  limit is its MCP client's: the SDK's default is 60 s; opencode's own setting is not verified.
- Harnesses list their tools when they choose: Codex once, as its Session opens, before any message
  (measured live on 2026-11-03: a Codex delegate answered "No `submit` tool is available").

## Decision

1. Delegation is asynchronous: a call on Agora's MCP server (ADR MCP) answers as soon as its message
   is accepted.
2. A delegate is a sub-stream of its delegator's Workstream: three levels deep at most, three at once
   per delegator. A delegate may delegate in turn.
3. One gesture, both ways: a message written in the other's Workstream. `delegate` writes in the
   delegate's; `submit` in the delegator's, and a turn ended with no `submit` submits the delegate's
   last message. A message opens a turn like any other, and waits in the log while its Workstream
   cannot take it (ADR Log).
4. Agora carries the words, whole, and decides nothing about them: no outcome, no report, no verdict.
   The delegator reads, and writes again if it wants more.
5. Rights beyond the delegator's: the call itself waits for the person, at most 4 min 30 s — one
   button, Approve; writing refuses, and the words are the call's answer. An approval holds for that
   call alone.

## Why

- **The delegator keeps working.** It can delegate more, or answer the person, while its delegates
  work; several delegations run side by side in Agora instead of one after the other in Claude Code.
- **Nothing waits, nothing polls.** Waiting for the work would hold a turn and outlast every
  harness's patience; polling would spend turns. A message is the one way to speak to an agent.
- **The delegator judges.** It knows what it asked. Agora does not, and every outcome it computed was
  a guess about a conversation it does not understand.
- **One primitive is enough.** A result, a question, a correction, a failure are all a message from
  someone. There is no state to keep in step with the log but the log's own.
- **A shape the model can keep.** Models fill a tool's arguments to its schema, so `result` stays, for
  a delegator that will act on its fields; `submit` is listed to every delegate, its schema checked by
  Agora, because a harness may never list another tool.

## What we tried

| Option | What we found |
| --- | --- |
| Reports written by Agora when a delegate's turn ended: an outcome, a result if submitted, else the last message cut at 2,000 characters, "Read `<id>` for the rest" | Built, then used once, on 2026-11-03: a caller given no `read` could not fetch the rest of an 8-minute research. It asked for it through `submit`, unavailable to its Codex delegate, then page by page: 28 `to`, 29 reports, 15 minutes; the delegate went on writing in 1,500-character parts when the person spoke to it directly hours later. |
| `to` refused while a delegate's turn runs (`delegate_busy`) | The same run: the person's correction, a minute after the start, could not reach the delegate. |
| A2A (v1.0.1, read on 2026-11-04): tasks, states, artifacts, its own wire protocol | No coding harness speaks it (read on 2026-10-29): an MCP tool would stand in front of it all the same, and Agora would still decide how words reach an agent. Its separation of a deliverable from messages was the right diagnosis of the reports; a message carried whole answers it with one primitive. |
| MCP Tasks | Only Claude Code implements it, in beta (read on 2026-10-29). |
| A synchronous `delegate`, answering with the result | The call outlasts the harnesses' limits; the delegator cannot answer the person meanwhile; Claude Code would run several delegations one after the other. |
| A `wait` tool, or polling | Waiting holds a turn; polling spends turns. |
| Rights narrowing at each level, with no way beyond | A lead could never hand a delegate more than it holds itself; an approval covers that case, once, by the person. |
| An approval for the rest of the conversation | Decided against: the person sees each grant; one approval for a chain of runs comes with teams built of delegations. |
| An envelope approved once, the Prefect team flow | A fixed plan; delegations compose instead, each call under its own rule. |
| MCP's `outputSchema` | It types a tool's own answer; `delegate` answers before the work is done. |
| MCP elicitation | It asks the person, not the model. |

## Consequences

- The log gains a mark saying who wrote a message, and a Write that waits; earlier reports and
  facts stay in the log, read as they were.
- A delegator never waits for words that will not come: a turn with no `submit` submits its last
  message, whole, so a long deliverable is not written twice; failures reach it the same way.
- What does not fit in a message has no way across yet: Agora has no persistent store for files.
- A turn's maximum duration no longer counts the time its approvals waited.
- A delegate's view and its row in the list carry its state, which its delegator's `delegate` line
  shows.
- A call Agora holds answers in an SSE stream; every other message stays one JSON answer.
- The Prefect lead flow becomes one composition among others, to retire once teams are built of
  delegations.

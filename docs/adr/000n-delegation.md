# ADR 000n — Delegation

- **Status:** proposed
- **Date:** 2026-11-02

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
- Claude Code runs an MCP tool not marked read-only one call at a time (same reading).

## Decision

1. One tool, `delegate`, on Agora's MCP server (ADR MCP), asynchronous: it answers once the delegate
   has started; each outcome comes back later as a turn Agora writes to the caller, once the caller
   is free.
2. A delegate is a sub-stream of its caller's Workstream: three levels deep at most, three at once
   per caller. A delegate may delegate in turn.
3. Rights within the caller's own: the delegate starts at once. Beyond them: the call itself waits
   for the person, at most 4 min 30 s — one button, Approve; writing refuses, and the words are the
   call's answer. An approval holds for that call alone.
4. A typed result is a tool Agora lists to the delegate, `submit`, its input the schema the caller
   gave.

## Why

- **The caller keeps working.** It can delegate more, or answer the person, while its delegates
  work; several delegations run side by side in Agora instead of one after the other in Claude
  Code.
- **Nothing waits, nothing polls.** Waiting for the work would hold a turn and outlast every
  harness's patience; polling would spend turns. Agora writes the outcome when the caller can take
  it, which is the one way to speak to an agent.
- **The person decides on the call.** Nothing starts before the approval; the agent learns the
  outcome as its own call's result, inside its turn, on every harness — the refusal included, with
  the person's words, so it can propose again. 4 min 30 s stays under Codex's 300 s, and progress
  every 30 s keeps the others from cutting.
- **A shape the model can keep.** Models fill a tool's arguments to its schema; a result written as
  JSON in prose drifts and mixes with the text around it.

## What we tried

| Option | Why not |
| --- | --- |
| A synchronous `delegate`, answering with the outcome | The call outlasts the harnesses' limits; the caller cannot answer the person meanwhile; Claude Code would run several delegations one after the other. |
| A `wait` tool, or polling | Waiting holds a turn; polling spends turns. |
| Rights narrowing at each level, with no way beyond | A lead could never hand a delegate more than it holds itself; an approval covers that case, once, by the person. |
| An approval for the rest of the conversation | Decided against: the person sees each grant; one approval for a chain of runs comes with teams built of delegations. |
| An envelope approved once, the Prefect team flow | A fixed plan; delegations compose instead, each call under its own rule. |
| JSON at the end of the delegate's answer | Fragile, mixed with prose, asked again on each mismatch. |
| MCP's `outputSchema` | It types a tool's own answer; `delegate` answers before the work is done. |
| MCP elicitation | It asks the person, not the model. |

## Consequences

- The log gains the delegation's facts, report turns marked as Agora's, approvals with an expiry,
  and a Write that refuses an approval instead of prompting.
- A turn's maximum duration no longer counts the time its approvals waited.
- A call Agora holds answers in an SSE stream; every other message stays one JSON answer.
- The Prefect lead flow becomes one composition among others, to retire once teams are built of
  delegations.
- Messages during a turn stay refused, but an approval's refusal: queueing and steering are their
  own subject (issue #167).

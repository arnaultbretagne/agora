# ADR 000n — Subagents

- **Status:** proposed
- **Date:** 2026-11-11

## Context

- A harness starts sub-agents of its own inside its execution: Claude Code's `Agent`, Codex's
  `spawn_agent`. Agora showed them as tool lines of their parent, or not at all: nobody could read what
  a sub-agent did, nor tell that one was still working.
- Agora has delegates (ADR Delegation): agents it starts itself, each a sub-stream with an execution of
  its own. The person reads both kinds of child in one tree.
- ACP has an extension for it, "Subagent Sessions" (its RFD read on 2026-11-11, last revised on
  2026-11-09, about ten revisions since 2026-10-01). An agent announces each sub-agent with a
  `subagent_update` on its parent's stream, then sends what it does under a session id of its own. It
  goes one way, from the agent to the client: the client may only cancel a sub-agent that offers it. A
  client asks for it by declaring `subagents` at `initialize`; in ACP v2 the RFD makes it part of the
  base protocol.
- claude-agent-acp 0.100.0 and codex-acp 2.5.0 implement it. opencode's sub-agents were not measured.
- Measured on 2026-11-11, on throwaway Pods of the production images (claude-code 2.1.316, codex
  0.165.0), one run per scenario, on Haiku and gpt-6-luna:

| What | Found |
| --- | --- |
| `subagents` declared, Agora as it was | None of 1,559 lines refused. Each sub-agent's lines were filed in its parent's Session: its text drawn as its parent's words; its tools and permissions in its parent's turn; its parent's settings replaced by its own, and on Codex its context's usage too. The tool line that started it had left the parent's stream. |
| The announcement | Before any line of the sub-agent's own, on both. Claude Code: a title, a description ("general-purpose" each time), `cancel` kept after `idle`, and the task as a `session_message` with its sender and recipient. Codex: a title, `cancel` only while it runs, no task. |
| States | `running`; `requires_action` during a permission; `idle` with `end_turn` or `cancelled`. Never `unknown`, never `error`. |
| Size | 3 to 41 lines, 1 to 14 KB a sub-agent. |
| Claude Code | 6 of 8 sub-agents started in the background, told to wait or not. Cancelling the parent's turn stopped none. A sub-agent cancelled alone ended within 100 ms. |
| Codex | Cancelling the parent's turn marked every sub-agent cancelled at once, their commands ending 35 to 40 s later. A sub-agent cancelled alone left its parent's `wait` asleep: its answer came at 255 s. A sub-agent's own sub-agent was never said `idle`. |
| Restoring | `session/resume` announced nothing again on either. `session/load` replayed the sub-agents on Claude Code, the first level alone on Codex. |

## Decision

1. Agora declares `subagents` at `initialize`.
2. Each sub-agent announced is a sub-stream of the Workstream that announced it: a row in the tree and
   a thread of its own, as a delegate has. One display for both kinds of child.
3. It is read-only: no message, no setting, no execution of its own. The person answers a permission
   it asks, and cancels its turn where its adapter offers it.
4. Its lines stay in the log of its host, the Workstream whose execution carries them; the projection
   gives them their thread. Nothing of them reaches its host's Session.
5. ACP feeds Agora's objects, and its names stay out of them: a sub-agent's work becomes turns, as any
   thread's — `done`, `cancelled`, `failed`.
6. Agora ends what an adapter leaves open: a sub-agent's turn still in progress when its host's
   execution ends is `failed`.
7. A message does not go into a turn while a sub-agent of its Session works.

## Why

- **One tree, one thread.** The person reads a sub-agent as a delegate: where it sits, what it was
  asked, what it did. What differs is what can be done to it, and its thread says so.
- **Lines where the wire is.** One log, one dispatcher and one connection for an execution, as before:
  the answer to a sub-agent's permission and its cancellation are lines on its host's connection.
- **Rebuildable.** The split is a fold of the host's entries: showing a sub-agent another way rewrites
  no entry.
- **Turns Agora already has.** `running`, and `idle` with its stop reason, say what Agora's turns say.
  Reusing ACP's words would serve the display and nothing else: no agent reads them, and Agora serves
  no other client (decided on 2026-11-07).
- **Small.** A sub-agent weighs 1 to 14 KB of lines, measured.

## What we tried

| Option | What we found |
| --- | --- |
| Declaring `subagents` and nothing else | Measured, the table above: nothing refused, and a thread that mixes its sub-agents' words with its agent's. |
| A counter on the parent's row, the thread opened from the parent's line | Shown beside the node on 2026-11-11, on the captured lines. It never shows a sub-agent wrongly said working; but a native child and a delegate are then reached two ways. Decided the same day: a node. |
| Agora's states renamed after ACP's | Studied on 2026-11-06 and 2026-11-07: the extension goes from the agent to the client, so no model reads them. |
| A log of its own for each sub-agent | Studied, not built. The answers to a sub-agent's requests leave by its host's connection: two Workstreams would dispatch on one connection, and its admission would read another Workstream's execution entries. |
| Leaving sub-agents as tool lines | Measured without the capability: Claude Code puts a sub-agent's tool calls in its parent's turn, never its text, and a background sub-agent's result arrives after the turn's answer; Codex shows three tool lines. |
| Writing to a sub-agent | ACP forbids it to the client; its RFD names a `prompt` capability, for later (revision of 2026-11-09). |

## Consequences

- A sub-agent shows working for as long as its adapter says nothing else: Codex's sub-agents of
  sub-agents until their host's execution ends, then `failed`.
- A Codex sub-agent's thread opens on its answer: Codex reports no task.
- Cancelling a sub-agent is its adapter's doing, and Codex's parent may wait minutes for it. Cancelling
  a turn cancels none of its sub-agents: Claude Code leaves them running.
- A message written while sub-agents work waits for them, or for the turn's end. Claude Code no longer
  shows the tool that waits for a sub-agent, so Agora cannot tell one awaited from one in the
  background. Not measured: what a message sent into the turn does while one is awaited.
- After a restore, the sub-agents of earlier executions stay as they ended: nothing announces them again.
- The tree gains a row for each sub-agent, folded under its parent.
- The extension is not in the pinned schema, and its RFD still changes. What Agora reads of it — the
  members of `subagent_update` and of `session_message` — is in one place: `log.md`, "Native
  sub-agents".

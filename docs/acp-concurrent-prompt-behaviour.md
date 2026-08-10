# What ACP Agents actually do with a second prompt

Measured 2026-08-10, against the real adapters, because `docs/specs/03-session-lifecycle.md` says
"only one prompt turn may be in flight per Session in v1" and nothing in this codebase enforced it.
The question that had to be answered before choosing an enforcement was not what the specification
permits, but what the Agents we can actually launch *do*.

## The short answer

**None of the four refuses.** They diverge on everything else, including whether the second prompt
is acknowledged at all and whether the running turn survives it.

| Agent | 2nd request answered? | Fate of the running turn | 2nd prompt's content |
|---|---|---|---|
| Codex (`@agentclientprotocol/codex-acp` 1.1.14) | **never** | runs to completion, `end_turn` | processed — folded into the running turn and answered inline |
| Claude Code (`@agentclientprotocol/claude-agent-acp` 0.66.0) | yes, `end_turn` | **truncated**, still reported `end_turn` | processed afterwards, as its own turn |
| OpenCode (`opencode-ai` 1.18.16) | yes, `end_turn` | runs to completion, never interrupted | queued; separate model call after the first finishes |
| Pi (`pi-acp` 0.0.33 + `@earendil-works/pi-coding-agent` 0.84.1) | yes, `end_turn` | runs to completion | queued; first turn answered, then the second |

## Why this rules out the obvious designs

**Relying on the response is impossible.** Codex absorbs the extra `session/prompt` into its running
thread and never sends a JSON-RPC response for it. This violates ACP's own rule — "the Agent MUST
respond to the original `session/prompt` request with a `StopReason`" — but it is what it does, and
it is what wedged a real Session on 2026-08-09: three requests awaited forever, three Commands stuck
`dispatching`, three turns stuck `running`, and a Session that the idle reaper could no longer
touch because `listIdleSessions` (correctly) refuses to reap a Session with an unfinished turn.

**Relying on `stopReason` is impossible.** Claude Code cuts the running turn short when a second
prompt arrives and reports `end_turn`, which is indistinguishable from finishing. Measured with a
control: the same task ("create 12 files one at a time") run alone completes all 12 in 133 s; run
with a second prompt sent at 17 s it stops after 2 files at 23 s, and still says `end_turn`.

**Relying on the first turn's response timing is impossible.** OpenCode resolves *both* prompt
requests at the same instant, when its whole queue drains — so a client cannot tell when the first
turn ended.

**Exposing the concurrency to users is therefore not portable.** Codex's inline answering (its
`_meta.codex.phase: "commentary"` stream) is genuinely nice, and it is why the operator on
2026-08-09 saw real answers while the turn was still running. But it is one Agent's extension, and
enabling that behaviour generally would mean accepting that Claude Code silently discards work.

## What we do instead

Queue it. `apps/web/src/prompt-queue.ts` serializes dispatch per Session, so the Agent never sees a
second `session/prompt` before the first has answered — the one behaviour all four handle correctly,
and the one OpenCode and Pi already implement internally. The product keeps the affordance (type
while it works; the message is sent when the Agent is free) without depending on anything
Agent-specific.

## Reproducing

The probe used for these measurements is not part of the build: it drives each adapter over stdio,
sends a long first prompt, sends a second one 12 s in, and records separately whether the first
request is answered, whether the second is, and whether the second's *content* was processed
(a unique marker the prompt asks the Agent to echo).

Two traps worth knowing before trusting any rerun:

- **The marker is streamed token by token** (`MARQ` / `UEUR` / `-B7X9Q`). Searching for it inside a
  single frame reports "not processed" for an Agent that answered perfectly. Reconstruct the text
  stream first. The first run of this probe got Codex wrong for exactly this reason.
- **A task with no tool calls is a poor instrument.** Steering appears to be picked up between
  steps of a turn, so a single-shot text generation offers no insertion point.

Codex and Claude Code were measured against real credentials and real tool use. OpenCode and Pi were
measured against a local OpenAI-compatible stub model — enough for the protocol semantics, which are
decided by the adapter, but their behaviour under real tool calls has not been verified.

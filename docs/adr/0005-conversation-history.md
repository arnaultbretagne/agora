# ADR 0005 — Conversation as first-class: the hub owns the history (sole source of truth); resume = re-seed

## Status

Accepted — **spike-confirmed** 2026-06-30 (see `/srv/spike/FINDINGS.md`). Supersedes the earlier
"resume = native `--resume`" mechanism, which the spike disproved for channel conversations.

## Context

The hub aggregates **conversations** (ADR 0004); a conversation **survives** its pipe (claude.ai-style
UX: reopen, read the past, resume — **even when no runtime is running**). The **conversation** is the
first-class object, not the file (≠ the "vault + git" angle of the old tools).

**First intent — discarded.** "history = a read-model of the JSONL in `~/.claude/projects`". Flaws:
**hostage to the PVC** (no PVC ⇒ no history) and **hostage to the format** (JSONL is Claude-Code-specific
⇒ breaks runtime-agnosticism; and its format **changes between releases** — Claude Code's own docs warn
scripts parsing it can break).

**The spike (2026-06-30) then closed the question** — the native transcript is **not a reliable record
of a channel conversation at all**:

- inbound `<channel>` events are **not written** to the JSONL (GitHub #55896); only claude's `reply`
  calls are, *if* a transcript exists;
- our **interactive `--dangerously-load-development-channels` sessions wrote no transcript whatsoever** (a
  typed turn + a channel turn, clean exit → nothing under `~/.claude/projects/`);
- channels are **real-time only** ("events arrive only while the session is open"); there is **no
  documented support** for resuming a channel-driven session.

## Decision

**The conversation is first-class. The hub owns its history as the SOLE source of truth; resuming a
dormant conversation re-seeds a fresh runtime from that history.**

1. **History — owned by the hub, in a neutral format, sole source of truth.** Every message passes
   through the hub: it **sends** each inbound (user → channel → claude) and **receives** each outbound
   (the `reply`, which the spike proved arrives as **one clean final turn**). The hub **persists both
   sides as it streams** (`shared/` protocol, ADR 0003). Neutral (multi-harness), hub-owned (PVC- and
   harness-independent). This is what **every client displays** — and the **only** record.
2. **Resume = re-seed, NOT `--resume`.** The native transcript / `--resume` is **redundant and
   incomplete** for channel conversations (above) → the product **never reads the JSONL and never relies
   on `--resume`**. To reopen a `dormant` conversation, the hub asks the supervisor for a **fresh
   runtime** and **seeds it with the conversation's history** (replays the prior turns as context).

Conversation states: **`live`** (pipe ⟷ runtime) / **`dormant`** (hub history, no runtime).

> **Guiding principle:** *product history must depend neither on a harness's format, nor on a runtime
> PVC, nor on the native transcript.* The hub — which sees every message in both directions — is the
> natural and complete record.

## Rationale

- **The hub is the complete record by construction.** It originates every inbound and receives every
  outbound, so it needs neither the JSONL nor claude's transcript to know the full conversation. (Spike:
  `reply()` = one clean final turn, no streaming; the channel never carries internal reasoning/tool-use,
  so the neutral history is exactly the user-facing thread.)
- **The native transcript is the wrong foundation — proven, not assumed.** It drops inbound channel
  events and, in practice, wasn't even written for our channel sessions. Building history or resume on it
  would be building on sand. *(This also makes the earlier "JSONL format is version-fragile" worry moot:
  we never touch it.)*
- **Re-seed beats `--resume` AND "keep the runtime alive".** Keeping N runtimes alive "just in case" is
  costly (RAM, creds — `agent-runtime` ADR 0006) and unnecessary; and `--resume` doesn't work for channel
  convs. Re-seeding from the hub's history makes conversations **cheap** and **disposable**: *no pipe ≠ no
  conversation*, and reopening is just "spawn + replay context".

## Spike results (2026-06-30) — what was confirmed

- **What the channel carries**: `reply()` = **one clean final turn**, no streaming/partials, no internal
  transcript → the hub-observed history is faithful and already neutral. ✅
- **Native persistence/resume**: inbound channel events **not** in the transcript; interactive
  dev-channel sessions wrote **no** transcript; **no resume** for channel convs → **`--resume` dropped**,
  re-seed adopted. ✅
- **Enablement** (D2): channel = a `--channels` / `--dangerously-load-development-channels` flag **+** an
  MCP server (plugin or `.mcp.json`) declaring `claude/channel` **+** `--allowedTools` for the reply tool.
- **Build-time** (not upstream unknowns): the **re-seed** mechanics (how many prior turns, what format)
  and **hub-down buffering** are the channel/website's job.

## Consequences

- **Two states** (`live` / `dormant`) presented in a single gesture (the claude.ai list).
- **The hub owns a conversation store** (neutral history, sole source of truth) → **patches ADR 0004**:
  the hub's state is not "thin". *(Where it lives — the website pod's DB / volume — settled while
  building; **not** the runtime PVC.)*
- **Identity mapping**: product conversation ⟷ the pipe's `chat_id` while `live`. *(No native-session /
  `--resume` id to track — the product doesn't use it.)*
- **The native JSONL/transcript is unused by the product** — never read, never resumed from. `claude`
  writes whatever it writes; the product ignores it.
- **Resume is a product mechanism** (re-seed from history), not a runtime/harness feature → it works
  identically for any runtime kind (claude, codex…).
- **Out of scope**: editing / forking a conversation; importing a claude session created outside agora.

## Build validation (2026-07-01) — the re-seed works on real Claude Max

POC (`/srv/agora`) proved the decision end-to-end: a conversation goes `live` (hub pushes the turn,
claude `reply`s), `close` kills the runtime → `dormant`, and reopening spawns a **fresh** runtime that
the hub **seeds with a flattened, role-tagged replay of its own history** — claude then answered a
question that depended on a turn from *before* the restart (recalled a keyword from the seeded history).
No `--resume`, no JSONL read. Two build-time mechanics were settled here (both **channel/website**, not
ADR-level): the seed format = one plain-text push `[conversation resumed] <history>…</history> + new
turn`; and the **first push to a fresh runtime can be dropped** (startup race) → the channel gates
delivery on claude-readiness and **re-delivers the un-`reply`d push** until acked (`/srv/spike/FINDINGS.md`
§5b). A `live` runtime that survives a **hub** restart is **re-claimed** (persisted pipe lease), *not*
re-seeded — re-seed is only for a genuinely fresh runtime.

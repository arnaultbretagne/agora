# ADR 0005 — Conversation as first-class: product history (hub, neutral) vs runtime resume (native)

## Status

Proposed — 2026-06-30. **Mechanism to validate via a spike** (cf. § *To validate*). We fix the
**principle**; we do **not** carve in the details of an upstream we haven't tried yet.

## Context

The hub aggregates **conversations** (ADR 0004); a conversation **survives** its pipe (claude.ai-style
UX: reopen, read the past, resume — **even when no runtime is running**). The **conversation** is the
first-class object, not the file (≠ the "vault + git" angle of the old tools).

**First intent — discarded.** "history = a read-model of the JSONL in `~/.claude/projects`". Two
**deal-breaking** flaws:

1. **Hostage to the PVC** — no connection to the runtime's PVC ⇒ **no history at all**.
2. **Hostage to the format** — JSONL is **Claude-Code-specific** ⇒ it breaks **runtime-agnosticism**
   (codex doesn't write this format; ADR 0001/0002).

It **conflated two different things**: the *conversation* (what the human reads) and the agent's
*resume context*. And above all: **we don't yet know precisely how the upstream behaves** (what the
channel carries, how `--resume` reacts, buffering across disconnects…). So we set a **direction**, not
a frozen mechanism.

## Decision

**The conversation is first-class. We separate two concerns — by owner and by format:**

1. **History (product) — owned by the hub, in a neutral format.** The conversation (user↔agent turns)
   is **persisted by the hub as it streams in, from what it observes on the pipe** (`shared/`
   protocol, ADR 0003). **Neutral** (so multi-harness), **at the hub** (so independent of the PVC).
   It's what **every client displays**.
2. **Resume (runtime) — owned by the supervisor/runtime, in a native format.** Resuming the agent =
   its **native mechanism** (`--resume` on the JSONL for claude), **behind the runtime boundary**.
   **Harness-specific by nature**, and that's OK: it **never crosses over** to the product.

Conversation states: **`live`** (pipe ⟷ runtime) / **`dormant`** (hub history, no runtime).

> **Guiding principle — what we hold firm:** *product history must depend neither on a harness's
> format, nor on the availability of a runtime PVC.* The **how** above is the **working hypothesis**,
> to be tested (§ *To validate*) — not a dogma.

## Rationale

- **The hub already sees the conversation go by.** It's the very definition of the channel (`reply()`
  = how the agent talks to the human; the user message also transits through the hub). It **persists
  it as it streams in** — it **never needed** the JSONL for the history.
- **Two data sets, not a copy.** hub-history (neutral conversation) ≠ JSONL (native working context).
  Since these are **not** copies, **no divergence** — and it **corrects** the false "derive / don't
  duplicate" principle of the first intent (which claimed to avoid a duplication that doesn't exist).
- **Neutral ⇒ multi-harness; hub-owned ⇒ available.** Both flaws of the first intent fall away.
  Resilience bonus: PVC/JSONL lost ⇒ we **keep the conversation**, and we can **re-seed** a fresh
  runtime with it (to be tested, see below).
- **Native resume rather than "keeping the runtime alive".** Keeping N runtimes alive "just in case" =
  costly (RAM, creds — `agent-runtime` ADR 0006); the native resume mechanism is enough. Conversations
  stay **cheap** and **disposable**: *no pipe ≠ no conversation*.

## To validate (spike) — before carving the mechanism

We **test these unknowns against the real upstream** (fakechat + claude), and **adjust** the Decision
if needed:

- **What the channel really carries** — does `reply()` give **clean turns**? streaming / partials? the
  **tool-use / thinking**, or just the final text? → determines whether "the hub observes" is enough
  for a **faithful** history.
- **Completeness** — does the hub see **100%** of user-facing turns, or can claude emit off-channel?
- **`--resume` for real** — does it need the **exact JSONL / at the same path**? can a **fresh pod**
  resume a session whose JSONL is on the PVC? does it replay cleanly?
- **Hub down** — does the channel **buffer** the `reply()`s and **redeliver on reconnect**, or does it
  drop them? → history completeness across disconnects.
- **Re-seed** — feeding a fresh runtime the **neutral** history (the "PVC lost" resilience): viable /
  acceptable?

## Consequences

- **Two states** (`live` / `dormant`) presented in a single gesture (the claude.ai list).
- **The hub owns a conversation store** (neutral history) → **patches ADR 0004**: the hub's state is
  no longer "thin".
- **Identity mapping** to maintain: product conversation ⟷ **native resume session** (`--resume` id)
  ⟷ the pipe's `chat_id` when it's `live`.
- **The native side (JSONL) stays behind the runtime boundary**: isolated, **never exposed** to the
  product. A Claude format change affects only the **resume**, not the **history**.
- **Out of scope**: editing / forking a conversation; **importing** a claude session created outside
  agora (one-off JSONL parser, harness-specific).
- **Provisional status, owned**: the Decision holds the **principle**; the **mechanism** is confirmed /
  adjusted after the spike — same posture as "adopting a preview" (ADR 0002 / 0006).

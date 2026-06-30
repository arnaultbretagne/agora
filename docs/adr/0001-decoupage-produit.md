# ADR 0001 — Product split: a site that drives runtimes through channels

## Status

Proposed — 2026-06-30

## Context

The infra brick exists (`agent-runtime`): a **thin supervisor** that spawns **opaque processes** in a
pod, plus the image that carries them. It is **product-agnostic** — it knows nothing of
"conversations", "channels" or "claude" (`agent-runtime` ADR 0001-0002).

Now we need **the product**: what the human interacts with, and what gives these processes meaning.
Before writing a line, we nail down **the picture** — because there are two traps:

1. **Over-architecting.** We'd let a vocabulary of "foundation" and "3 layers" slip in: it sounded
   serious but it **masked** reality instead of describing it.
2. **Making the hub a runtime manager.** Tempting to say "the site drives the runtimes". But the site
   does not **carry** runtimes: it deals in **conversations** and their **pipe**. "runtime" is the
   **supervisor's** word, not the site's.

## Decision

The product is **a site that drives remote runtimes through pipes (channels)** — that is the
platform's *physical* truth. But **from the site's point of view, there are no "runtimes"**: the hub
sees **conversations** and their **pipe**.

> **1 conversation ⟷ 1 channel (pipe) ⟷ 1 runtime.** Same cardinality, **three names — depending on
> who's looking.** The hub looks through `(conversation, pipe)`; the supervisor looks through
> `runtime`.

Three roles, and above all each one's **projection**:

1. **The site (`website`) — the hub.** Its view is **`(conversation, pipe)`**. It aggregates N
   conversations and **routes** messages to each one's pipe. It **does not carry** runtimes: to
   *start / stop* a conversation it **drives the supervisor** (lifecycle); at **creation** it picks
   *which agent* (claude, codex tomorrow) — the **only** moment a "kind" surfaces, and it's a
   **conversation attribute**, not process management. The rest of the time: conversation ⟷ pipe.
2. **The runtimes — opaque, owned by the supervisor.** `claude` processes behind the pipes, in
   `agent-runtime`. **Invisible to the hub** except as "what's at the end of the pipe": their PIDs,
   their binary, their lifecycle = the supervisor's business (`agent-runtime` ADR 0001-0002), not the
   site's.
3. **The channels (pipes).** The pipe between a conversation and the site. It's Claude Code's
   **native** `channels` primitive: an MCP server over **stdio** that `claude` **spawns itself**,
   which relays over **WS** to the hub.

```
     the human
        │
        ▼
  ┌─ site (hub) ───────────┐                        ┌─ agent-runtime ────────────┐
  │  conv A ── pipe A  ◄════╪═══════ WS ═════════════╪══ runtime A (claude)        │
  │  conv B ── pipe B  ◄════╪═══════ WS ═════════════╪══ runtime B (claude)        │
  │        │                │                        │        ▲ spawn/kill         │
  │        ╰── lifecycle ───╪──── supervisor API ────╪──► supervisor ──────────────┘
  └─────────────────────────┘                        └────────────────────────────┘
     hub's view: (conversation ↔ pipe)         runtime = opaque, owned by the supervisor
```

Two planes: a **data plane** (the pipes, over WS, linking a conversation to its runtime) and a
**control plane** (the hub → the supervisor API, to open/close). **No layer on top**, no "engine", no
"foundation". A **topology**, not a **stack**.

## Rationale

- **The picture fits in one sentence** — at the platform level: *"a site that drives runtimes through
  pipes"*. But **the hub itself only manipulates `(conversation, pipe)`**; "runtime" is the
  supervisor's word. Repo rule: on the hub side, if a concept is neither a conversation nor a pipe, it
  must **earn** its place.
- **Why the `(conversation, pipe)` projection and not `(runtime)`.** The runtime is an **opaque
  process owned by the supervisor** (`agent-runtime` ADR 0002). The hub gains **nothing** by tracking
  PIDs or binaries; it gains **everything** by tracking **conversations** (the thing the human sees)
  and their **live pipe**. Bonus: it keeps the hub **runtime-agnostic** — codex is the same
  `(conversation, pipe)`, just another *kind* picked at creation.
- **A single control thread hub → supervisor, and it's the whole lifecycle.** *Someone* has to trigger
  the spawn, and the "new conversation" click originates in the site → the hub drives the supervisor.
  But it **delegates**: it says "open / close a conversation (of such a kind)", it does not **manage**
  the process.
- **The split follows the real deployment boundary**, not a taxonomy: the site in *its* pod; the
  runtime in its own; the channel co-located with the runtime (`stdio` constraint) but **product**
  code. Three roles = **three realities**, not three decreed tiers.
- **Why not "foundation / 3 layers".** It suggested a **stratification** — a founding layer, tiers —
  that doesn't exist. There's no bottom and no top: a hub, conversations, their pipes, and a
  supervisor you drive. Calling it a "stack" makes you look for a hierarchy you'd waste time
  maintaining.

## Consequences

- The `agora` repo carries **the site + the channel + the protocol**, and **nothing** of the infra
  (image / supervisor / auth / pod security = `agent-runtime`).
- **The hub keeps no "runtime registry": it keeps a conversation registry**, each with its pipe (and,
  *incidentally*, a backing process the supervisor owns). "Listing what's running" = listing
  **conversations with a live pipe**, not runtimes.
- The **product ↔ infra surface** boils down to **two contracts**, and that's deliberate:
  1. the **supervisor API** (`agent-runtime`) — *open / close* a conversation (and pick its *kind* at
     creation);
  2. the **channels** (WS) — convey the messages.
  All the rest of the product lives **on top** of these two contracts, without piercing them.
- The **only** place the runtime "kind" surfaces on the product side = **the choice of agent at the
  creation** of a conversation (claude / codex), carried as a **conversation attribute** — never as
  process management.
- Since the channel is co-located with the runtime **but is product**, it is delivered as a **plugin**
  (installed onto the PVC, outside the image) — detailed in **ADR 0003** (monorepo / artefacts).
- The following ADRs unfold each role: the **channel primitive** (0002), the **monorepo split**
  (0003), the **site = hub** (0004), the **conversation / history decoupling** (0005), and the
  **adopter-vs-builder** positioning (0006).

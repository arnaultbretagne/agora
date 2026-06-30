# ADR 0004 — Website = hub

## Status

Proposed — 2026-06-30

## Context

The site is the hub (ADR 0001); its view = `(conversation, pipe)`. We need to say **what it does**
concretely — without encroaching on the *what-is-a-conversation / a-history* (ADR 0005). Several entry
points are possible (browser first; iOS, Discord… later).

## Decision

**The website is the hub: it aggregates conversations, drives the supervisor, and routes messages
between clients and pipes.** Four functions, no more:

1. **Multi-conversation aggregation.** A view of all conversations (with a live pipe **or not**),
   claude.ai-style. It's *the* human entry point.
2. **Lifecycle (control plane).** Open / close a conversation = drive the **supervisor API** (and pick
   the *kind* at creation). The hub **does not manage** the process (ADR 0001).
3. **Routing (data plane).** Move messages **client ⟷ pipe**: from the client to the right channel
   (`chat_id`, ADR 0002), and the channel's `reply` to the right client. The hub **does not generate**
   agent content — it **relays** (the content originates in claude, via the channel).
4. **Multi-client / multi-stream.** The hub is **the façade**; clients (browser, tomorrow iOS/Discord)
   plug into it. A client **never** has a direct link to the runtime — **always** via the hub.

## Rationale

- **The hub is a router + an aggregator, not a brain.** All the intelligence is in the runtimes
  (claude). The hub **multiplexes**: N conversations, M clients, the right message to the right pipe.
  Keeping it "dumb" = keeping it **replaceable** and **runtime-agnostic** (consistent with ADR 0001).
- **Why the hub carries the lifecycle (and not a client).** The supervisor API is internal
  (pod-to-pod, behind `agent-runtime` ADR 0003's security boundary). Exposing it to clients =
  **piercing** the boundary. The hub is **the only** point that talks to the supervisor; clients talk
  to the **hub**. A single door.
- **Why multi-client from the design stage (even if browser first).** The `(conversation, pipe)`
  presumes **nothing** about the client. As long as the hub stays the WS façade, adding iOS/Discord =
  a **presentation** adapter, not a rework. We don't *build* all that now — we just forbid ourselves
  from **making it impossible**.
- **The hub is behind the OIDC gate.** Human access goes through oauth2-proxy (`infra-k8s` ADR 0021) →
  the hub assumes an **already-authenticated** user, and stays **single-user** (Terms, `agent-runtime`
  ADR 0005): no multi-tenant.

## Consequences

- The website exposes **two surfaces**: toward **clients** (WS + UI — the façade); toward the
  **infra** (supervisor API + the channels' WS). It's the **junction point** of ADR 0001's two
  contracts.
- **Routing needs a key**: the channel's `chat_id` ⟷ the conversation identity on the hub side. This
  mapping is the hub's **runtime state** (who's-plugged-where).
- **The hub is state-ful** — two states: (a) the **live** one, the table of conversations with a live
  pipe (who's-plugged-where); (b) the conversation's **history**, which it **owns** in a **neutral
  format** (ADR 0005 — so as to depend neither on a harness format nor on a runtime's PVC). So it's
  **not** "thin", but it stays **free of agent logic** (next point).
- **No agent logic in the hub**: no prompt, no tools, no memory. If we're tempted to add some, it
  belongs to the **runtime** or the **channel**.
- Details (server tech, UI shape, exact WS protocol) = implementation + `shared/` (ADR 0003), not
  here.

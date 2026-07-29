# ADR 0008 — Durable Agent anchors and delta handoffs

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

A Workstream may move from Agent A to Agent B and back. Each Agent's native context stops at a
different Workstream point. Full reseeding wastes context and can duplicate product history; native
resume alone misses work performed by the other Agent.

## Decision

Each `(workstream_id, agent_id)` has at most one durable Anchor referencing a Session, committed
custody snapshot and Workstream watermark.

When an Agent is activated, Agora restores its anchored Session when possible and sends only the
missing Workstream range as a standard ACP Handoff prompt. The seed policy and source range are
durably recorded.

An Anchor advances only after custody capture succeeds.
It never contains OneCLI Agent IDs, proxy authority or grant state; resume activates fresh
Session-bound authority before restoring the anchored context.

## Alternatives rejected

- **Full history seed on every switch:** wastes context and obscures synchronization.
- **Anchor only by ACP Session ID:** does not prove durable native state exists.
- **One shared neutral Session across Agents:** ACP Sessions are Agent-owned contexts.
- **Copy source messages into the target timeline:** duplicates the Workstream representation.
- **Use gateway state as an Anchor:** credential lifecycle proves neither native context durability
  nor a Workstream watermark.

## Consequences

- Handoff is a first-class, inspectable prompt turn.
- Seedability is versioned separately from storage and UI visibility.
- A capture failure leaves the old Anchor, allowing deterministic replay of the delta.
- Permanent resume failure creates a new Session and a larger handoff.
- Cross-Agent switches never share OneCLI Agents or their upstream proxy bearers.

## Governing specs

- [Anchors and handoffs](../specs/06-anchors-and-handoffs.md)

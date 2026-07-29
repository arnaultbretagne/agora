# ADR 0004 — Canonical ACP journal and rebuildable projections

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Storing only flattened user/assistant text hides thoughts, tool calls, plans and permissions.
Separately storing a “conversation”, ACP representation and custody would create three competing
views of the same logical activity.

Streaming updates are not naturally the same shape as an efficient Web read model.

## Decision

Every complete ACP envelope observed for a Session is appended once to a Workstream-ordered Postgres
journal. Minimal indexed metadata is stored beside the untouched envelope.

Messages, thoughts, tool calls, plans, permission interactions and Web feed entries are disposable
projections from that journal. Rendering may collapse content but persistence does not hide it.

Custody remains separate because it is opaque resume state, not product meaning.
OneCLI request/audit records and gateway logs remain operational security telemetry and are never
copied into the Workstream journal.

## Alternatives rejected

- **Messages table as truth:** cannot losslessly represent ACP updates.
- **Harness transcript as truth:** harness-specific, unavailable across Agents and unsuitable for
  product ordering.
- **Store only a normalized event model:** discards new/unknown ACP fields.
- **Build the UI directly from raw rows on every request:** preserves truth but produces expensive,
  fragile query-time assembly.
- **Use OneCLI request logs as Agent history:** records network enforcement rather than ACP meaning
  and would create a second, incomplete transcript.

## Consequences

- A projector and rebuild tooling are required.
- Workstream sequence allocation is transactional.
- Journal notification and Web feed positions remain separate mechanisms.
- ACP v1 missing message IDs require explicit projection fallback.
- Projection equivalence becomes an acceptance gate.
- Product projections remain independent from OneCLI retention, schema and availability.

## Governing specs

- [Journal and projections](../specs/05-journal-and-projections.md)

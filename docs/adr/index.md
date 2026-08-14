# Architecture Decision Record index

This is the only active ADR index for Agora.

ADRs record decisions and rationale. Current behavior is specified under `docs/specs/`.
Documents under `parked/` are retained for comparison and do not govern the active design.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-unified-repository.md) | Accepted | One Agora monorepo, separate trust-zone deployables |
| [0002](0002-workstream-session-model.md) | Accepted | Intent, Observation, Session and Workstream are distinct temporal concepts |
| [0003](0003-reconciliation-over-state.md) | Accepted | Complete Intent is realized through Workstream-scoped reconciliation over fresh Observation |
| [0004](0004-acp-boundary-and-session-facts.md) | Accepted | ACP is the harness boundary; complete envelopes are Session facts; readable models are projections |
| [0005](0005-postgresql-durable-store.md) | Accepted | PostgreSQL is Agora's durable store, with distinct authority for facts, projections and opaque Saves |
| [0006](0006-complete-harness-images.md) | Accepted | Every harness image contains the complete tool bundle, while its execution remains hostile |
| [0007](0007-kubernetes-runtime.md) | Accepted | Kubernetes is the sole execution runtime without becoming a domain identity |
| [0008](0008-saves-anchors-and-refill.md) | Accepted | Controlled shutdown Saves native context; Anchors, resume and refill continue it in later Sessions |
| [0009](0009-onecli-grant-authority.md) | Accepted | OneCLI is the only external grant authority and credential gateway |
| [0010](0010-capabilities-are-onecli-grants.md) | Accepted | Flat capabilities compile only to exact OneCLI grants |

## Parked records

Earlier ADR texts are retained under [`parked/`](parked/README.md). They are historical input, not
active decisions. The active vocabulary is defined by ADR 0002; the glossary and normative specs
will be aligned after this ADR set is reviewed.

## Status policy

- `Proposed`: requires operator review before dependent implementation begins.
- `Accepted`: binding for implementation.
- `Superseded`: retained only if a later ADR replaces it.

Coding agents MUST NOT implement a plan depending on a Proposed ADR until it is accepted or the plan
explicitly limits itself to a reversible spike.

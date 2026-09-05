# Reconciliation specification

This is the current normative specification for Agora's new architecture, alongside the accepted
[ADRs](../../adr/index.md). The repository is in design phase. Retired specifications, schemas,
implementation plans and code live in Git history and provide no alternative contract.

## Registries

Read the common vocabulary before the rules:

- [000 — Taxonomy and evaluation](000_taxonomy.md)
- [001 — Complete Intent and capability compilation](001_intent.md)
- [002 — Observation and exact grant comparison](002_observation.md)
- [003 — Action verbs and their recovery obligations](003_verbs.md)

## Ordered rules

1. [004 — POWER](004_power.md)
2. [005 — CONSTRUCTION](005_construction.md)
3. [006 — CAPABILITIES](006_capabilities.md)
4. [007 — SESSION](007_session.md)
5. [008 — CONFIG](008_config.md)
6. [009 — SYNC](009_sync.md)
7. [010 — CONVERGE](010_converge.md)

Each rule file contains one mutually exclusive, exhaustive table with exactly
`Rule | Conditions | Result`. A table selects an objective; its verb owns safe execution and recovery.
Every tick restarts at POWER with current owner evidence. Acquisition, ownership and backoff are
engine control, outside the domain tables.

## Supporting contracts

| Contract | Scope |
|---|---|
| [Engine](engine.md) | Intent ordering, claims, effects, command ambiguity, watches, scheduling and conditional finalization |
| [Execution](execution.md) | Service authority, Session birth/admission, hot boundaries, ACP evidence, isolation, extinction and integration conformance |
| [Continuity](continuity.md) | Save/Anchor invariants, opening range, workspace consistency, seed policy, native proof and storage |
| [Acceptance](acceptance.md) | Stable design scenarios and the evidence required from implementation |

Authority precedes bootstrap that requires it; config precedes the effectful opening Handoff.
User work additionally waits for synchronization. Neither a completed action nor a persisted
Session fact substitutes for current owner evidence.

## Implementation prerequisites

This corpus defines behavior without preserving the retired API, SQL or package layout. Introduce
machine-readable contracts and implementation incrementally for a specified behavior and its
acceptance scenarios. Concrete grant mappings, wire/storage schemas, seed fidelity, custody/workspace
mechanisms, freshness/deadline values and physical fencing still require explicit definitions and
pinned integration evidence. Documentation alone certifies none of them.

Intent currently contains power, harness, capabilities, model, effort and frozen default persona.
Skills and selectable personas require a further decision and taxonomy change. Product UI/API,
retention values and any existing-data migration need their own scoped decisions when required;
the removed documents must not supply implicit defaults.

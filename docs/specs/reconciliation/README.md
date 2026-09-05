# Reconciliation specification

This directory defines the ordered decision model for a Workstream's complete Intent. Read the
common registries before the rules; file prefixes order rule evaluation, while rule ids stay stable.

## Registries

- [000 — Taxonomy and evaluation](000_taxonomy.md)
- [001 — Intent](001_intent.md)
- [002 — Observation](002_observation.md)
- [003 — Action verbs](003_verbs.md)

## Ordered rules

1. [004 — POWER](004_power.md)
2. [005 — CONSTRUCTION](005_construction.md)
3. [006 — CAPABILITIES](006_capabilities.md)
4. [007 — SESSION](007_session.md)
5. [008 — CONFIG](008_config.md)
6. [009 — SYNC](009_sync.md)
7. [010 — CONVERGE](010_converge.md)

Each rule file contains one mutually exclusive, exhaustive table with exactly
`Rule | Conditions | Result`. A table selects an objective; its verb contract owns safe execution
and recovery. Every tick restarts at POWER with current owner evidence.

## Cross-cutting contracts

- [Engine: claims, effects, retries, watches and finalization](engine.md)
- [Session boundaries and admission](../03-session-lifecycle.md)
- [ACP integration and current evidence](../04-acp-integration.md)
- [Anchors, refill and native continuity](../06-anchors-and-handoffs.md)
- [Saves and custody](../07-custody.md)
- [Kubernetes runtime control and extinction](../08-session-runtime-control.md)
- [Harness registry and conformance](../09-agent-registry.md)
- [Exact capabilities and OneCLI grants](../10-equipment-and-broker.md)
- [Security](../11-security.md)
- [Failure and idempotency](../13-failure-and-idempotency.md)
- [Acceptance scenarios](../15-acceptance-and-migration.md)

Authority precedes bootstrap that requires it; config precedes the effectful opening Handoff.
User work additionally waits for synchronization. Claims, observation acquisition and backoff are
engine control flow, outside the domain tables.

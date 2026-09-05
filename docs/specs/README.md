# Normative specifications

These documents define the target system. The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD
NOT**, and **MAY** are normative. ADRs record decisions and rationale; specifications define their
contracts. Scenario descriptions are acceptance obligations, not evidence of executed tests.

## Remodeling authority and reading order

Follow [docs/AGENTS.md](../AGENTS.md). Begin with the accepted ADRs
[0002](../adr/0002-workstream-session-model.md) and
[0003](../adr/0003-reconciliation-over-state.md), then the
[reconciliation index](reconciliation/README.md) and [taxonomy](reconciliation/000_taxonomy.md).
Read the remaining ADRs and complete specifications routed by the topic.

The following specifications are aligned to the current remodeling decisions:

1. [Reconciliation registries and ordered rules](reconciliation/README.md)
2. [Engine: ownership, scheduling and recovery](reconciliation/engine.md)
3. [Session boundaries and admission](03-session-lifecycle.md)
4. [ACP integration and current evidence](04-acp-integration.md)
5. [Anchors, refill and native continuity](06-anchors-and-handoffs.md)
6. [Saves and custody](07-custody.md)
7. [Kubernetes runtime control](08-session-runtime-control.md)
8. [Harness registry and conformance](09-agent-registry.md)
9. [Capabilities and OneCLI](10-equipment-and-broker.md)
10. [Security and extinction](11-security.md)
11. [Failure model and idempotency](13-failure-and-idempotency.md)
12. [Acceptance and migration](15-acceptance-and-migration.md)

The design revision creates the cross-cutting engine specification and amends existing domain
specifications/ADRs. It adds no Runtime/Run/Agent product identity, no second journal and no second
authority for OneCLI grants. Numerical rule filenames reflect evaluation order; stable rule IDs
remain the reference for scenarios and future implementation.

## Documents still requiring alignment

The [glossary](00-glossary.md), [system architecture](01-system-architecture.md),
[domain model](02-domain-model.md), [journal/projection specification](05-journal-and-projections.md),
[observability](12-observability.md) and [product API/feed](14-product-api-and-feed.md) retain material
from the previous model. They must not override the accepted ADRs or aligned contracts. Their
remaining vocabulary, schema and API work must be made explicit before dependent implementation.

Machine-readable files under `contracts/` still require alignment, including Session/Workstream
facts, runtime-control operations, Save metadata and seed rendering. This documentation-only
revision neither reads implementation code nor validates existing wire/storage schemas or adapters.
If prose and a machine-readable contract conflict, repair that baseline before implementation;
never silently select the pre-remodel contract as an alternative architecture.

## Implementation evidence

Spec 15 collects the authority, admission, continuity, extinction and engine race scenarios. Enabling
a pinned harness/OneCLI integration requires demonstrated readback, unknown-delivery recovery,
isolation and fencing. Runtime deadlines, source freshness bounds, seed fidelity and workspace
compatibility must be concretely pinned. Those are implementation prerequisites, not unspecified
domain decisions for a worker to invent while reconciling.

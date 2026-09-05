# Normative specifications

These documents define the target system. The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD
NOT**, and **MAY** are normative.

ADRs explain why the decisions were made. Machine-readable files under `contracts/` define wire and
storage shapes. If prose and a machine-readable contract conflict, implementation must stop until
the baseline is corrected; agents must not pick one silently.

## Remodeling authority

Follow [docs/AGENTS.md](../AGENTS.md) first. Accepted ADRs and the reconciliation specification
govern the remodeling baseline. Specs 03, 04, 06–11, 13 and 15 have been realigned; other flat specs still
require explicit alignment where they conflict. This revision does not validate existing schemas
or implementation. Such conflicts must be repaired before dependent implementation.

## Reading order

1. [Glossary](00-glossary.md)
2. [System architecture](01-system-architecture.md)
3. [Domain model](02-domain-model.md)
4. [Reconciliation](reconciliation/README.md)
5. [Session boundaries and admission](03-session-lifecycle.md)
6. [ACP integration](04-acp-integration.md)
7. [Journal and projections](05-journal-and-projections.md)
8. [Anchors, refill and native continuity](06-anchors-and-handoffs.md)
9. [Saves and custody](07-custody.md)
10. [Kubernetes runtime control](08-session-runtime-control.md)
11. [Harness registry and conformance](09-agent-registry.md)
12. [Capabilities and OneCLI](10-equipment-and-broker.md)
13. [Security](11-security.md)
14. [Observability](12-observability.md)
15. [Failure model and idempotency](13-failure-and-idempotency.md)
16. [Product API and feed](14-product-api-and-feed.md)
17. [Acceptance and migration](15-acceptance-and-migration.md)

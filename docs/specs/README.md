# Normative specifications

These documents define the target system. The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD
NOT**, and **MAY** are normative.

ADRs explain why the decisions were made. Machine-readable files under `contracts/` define wire and
storage shapes. If prose and a machine-readable contract conflict, implementation must stop until
the baseline is corrected; agents must not pick one silently.

## Reading order

1. [Glossary](00-glossary.md)
2. [System architecture](01-system-architecture.md)
3. [Domain model](02-domain-model.md)
4. [Session lifecycle](03-session-lifecycle.md)
5. [ACP integration](04-acp-integration.md)
6. [Journal and projections](05-journal-and-projections.md)
7. [Anchors and handoffs](06-anchors-and-handoffs.md)
8. [Custody](07-custody.md)
9. [Loge control](08-loge-control.md)
10. [Agent registry](09-agent-registry.md)
11. [Equipment and Broker](10-equipment-and-broker.md)
12. [Security](11-security.md)
13. [Observability](12-observability.md)
14. [Failure model and idempotency](13-failure-and-idempotency.md)
15. [Product API and feed](14-product-api-and-feed.md)
16. [Acceptance and migration](15-acceptance-and-migration.md)

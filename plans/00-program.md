# P00 — Delivery program

## Goal

Deliver the new Agora as contract-first vertical slices without reintroducing the retired model or
creating a second source of truth.

## Baseline gate

Before P01:

- operator reviews every spec;
- ADR 0006, ADR 0010 and ADR 0014 are accepted, amended or explicitly deferred;
- open questions are resolved in specs/contracts;
- `npm test` validates links, YAML, JSON and JSON Schemas;
- this plan manifest is updated to unblock P01.

## Global engineering rules

- Use strict TypeScript and Node.js 22.
- Use stable ACP v1 from the pinned official SDK.
- Keep packages dependency-directed:

```text
domain <- stores/adapters <- application services <- deployables
```

- No deployable imports another deployable.
- Generate bindings from contracts where practical.
- Use real Postgres for repository tests.
- Use fake ACP Agents for deterministic protocol tests.
- Use a real Kubernetes test namespace for controller acceptance.
- All external commands are idempotency-tested.
- Every failure path has a typed public/internal code.

## Integration strategy

Each plan lands a runnable thin slice. Feature flags may select v2 at deployment boundaries but code
does not dual-write old and new domain models.

Agents working in parallel own disjoint packages/contracts. Changes to shared contracts are reviewed
before dependent branches rebase.

## Mandatory test layers

1. Pure domain invariant tests.
2. Contract fixtures/schema validation.
3. Postgres integration/constraint tests.
4. ACP Client/fake-Agent protocol tests.
5. Controller reconciliation tests.
6. Broker authorization tests.
7. End-to-end production-like scenarios.
8. Fault injection at durable/external boundaries.

## Evidence

Every completed plan adds to its file:

- commit/PR link;
- exact test commands;
- acceptance output summary;
- remaining operational risk;
- follow-up plan IDs.

## Program exit

P11 may recommend go-live only when every scenario in
`docs/specs/15-acceptance-and-migration.md` passes and there is an explicit legacy-data decision.

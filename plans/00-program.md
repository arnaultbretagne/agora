# P00 — Delivery program

## Goal

Deliver the new Agora as contract-first vertical slices without reintroducing the retired model or
creating a second source of truth or credential gateway.

## Baseline gate — satisfied 2026-07-29

Before P01:

- [x] operator reviewed the consolidated baseline;
- [x] ADR 0006, ADR 0010 and ADR 0014 are accepted;
- [x] the OneCLI spike fixed the credential-gateway direction;
- [x] current open questions are encoded as implementation/acceptance gates;
- [x] `npm test` validates links, YAML, JSON and JSON Schemas;
- [x] the plan manifest unblocks P01.

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
- Use OneCLI as the only credential-injection/MITM gateway.
- Keep the OneCLI organization key, provider credentials and upstream Agent bearer out of Loges.
- Treat OneCLI rule publication, Agent lifecycle and relay activation as fail-closed external side
  effects.
- Bake pinned Claude/Codex and ACP adapters into Agent images; never install them at Pod startup.

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
7. OneCLI policy, workload-relay, revocation and secret-leak tests.
8. End-to-end production-like scenarios.
9. Fault injection at durable/external boundaries.

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

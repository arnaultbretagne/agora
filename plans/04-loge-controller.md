# P04 — Loge controller and trusted Agent registry

- **Status:** pending; blocked until ADR 0006 is accepted
- **Dependencies:** P01
- **Primary paths:** `apps/loge-controller`, `packages/runtime-control`, `packages/agent-registry`

## Required reading

- `docs/specs/08-loge-control.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- ADR 0001, 0005, 0006, 0011

## Reuse audit

Inspect the old `agent-runtime` repository but port behavior selectively:

- candidate reuse: Kubernetes client primitives, Pod security settings, tested shutdown logic;
- do not port: group, runLocations, shared substrate, raw spawn args/env, transcript endpoints,
  profiles, equipment-based Loge replacement.

Record provenance for every reused module.

## Deliverables

- Internal server conforming to `loge-control.yaml`.
- Registry loader/validator using `agent-runtime.schema.json`.
- Controller-authoritative safe Agent/version selection projection.
- Deterministic PodSpec builder.
- Kubernetes reconciliation keyed by Session ID.
- At-most-one-Pod enforcement.
- Authenticated ACP bridge endpoint lifecycle.
- Fake Agent runtime image/definition for tests.

## Tasks

- [ ] Validate all requests before Kubernetes access.
- [ ] Resolve only enabled, exact registry definitions.
- [ ] Expose public metadata/exact selected version without image, command or custody paths.
- [ ] Build Pods from immutable templates and safe references.
- [ ] Create one Session-specific workload identity and bind the grant before Pod readiness.
- [ ] Add required labels and prohibit user-provided Kubernetes fragments.
- [ ] Reconcile state from Kubernetes after controller restart.
- [ ] Make materialize/delete idempotent.
- [ ] Detect and fail closed on duplicate Pods.
- [ ] Keep status reads credential-free and mint connections through the dedicated endpoint.
- [ ] Bind bridge credential to one Session, request ID, single use and short expiry.
- [ ] Revoke bridge/grant during dematerialization.
- [ ] Publish safe status and telemetry.

## Required tests

- Arbitrary image/command/env fields are schema-rejected.
- Concurrent `PUT` creates one Pod.
- Restart with existing Pod returns the same logical Loge.
- Duplicate-Pod injection triggers fail-closed reconciliation.
- Pod has no API token and uses required security context.
- Session A cannot connect using Session B bridge credential.
- `DELETE` absent Loge succeeds.

## Non-goals

- No real Claude/Codex integration.
- No custody capture until P06.
- No capability-policy implementation; use a fake signed grant.

## Exit criteria

- Fake Agent Loge reaches ACP-ready state in a test namespace.
- Controller has no in-memory-only authority.
- P06 can add custody without changing the public lifecycle model.

## Evidence

To be completed by the implementing agent.

# P04 — Session Runtime controller, trusted Agent images and credential-free runtime seam

- **Status:** pending
- **Dependencies:** P01
- **Primary paths:** `apps/session-runtime-controller`, `packages/session-runtime-control`, `packages/agent-registry`

## Required reading

- `docs/specs/08-session-runtime-control.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- ADR 0001, 0005, 0006, 0010, 0011, 0014

## Reuse audit

Inspect the old `agent-runtime` repository but port behavior selectively:

- candidate reuse: Kubernetes client primitives, Pod security settings, tested shutdown logic;
- do not port: group, runLocations, shared substrate, raw spawn args/env, transcript endpoints,
  profiles, equipment-based runtime replacement.

Record provenance for every reused module.

## Deliverables

- Internal server conforming to `session-runtime-control.yaml`.
- Registry loader/validator using `agent-runtime.schema.json`.
- Controller-authoritative safe Agent/version selection projection.
- Deterministic PodSpec builder.
- Fixed credential-free runtime bundle seam for OneCLI CA/stubs and Broker relay endpoint.
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
- [ ] Route Agent egress only to the workload-authenticated Broker relay; prohibit direct OneCLI
  gateway/control API and Internet access.
- [ ] Mount only the operator-managed OneCLI CA and non-secret harness auth stubs; never accept them
  from the materialize request.
- [ ] Verify the pinned image already contains the declared harness and ACP adapter versions.
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
- Restart with an existing Pod reconstructs the same Session Runtime state by `session_id`.
- Duplicate-Pod injection triggers fail-closed reconciliation.
- Pod has no API token and uses required security context.
- Pod environment/files contain no OneCLI organization key, upstream `aoc_` bearer or provider
  credential.
- NetworkPolicy denies direct provider and OneCLI gateway access while the fake relay remains
  reachable.
- Session A cannot connect using Session B bridge credential.
- `DELETE` for a non-materialized Session Runtime succeeds.

## Non-goals

- No real Claude/Codex integration.
- No custody capture until P06.
- No live OneCLI or capability-policy implementation; use a fake activation/relay contract for P08.
- No runtime `npm install`/binary download.

## Exit criteria

- A fake Agent reaches ACP readiness inside a materialized Session Runtime in a test namespace.
- Controller has no in-memory-only authority.
- P08 can replace the fake activation/relay without changing Session Runtime lifecycle or accepting
  secret environment values.
- P06 can add custody without changing the public lifecycle model.

## Evidence

To be completed by the implementing agent.

# P06 — Opaque custody, suspension and ACP resume

- **Status:** pending
- **Dependencies:** P02, P03, P04
- **Primary paths:** `packages/custody`, `apps/loge-controller`, `apps/control-plane`, fake Agent

## Required reading

- `docs/specs/03-session-lifecycle.md`
- `docs/specs/07-custody.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0005, 0007, 0009

## Deliverables

- Custody-driver interface and deterministic fake driver.
- Controller capture endpoint and restore-before-start flow.
- Restricted Postgres payload repository.
- Product suspension orchestration with capture/Anchor/delete ordering.
- Rematerialization plus ACP `session/resume`.
- Snapshot retention/reconciliation job.

## Tasks

- [ ] Implement streaming capture with size/time limits and SHA-256.
- [ ] Commit immutable snapshot generation atomically.
- [ ] Return the same snapshot for a repeated Session/capture-request ID.
- [ ] Implement format/version compatibility validation.
- [ ] Restore before Agent readiness and reject collisions/checksum mismatch.
- [ ] Keep capture and Pod deletion separate.
- [ ] Commit Anchor only after successful snapshot.
- [ ] Resume with ACP `session/resume`, not `session/load`.
- [ ] Tag any explicit load replay and prevent duplicate projection meaning.
- [ ] Implement permanent resume failure -> failed old Session + explicit new-Session command.
- [ ] Implement retention without deleting anchored snapshots.
- [ ] Add custody payload read audit and secret-path exclusions.
- [ ] Exclude OneCLI auth stubs, proxy configuration, upstream Agent bearer and provider-auth paths
  from every custody driver.
- [ ] Obtain and activate a current execution grant before restore; never revive authority from the
  snapshot.

## Required tests

- Suspend/capture/delete/restore/resume same ACP context.
- Capture failure leaves Pod alive and Anchor unchanged.
- A capture retry cannot allocate two generations for one request ID.
- Crash after snapshot before Anchor leaves safe unreferenced snapshot.
- Crash after Anchor before delete is reconciled.
- Corrupt checksum/format mismatch prevents ready.
- Control-plane DB role cannot read payload.
- No credential fixture appears in captured bytes.
- `session/load` replay cannot duplicate Workstream items.
- Pod replacement rotates/rebinds runtime authority while resuming the same ACP Session and custody.

## Non-goals

- No real Claude/Codex native format.
- No cross-Agent delta yet.
- No object storage.
- No persistence of OneCLI runtime configuration in custody.

## Exit criteria

- Fake Agent survives physical Pod replacement as the same Session.
- All capture/delete crash boundaries are fault-injection tested.
- P07 can rely on a truthful durable Anchor.

## Evidence

To be completed by the implementing agent.

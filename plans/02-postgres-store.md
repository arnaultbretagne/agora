# P02 — Postgres canonical store and projector substrate

- **Status:** pending
- **Dependencies:** P01
- **Primary paths:** `packages/store-pg`, `packages/custody`, `contracts/database`

## Required reading

- `docs/specs/02-domain-model.md`
- `docs/specs/05-journal-and-projections.md`
- `docs/specs/07-custody.md`
- ADR 0004, 0007, 0009

## Deliverables

- Ordered migration runner for the database contracts.
- Transactional Workstream/Session/Command repositories.
- Atomic dual sequence allocator and journal append.
- Transactional journal outbox.
- Per-Workstream projection checkpoint and durable feed-position substrate.
- Custody metadata repository separated from runtime payload repository.
- Real-role integration tests.

## Tasks

- [ ] Run migrations on disposable real PostgreSQL in tests.
- [ ] Implement Workstream creation atomically with initial Session.
- [ ] Persist creator membership, immutable equipment request and bound policy digest.
- [ ] Implement partial-current Session transition.
- [ ] Bind ACP Session ID once with conflict detection.
- [ ] Create/reuse durable commands by scoped idempotency key.
- [ ] Append event + increment both heads + journal outbox in one transaction.
- [ ] Reject Session/Workstream ownership mismatch in repository and SQL.
- [ ] Implement per-Workstream projection checkpoint and feed-event transactions.
- [ ] Implement rebuild/reset without reusing or decreasing feed positions.
- [ ] Implement snapshot insert/stream/read and retention queries.
- [ ] Implement atomic Anchor upsert validating snapshot metadata/watermark.
- [ ] Prove control-plane credentials cannot read custody payload.
- [ ] Prove no `SessionRuntime` table, `runtime_id` or persisted live Pod status exists.
- [ ] Prove product/projection/custody schemas contain no OneCLI Agent row, upstream proxy bearer,
  provider credential or OneCLI request log.

## Required tests

- Concurrent append yields gap-free unique Workstream and Session positions.
- Concurrent current-Session switch leaves exactly one current.
- Last owner cannot be removed and immutable launch/equipment columns cannot be updated by the
  application role.
- ACP binding cannot be overwritten.
- Duplicate command does not duplicate event or side effect intent.
- Anchor watermark cannot decrease or mismatch snapshot.
- Projection rebuild produces identical hashes.
- Transaction rollback leaves no event/journal-outbox split.
- Concurrent Workstreams cannot cause a projector checkpoint to skip committed events.
- Database role tests execute actual denied SQL.
- Repository types expose durable Session phase but cannot persist live Session Runtime status.
- Gateway/grant secret-pattern fixtures cannot be persisted in product grant, command or
  non-envelope journal metadata fields; canonical ACP content retains its separate confidentiality
  rules.

## Non-goals

- No ACP dispatch.
- No Web API.
- No Kubernetes.
- No external object store.
- No OneCLI operational database schema or migration; OneCLI owns and migrates that database.

## Exit criteria

- All SQL constraints are exercised by a failing test.
- Backup/restore smoke test covers all three Agora schemas independently from the later OneCLI
  recovery set.
- P03 can consume a durable command/journal interface without raw SQL.

## Evidence

To be completed by the implementing agent.

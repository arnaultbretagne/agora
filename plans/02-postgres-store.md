# P02 — Postgres canonical store and projector substrate

- **Status:** complete
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

- [x] Run migrations on disposable real PostgreSQL in tests.
- [x] Implement Workstream creation atomically with initial Session.
- [x] Persist creator membership, immutable equipment request and bound policy digest.
- [x] Implement partial-current Session transition.
- [x] Bind ACP Session ID once with conflict detection.
- [x] Create/reuse durable commands by scoped idempotency key.
- [x] Append event + increment both heads + journal outbox in one transaction.
- [x] Reject Session/Workstream ownership mismatch in repository and SQL.
- [x] Implement per-Workstream projection checkpoint and feed-event transactions.
- [x] Prove typed-projection constraints with failing SQL: hot item kinds reject an inline
  `current_value`, cold kinds require one, satellites bind by `(item, kind)` composite keys, and a
  turn cannot be referenced across Sessions.
- [x] Implement rebuild/reset without reusing or decreasing feed positions.
- [x] Implement snapshot insert/stream/read and retention queries.
- [x] Implement atomic Anchor upsert validating snapshot metadata/watermark.
- [x] Prove control-plane credentials cannot read custody payload.
- [x] Prove no `SessionRuntime` table, `runtime_id` or persisted live Pod status exists.
- [x] Prove product/projection/custody schemas contain no OneCLI Agent row, upstream proxy bearer,
  provider credential or OneCLI request log.

## Required tests

- [x] Concurrent append yields gap-free unique Workstream and Session positions.
- [x] Concurrent current-Session switch leaves exactly one current.
- [x] Last owner cannot be removed and immutable launch/equipment columns cannot be updated by the
  application role.
- [x] ACP binding cannot be overwritten.
- [x] Duplicate command does not duplicate event or side effect intent.
- [x] Anchor watermark cannot decrease or mismatch snapshot.
- [x] Projection rebuild produces identical hashes.
- [x] Transaction rollback leaves no event/journal-outbox split.
- [x] Concurrent Workstreams cannot cause a projector checkpoint to skip committed events.
- [x] Typed satellite and turn constraints reject kind mismatches, cross-Session turn references and
  inline values on hot kinds through actual failing SQL.
- [x] Database role tests execute actual denied SQL.
- [x] Repository types expose durable Session phase but cannot persist live Session Runtime status.
- [x] Gateway/grant secret-pattern fixtures cannot be persisted in product grant, command or
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

- Commit: on branch `refactoring`, local at completion time (not yet pushed — see the branch's own
  history for the exact hash; push happens after operator review, same rhythm as P01's `f4ff2cc`).
- Packages delivered: `packages/store-pg` (`src/db.ts`, `migrate.ts`, `workstreams.ts`, `sessions.ts`,
  `commands.ts`, `journal.ts`, `projections.ts`, `anchors.ts`, `secret-guard.ts`) and
  `packages/custody` (`src/metadata.ts`, `payload.ts`), each with `build`/`typecheck`/`test` npm
  scripts. `pg`/`@types/pg` added as workspace dependencies; `pg.types.setTypeParser(20, Number)`
  set once in `db.ts` (bigint sequence/position columns come back as JS strings by default —
  this bit a first draft of the journal append test as silent string concatenation, not a thrown
  error, so it's called out explicitly here).
- Every repository/test file connects to a **real, disposable Postgres 17** (docker
  `postgres:17-alpine`, matching CI's service container exactly) via
  `packages/store-pg/test/support.ts` / `packages/custody/test/support.ts`: each test file creates
  its own uniquely-named database, runs the real `migrate()` runner against it, and drops it after
  (`WITH (FORCE)`). No mocking of Postgres anywhere, per P00's standing rule.
- `.github/workflows/ci.yml` updated: the `npm test` step now sets `TEST_DATABASE_URL` pointing at
  the already-running postgres service, so store-pg/custody's own migration runner can bootstrap
  their disposable test databases. The pre-existing "Apply database contracts" `psql` step (against
  `agora_contracts`) is untouched and still runs as an independent smoke test.
- Exact command: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm test`
  (root). Result: the 4 P01 static checks pass, then `@agora/custody` 5/5, `@agora/domain` 31/31,
  `@agora/session-runtime-control` 7/7, `@agora/store-pg` 36/36 — 79 tests total, all real
  (no skips). All required tests from this plan are implemented and passing (see checklists above);
  several needed more than one attempt — see "Bugs this caught" below.
- **Bugs this caught** (kept as a record, not just "tests pass"):
  1. `setCurrentSession` raced under real concurrency: two concurrent switches could both pass their
     own "clear previous current" step before either committed, then both set their own target
     current, tripping the `sessions_one_current_per_workstream` unique index as a thrown error
     instead of resolving to one winner. Fixed by locking the Workstream row first (`SELECT ... FOR
     UPDATE`), the same pattern `journal.ts`'s `appendEvent` already used for the dual sequence
     allocator. Caught by the required concurrent-switch test, not by inspection.
  2. bigint columns (`last_event_seq`, `workstream_seq`, `session_seq`, ...) come back from `pg` as
     JS strings by default; `row.last_event_seq + 1` silently string-concatenated
     (`'0' + 1 → '01'`) instead of throwing. Only surfaced because the concurrent-append test
     asserted exact numeric sequences instead of just "no error". Fixed with a single global
     `pg.types.setTypeParser(20, Number)` in `db.ts` rather than scattering `Number(...)` at every
     call site (already missed once even by the author, in `projections.ts`).
  3. `transitionCommandState`'s SQL reused the same placeholder (`$2`/`$3`) once in a plain
     assignment and once inside a `CASE ... IN (...)` branch — Postgres genuinely rejected this
     with `inconsistent types deduced for parameter` (42P08); fixed by computing `completedAt` in
     JS and binding it as its own parameter.
  4. First test-support draft used one fixed database name shared across all test files; Node's
     test runner runs separate files concurrently, so `CREATE DATABASE`/`DROP DATABASE ... WITH
     (FORCE)` from sibling files raced (`pg_database_datname_index` unique violation, and
     `terminating connection due to administrator command` from a sibling's forced drop). Fixed by
     giving every `withTestDatabase()` call its own `crypto.randomUUID()`-suffixed database.
  5. First concurrency test deadlocked (`pool.connect()` for N>pg's default max=10 clients before
     releasing any) — fixed by raising the test pool's `max`.
- Operational note: this dev sandbox's Docker daemon needed a manual `sudo systemctl start docker`
  and the `dev` user isn't in the `docker` group, so all container commands here ran via `sudo
  docker`. `/srv/agora/.git/objects` also had several root-owned, non-group-writable subdirectories
  (left by a prior root-run session, e.g. codex) that blocked even a local `git add`; fixed with a
  narrowly-scoped `sudo chmod g+w` on exactly those directories (see P01's evidence for the same
  note — recorded once there, applies to this plan's commit too).
- Remaining operational risk: same Node-22-on-a-Node-20-box caveat as P01 (verified here via the
  `npm exec --package=node@22` shim, not a real Node 22 install; CI uses actual Node 22). The
  `secret-guard.ts` pattern list is intentionally narrow (named patterns from ADR 0010/0014: `aoc_`,
  common provider-key shapes) — it is a belt-and-braces write-path guard, not a general secret
  scanner, and does not (and per ADR 0003 must not) touch the ACP `envelope` column itself.
- Follow-up: P03 (ACP Session coordinator) and P06 (Custody and resume, jointly with P04) are now
  unblocked.

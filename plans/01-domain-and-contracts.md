# P01 — Domain and generated contract foundation

- **Status:** ready
- **Dependencies:** none
- **Primary paths:** `packages/domain`, `packages/session-runtime-control`, `contracts`, repository tooling

## Required reading

- `docs/specs/00-glossary.md`
- `docs/specs/02-domain-model.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0002, 0003, 0005, 0010, 0014

## Deliverables

- Branded TypeScript identifiers for Workstream, Principal, Session, Command, Event and Snapshot.
- Workstream category and Session phase types matching SQL/OpenAPI exactly.
- Pure constructors and transition guards.
- Command/idempotency model.
- Implementation-neutral execution-grant and activation types that expose no OneCLI identifier,
  proxy bearer or provider credential.
- Session Runtime control bindings generated or hand-verified from OpenAPI, with no runtime ID.
- Schema fixture runner for every `contracts/schemas` file.
- Architecture test preventing imports from packages into deployables or privileged packages into
  `domain`.

## Tasks

- [x] Add package build/typecheck/test configuration.
- [x] Implement IDs without parsing semantic meaning from UUIDs/ACP IDs.
- [x] Implement Workstream category cardinality guards.
- [x] Implement membership role/last-owner guards.
- [x] Implement Session state transition table and terminal-state guards.
- [x] Implement immutable Session launch-envelope types.
- [x] Keep `SessionRuntimeStatus` in the control-contract package; do not create a domain
  `SessionRuntime` entity or identifier.
- [x] Keep OneCLI Agent IDs, control keys, proxy URLs and route-rule rows out of domain types.
- [x] Mark grant references and bridge credentials sensitive in generated bindings and serializers.
- [x] Implement typed failure codes shared only where contracts require them.
- [x] Add valid/invalid JSON Schema fixtures.
- [x] Validate OpenAPI operation IDs and duplicate schema names.
- [x] Add forbidden-vocabulary check for source code identifiers.

## Required tests

- [x] Invocation rejects a second user-purpose prompt.
- [x] Handoff prompt does not consume invocation user cardinality.
- [x] Agent, Workstream and ACP binding cannot mutate.
- [x] Illegal phase transitions fail with typed errors.
- [x] Same idempotency scope/key resolves to the same command.
- [x] No local type duplicates ACP ContentBlock/SessionUpdate.
- [x] Session Runtime operations are nested under Session ID and generated bindings expose no
  `runtimeId`.
- [x] Broker/Session Runtime contract fixtures cannot place an `aoc_` bearer, OneCLI control key or
  provider token in public/product/ACP shapes.

## Non-goals

- No database repository.
- No HTTP server.
- No ACP connection.
- No Kubernetes, OneCLI client or Broker implementation.

## Exit criteria

- `npm test` passes.
- Types match all machine-readable contracts.
- No Proposed ADR is bypassed.
- P02/P03/P04 can depend on published workspace packages without copying types.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed to
  `origin/refactoring` — see the branch's own history for the exact hash; push happens after
  operator review).
- Packages delivered: `packages/domain` (`src/ids.ts`, `errors.ts`, `uuid.ts`, `workstream.ts`,
  `session.ts`, `commands.ts`, `grants.ts`) and `packages/session-runtime-control`
  (`src/types.ts`, `client.ts`), each with `build`/`typecheck`/`test` npm scripts (`tsc` then
  `node --test` over the compiled output).
- New repo-wide checks wired into `npm test`: `scripts/run-schema-fixtures.mjs` (valid/invalid
  fixtures for all 8 `contracts/schemas/*.schema.json`, under `contracts/schemas/fixtures/`),
  `scripts/check-architecture.mjs` (domain/package/deployable import-boundary enforcement),
  `scripts/check-forbidden-vocabulary.mjs` (retired-term scan over `*/src`). `scripts/
  check-repository.mjs` was adjusted to exclude `contracts/schemas/fixtures/` from schema
  auto-registration (fixtures are schema *instances*, not definitions).
- Exact command: `npm test` (root). Result: `repository checks passed (146 files, 14 ADRs)` →
  `schema fixtures passed (8 schemas)` → `architecture boundaries hold (14 workspace packages
  scanned)` → `no forbidden vocabulary found (11 source files scanned)` → 31/31 domain tests pass
  → 7/7 session-runtime-control tests pass. All 8 required tests from this plan are implemented
  and passing (see the checklists above).
- Both new architecture/vocabulary checks were verified to actually fail on a planted violation
  (a `@agora/domain` → `@agora/session-runtime-control` import; a local `interface Run`), then
  reverted, before being trusted.
- Remaining operational risk: this dev sandbox only has Node 20 installed although the repo
  requires (and CI's `actions/setup-node` provides) Node 22; verification here used the
  `npm exec --yes --package=node@22 -- node` shim already established by `packages/acp/SPIKE.md`.
  Not itself re-verified against a real Node 22 install — low risk since CI uses actual Node 22.
  `contracts/database/*.sql` (P02 scope) was not touched or re-verified here.
- Follow-up: P02 (Postgres store) and P04 (Session Runtime controller) are now unblocked.

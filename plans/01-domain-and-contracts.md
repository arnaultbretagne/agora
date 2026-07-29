# P01 — Domain and generated contract foundation

- **Status:** blocked on baseline review
- **Dependencies:** none
- **Primary paths:** `packages/domain`, `packages/runtime-control`, `contracts`, repository tooling

## Required reading

- `docs/specs/00-glossary.md`
- `docs/specs/02-domain-model.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0002, 0003, 0005

## Deliverables

- Branded TypeScript identifiers for Workstream, Principal, Session, Command, Event and Snapshot.
- Workstream category and Session phase types matching SQL/OpenAPI exactly.
- Pure constructors and transition guards.
- Command/idempotency model.
- Runtime-control generated or hand-verified bindings from OpenAPI.
- Schema fixture runner for every `contracts/schemas` file.
- Architecture test preventing imports from packages into deployables or privileged packages into
  `domain`.

## Tasks

- [ ] Add package build/typecheck/test configuration.
- [ ] Implement IDs without parsing semantic meaning from UUIDs/ACP IDs.
- [ ] Implement Workstream category cardinality guards.
- [ ] Implement membership role/last-owner guards.
- [ ] Implement Session state transition table and terminal-state guards.
- [ ] Implement immutable Session launch-envelope types.
- [ ] Implement typed failure codes shared only where contracts require them.
- [ ] Add valid/invalid JSON Schema fixtures.
- [ ] Validate OpenAPI operation IDs and duplicate schema names.
- [ ] Add forbidden-vocabulary check for source code identifiers.

## Required tests

- Invocation rejects a second user-purpose prompt.
- Handoff prompt does not consume invocation user cardinality.
- Agent, Workstream and ACP binding cannot mutate.
- Illegal phase transitions fail with typed errors.
- Same idempotency scope/key resolves to the same command.
- No local type duplicates ACP ContentBlock/SessionUpdate.

## Non-goals

- No database repository.
- No HTTP server.
- No ACP connection.
- No Kubernetes or Broker code.

## Exit criteria

- `npm test` passes.
- Types match all machine-readable contracts.
- No Proposed ADR is bypassed.
- P02/P03/P04 can depend on published workspace packages without copying types.

## Evidence

To be completed by the implementing agent.

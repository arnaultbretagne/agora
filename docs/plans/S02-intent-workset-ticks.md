# S2 — Intent authoring, workset and ticks

- **Status:** planned
- **Depends on:** S1
- **Produces:** `packages/engine`, `packages/testkit`, `apps/control-plane` (birth), schema section *canonical history: Intents* and *operational control: workset*, `contracts/api/control-plane.openapi.yaml` (Workstreams, Intents)
- **Master plan:** [S2](../master-plan.md#s2--intent-authoring-workset-and-ticks)

## Goal

The durable spine of [ADR 0003](../adr/0003-reconciliation-over-state.md) on PostgreSQL: complete
Intents appended with increasing `intent_seq`; one coalesced work row per Workstream; the empty
`NOTIFY` tick plus polling; bounded, database-timed claims and leases; evaluation with
`packages/domain`; conditional finalization fenced by `work_generation`. No external system is
mutated. The control plane process is born with the Workstream and Intent API, and the browser can
create a Workstream and set its power.

## Read first

1. [ADR 0003](../adr/0003-reconciliation-over-state.md) in full, [ADR 0005](../adr/0005-postgresql-durable-store.md)
2. [engine](../specs/reconciliation/engine.md): *Scope and invariants*, *Intent authoring and revision selection*, *Work generations, claims and leases*, *Tick and acquisition*, *Retry budgets and fairness*, *Conditional finalization and admission*
3. [000 taxonomy §Tick and §Results](../specs/reconciliation/000_taxonomy.md)
4. [acceptance: Engine concurrency and recovery](../specs/reconciliation/acceptance.md#engine-concurrency-and-recovery)
5. [execution: Owners and isolation](../specs/reconciliation/execution.md#owners-and-isolation) (authorization sentence)
6. Field findings [§5 PostgreSQL, tests and concurrency](../field-findings.md#5-postgresql-tests-and-concurrency-slices-s2-s3), [§6](../field-findings.md#6-methodological-lessons), [§7](../field-findings.md#7-reuse-register)

## Before coding

- **P1, product authorization.** The specs require authorization per Workstream but define no
  model. Propose the minimal one in the PR and record it in `execution.md` under *Owners and
  isolation* before implementing: a principal identifier arrives from the deployment's trusted
  authentication proxy in one header (the previous deployment used `X-Forwarded-Email`); the
  Workstream's creating principal is its owner; only owners read or write it; service actions carry
  their own actor. If the reviewer rejects this, stop.
- **P2, storage contract.** `contracts/db/schema.sql` is the contract. Write the section first,
  review it against the engine contract's correlation table, then code against it.
- Decide the notification channel name once: `workstream_reconciliation` (ADR 0003).

## Deliverables

```text
contracts/db/schema.sql                 sections: "S2 canonical history — Intents", "S2 operational control — workset", roles agora_product, agora_engine
contracts/api/control-plane.openapi.yaml  Workstreams + Intents; Problem responses
contracts/schemas/fixtures/…              request/response fixtures for the new schemas
packages/testkit/
  src/pg.ts                    withTestDatabase (UUID-named DB, schema applied from contracts/db/schema.sql, pool max 25), asRole
  src/clock.ts                 controllable clock; database time helper (SET the session's now() via a test-only function)
  src/interleave.ts            step/pause/resume harness for scripted concurrency
packages/engine/
  src/authoring.ts             authorIntent(tx, {workstreamId, principal, requestKey, intent}) → {intentSeq, created|replayed} | conflict
  src/workset.ts               claimDue, renew, release, reschedule, finalize — all conditional on (claim_token, work_generation)
  src/tick.ts                  listener (LISTEN workstream_reconciliation) + poll loop → scan
  src/backoff.ts               capped exponential with jitter, per-row attempt budget
  src/worker.ts                claim → load Intent + revision → evaluate (packages/domain) → act | hold | converge → emit continuation NOTIFY
  src/observation-source.ts    ObservationSource interface (fresh reads per tick); S2 ships FakeObservationSource
  src/verb-executor.ts         VerbExecutor interface; S2 ships a recording fake
  test/…
apps/control-plane/
  src/main.ts                  HTTP API + worker in one process for now (flag to run either)
  src/http/*.ts                routes below, node:http, Problem+JSON errors, Idempotency-Key handling
  test/…
apps/web/src/client/api.ts     new functions for Workstreams and Intents (see Step 8)
```

## Work plan

### Step 1 — Schema section and roles

Append to `contracts/db/schema.sql`:

- `workstreams (id uuid pk, owner_principal text, title text, created_at, updated_at)`
- `workstream_intent_events (workstream_id fk, intent_seq bigint, intent jsonb, request_key text, principal text, revision_set jsonb, created_at; pk (workstream_id, intent_seq); unique (workstream_id, request_key))`
- `workstream_reconciliation_work (workstream_id pk fk, intent_seq bigint, work_generation bigint, due_at timestamptz, claim_token uuid null, lease_until timestamptz null, attempt_count int, blocking_cause text null, last_error jsonb null, updated_at)`
- `work_generation_seq` as a global `bigint` sequence: generations are never reused after a row is
  deleted and recreated (ABA, `ENGINE-005`).
- A trigger forbidding `intent_seq` to decrease on the work row.
- Roles: `agora_product` (append Intents, read Workstreams), `agora_engine` (workset, read Intents).
  Column-scoped `GRANT UPDATE` where a column is immutable. Create roles with the race-safe idiom
  (findings §5: cluster-global roles, `duplicate_object OR unique_violation`).

Acceptance: `npm run db:reset` applies it in CI; a test under `agora_product` fails to update an
Intent event (`asRole`, real denied SQL — findings §5 on superuser suites).

### Step 2 — testkit

Carry the disposable-database pattern over (findings §7: `packages/store-pg/test/support.ts`,
`db.ts`): UUID-suffixed database per call, apply `contracts/db/schema.sql`, pool `max` 25, `asRole`.
Decide the `bigint` parser once (`pg.types.setTypeParser(20, …)`) and assert exact numeric sequences
in tests (findings §5, `'0' + 1`). Add a controllable clock: tests must drive lease expiry and
backoff without sleeping; the database side uses a test-only `agora_test.now()` function the engine
reads through an injectable `nowSql` expression.

### Step 3 — Intent authoring transaction

Per [engine: authoring](../specs/reconciliation/engine.md#intent-authoring-and-revision-selection):
lock the Workstream row (`SELECT … FOR UPDATE`), look up `request_key`: same content → return the
original event (`replayed`); different content → conflict (409, no write); otherwise append with
`intent_seq = max + 1`, upsert the work row (`intent_seq`, fresh `work_generation` from the
sequence, `due_at = now()`, clear claim/lease, reset backoff), then `NOTIFY workstream_reconciliation`
with an empty payload, all in one transaction. Content equality is on the canonical JSON of the
complete Intent. Validation uses `packages/domain` with a stub `CatalogueView` (S7 replaces it).

Acceptance: `ENGINE-001` (two racing requests get distinct increasing sequences; both events kept;
work row points to the latest), `ENGINE-002` (same key, other payload → conflict, nothing written),
replay of an identical key adds no event.

### Step 4 — Workset: claim, renew, release, finalize

```sql
UPDATE workstream_reconciliation_work w SET claim_token = $1, lease_until = now() + $2
WHERE workstream_id IN (
  SELECT workstream_id FROM workstream_reconciliation_work
  WHERE due_at <= now() AND (claim_token IS NULL OR lease_until < now())
  ORDER BY due_at LIMIT $3 FOR UPDATE SKIP LOCKED)
RETURNING *
```

Every later update compares the exact `claim_token` **and** `work_generation`; zero rows affected
means the claim was lost and the worker stops dispatching. Finalize is
`DELETE … WHERE workstream_id AND intent_seq AND work_generation AND claim_token` and the worker
treats zero rows as "newer obligation exists". Use database time only. Never hold a transaction
across a network call (the fake executor is called outside any transaction).

Acceptance: `ENGINE-003` (old pass cannot finalize after a newer Intent), `ENGINE-004` (drift
re-enqueue with same `intent_seq`, new generation, survives an old finalize), `ENGINE-005`
(row deleted and recreated; old token/generation rejected), `ENGINE-006` (claim expires while the
worker is paused; a second worker claims; the first worker's renew/finalize fail).

### Step 5 — Ticks, polling, backoff, fairness

A dedicated `pg.Client` runs `LISTEN`; any notification and a poll timer both call the same
`scan()`. Duplicate notifications coalesce into one scan. After an action attempt the worker
emits the continuation `NOTIFY`. `HOLD` sets `due_at` from the backoff policy and clears the claim;
`ACTION` failures increment `attempt_count` and back off with cap and jitter; an exhausted budget
leaves the row due at the bounded recheck interval with `blocking_cause` set, never deleted
(`ENGINE-011`). Claims are batched (`LIMIT n`), so one failing Workstream cannot starve others.

Acceptance: `ENGINE-010` (drop every notification → polling finds due work; send thousands →
one effect per due row, backoff respected), `ENGINE-011` (permanent error → durable recheck, no
spin), `ENGINE-015` (action completion racing a fresh wake: the conditional release cannot postpone
or overwrite the newer generation), `ENGINE-016` (starvation), `ENGINE-017` authoring side (off
Intent accepted with retained selections while the catalogue stub reports the harness retired).

### Step 6 — Worker evaluation with fakes

`worker.ts` loads the Intent and its `revision_set`, builds an `ObservationReader` over the
`ObservationSource` (fresh per tick, never cached across ticks), calls `evaluate`, and:

- `CONVERGED` → conditional finalize (Step 4);
- `ACTION(verb)` → `VerbExecutor.execute(verb, context)` outside any transaction, then continuation tick;
- `HOLD` → reschedule with backoff, clear claim;
- `acquisition_incomplete` → reschedule with backoff and `blocking_cause = 'acquisition:<field>'`.

`FakeObservationSource` is scripted per test (e.g. inventories empty → `power = off`). The
recording `VerbExecutor` asserts which verb was selected and with which rule id.

Acceptance: an `off` Intent against empty fake inventories reaches `POWER-001` and the row is
finalized; an `on` Intent against `∅` construction selects `BUILD` exactly once per tick and the
continuation tick re-evaluates from POWER; the executor is never called inside a transaction (assert
via a `pg` client spy).

### Step 7 — Control-plane API

`contracts/api/control-plane.openapi.yaml` and implementation (`node:http`, no framework):

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/workstreams` | body `{title}`; `Idempotency-Key` required; creates with the caller as owner |
| `GET` | `/v1/workstreams` | owner's Workstreams |
| `GET` | `/v1/workstreams/{id}` | |
| `PATCH` | `/v1/workstreams/{id}` | `{title}` |
| `PUT` | `/v1/workstreams/{id}/intent` | complete Intent; `Idempotency-Key` is the request key; 201 created / 200 replayed / 409 conflict / 422 invalid |
| `GET` | `/v1/workstreams/{id}/intent` | latest Intent event plus an **operational** view of the work row (`due_at`, `attempt_count`, `blocking_cause`) explicitly labeled as not a convergence proof |

Errors are `application/problem+json` with `detail` always populated (findings §6.8). Principal
from the header decided in *Before coding*; requests without it are 401. `DELETE /v1/workstreams/{id}`
is **not** in S2: deletion must extinguish execution first ([continuity: storage](../specs/reconciliation/continuity.md#storage-and-retention)).

Acceptance: contract fixtures validate; an HTTP test drives create → put intent (power off) → the
worker finalizes → `GET …/intent` shows the event and no work row.

### Step 8 — Web plumbing, part 1

In `apps/web/src/client/api.ts` add `listWorkstreams`, `createWorkstream`, `getWorkstream`,
`patchWorkstream`, `getIntent`, `putIntent` against the new paths, generated by hand from the
OpenAPI file. Wire the sidebar list, "new Workstream", rename and a power toggle in `app.ts`.
Every other legacy action must fail **visibly** (toast with the Problem `detail`) rather than
silently; the boot test must stay green. Do not touch the vocabulary allowlist; the legacy field
goes away in S12.

## Reuse

Allowed (findings §7): test support and `db.ts` pattern; race-safe `CREATE ROLE`; column-scoped
grants. Forbidden: archived `workstreams.ts`, `commands.ts`, `sessions.ts` and the command state
machine.

## Definition of done

- [ ] Schema section reviewed against the engine correlation table; roles tested with denied SQL.
- [ ] Scenarios executed as named tests: `ENGINE-001, 002, 003, 004, 005, 006, 010, 011, 015, 016, 017(authoring)`.
- [ ] Worker never holds a transaction across the executor; database time only for leases.
- [ ] OpenAPI contract with fixtures; HTTP tests; Problem details populated.
- [ ] Browser: create, list, rename, set power end to end against a local control plane.
- [ ] `docs/master-plan.md` S2 marked done with the PR number; P1 recorded in `execution.md`.

## Report

List the scenarios run, how interleavings were forced (pause points, clock advances), the chosen
lease/backoff defaults with the note that S11 pins them, and the authorization model as recorded.

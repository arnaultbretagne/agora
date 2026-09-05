# S3 — Workstream journal, Sessions and projections framework

- **Status:** planned
- **Depends on:** S2
- **Produces:** `packages/journal`, `packages/projections`, schema sections *canonical history: facts and Sessions* and *projections*
- **Master plan:** [S3](../master-plan.md#s3--workstream-journal-sessions-and-projections-framework)

## Goal

One canonical ordered fact stream per Workstream; Sessions as filtered views with their own
identity; Session birth as one idempotent operation that pins the opening cutoff `H`; a projector
framework that is deterministic, versioned, checkpointed and rebuildable. No ACP yet: facts in S3
are the Session-birth and provenance kinds.

## Read first

1. [ADR 0002](../adr/0002-workstream-session-model.md) in full; [ADR 0004 §Readable models are projections](../adr/0004-acp-boundary-and-session-facts.md); [ADR 0005](../adr/0005-postgresql-durable-store.md)
2. [execution: Session birth and admission](../specs/reconciliation/execution.md#session-birth-and-admission)
3. [continuity: Opening descriptor](../specs/reconciliation/continuity.md#opening-descriptor)
4. [engine: Intent authoring](../specs/reconciliation/engine.md#intent-authoring-and-revision-selection) (birth serializes with Workstream appends)
5. [acceptance: `CONT-001`, `CONT-002`](../specs/reconciliation/acceptance.md#native-continuity-and-bounded-shutdown)
6. Field findings [§5](../field-findings.md#5-postgresql-tests-and-concurrency-slices-s2-s3) (row lock before dual allocation), [§7](../field-findings.md#7-reuse-register) (projections bricks, secret guard)

## Before coding

- Register the S3 fact kinds in a contract before using them: `contracts/schemas/fact-kinds.json`
  listing kind, payload schema reference and whether the kind is Session-scoped. S3 kinds:
  `session.opened` (pinned `H`, Pod UID, provenance), `session.ended` (attribution ended; **not**
  an off Session), `session.provenance` (image digests, workload identity, non-secret runtime
  ids). Anything else waits for its slice. If a needed kind has no normative home, add a sentence to
  `execution.md` first.
- Sessions carry no lifecycle phase column. If you find yourself adding `status`, stop and re-read
  ADR 0003 *Options considered §1*.

## Deliverables

```text
contracts/db/schema.sql           sections "S3 canonical history — facts and Sessions", "S3 projections"
contracts/schemas/fact-kinds.json, fixtures
packages/journal/
  src/append.ts                   appendFact(tx, workstreamId, {sessionId?, kind, payload, causation}) → seq
  src/sessions.ts                 openSession(tx, …) idempotent birth; endAttribution(tx, sessionId)
  src/reads.ts                    facts by Workstream range; facts by Session (filtered view)
packages/projections/
  src/projector.ts                Projector<State> interface: name, version, fold(fact, state), checkpoint
  src/runner.ts                   incremental run from checkpoint; rebuild(workstreamId) = truncate + replay
  src/hash.ts                     order-independent state hash for rebuild equivalence
  src/session-list.ts             first projector: Sessions with provenance
```

## Work plan

### Step 1 — Schema

- `workstreams.head_seq bigint not null default 0` with a trigger forbidding decrease.
- `workstream_facts (workstream_id fk, seq bigint, session_id uuid null fk, kind text, payload jsonb, causation jsonb null, recorded_at; pk (workstream_id, seq))`;
  index `(session_id, seq)` for Session reads.
- `sessions (id uuid pk, workstream_id fk, ordinal int, opened_at, opened_at_seq bigint, cutoff_h bigint, pod_uid text, provenance jsonb, attribution_ended_at null; unique (workstream_id, ordinal); unique (workstream_id, pod_uid))`
  and a partial unique index `(workstream_id) WHERE attribution_ended_at IS NULL` (at most one
  current execution per Workstream).
- `projection_checkpoints (projector text, workstream_id, projector_version text, through_seq bigint, updated_at; pk (projector, workstream_id))`
  and the first projection table `projection_sessions`.
- Roles: `agora_product` appends facts; `agora_projector` reads facts, owns `projection_*`.

### Step 2 — Append with canonical order

`appendFact` locks the Workstream row, increments `head_seq`, inserts with that `seq`, in the
caller's transaction (findings §5: the same lock as authoring; the sequence allocator and the
Intent authoring share it so birth and Intent appends are totally ordered). Wall-clock is recorded,
never used for ordering (ADR 0004).

Acceptance: 50 concurrent appends yield `1..50` exactly (assert numbers, not "no error").

### Step 3 — Idempotent Session birth

`openSession(tx, {workstreamId, podUid, provenance})`: under the Workstream lock, if a Session with
this `pod_uid` exists return it unchanged; otherwise `cutoff_h := head_seq` (before any fact of the
new Session), insert the Session with the next ordinal, then append `session.opened` attributed
to it (so its own first fact has `seq > H`). If a current Session exists whose attribution has not
ended, the caller must have ended it first; birth does not implicitly end attribution
([execution: hot boundaries](../specs/reconciliation/execution.md#hot-session-boundaries) governs
that in S8).

Acceptance: `CONT-001` (bootstrap facts have `seq > H`; the range `(W, H]` contains none of them),
`CONT-002` (fresh Workstream: `H = 0`), repeated birth with the same Pod UID under concurrency
creates exactly one Session and one cutoff.

### Step 4 — Session reads

Reading a Session is `SELECT … WHERE session_id = $1 ORDER BY seq`. No Session-local journal, no
copy. Provide a paginated Workstream read by `seq` range as the input for projectors and, later,
Handoff rendering.

### Step 5 — Projector framework

Carry over the checkpoint upsert, name-based UUID identity for projected rows and the
order-independent state hash (findings §7: `projections.ts`, `projector.ts`). A projector is a pure
fold `(state, fact) → state` with a `version`; the runner reads facts from the checkpoint, applies,
writes the projection table and checkpoint in one transaction; `rebuild` truncates the projector's
tables for a Workstream and replays from `seq 1`. A version change forces rebuild.

Acceptance: incremental run and rebuild produce identical hashes on a randomized fact sequence;
a projector version bump triggers rebuild; projected rows carry `first_seq`/`latest_seq` source
references.

### Step 6 — Secret guard

Carry `secret-guard.ts` over for non-envelope fields (`payload` of S3 kinds, `causation`): refuse
to persist strings matching known token shapes. It does not apply to ACP envelopes (S4).

## Reuse

Allowed (findings §7): `projections.ts` checkpoint/hash helpers, `stableStringify`, name-based UUID
derivation, `secret-guard.ts`. Forbidden: archived `sessions.ts` (phases), `journal.ts` outbox.

## Definition of done

- [ ] Facts appended once, ordered by `seq` under the shared Workstream lock; concurrency test asserts exact sequences.
- [ ] Session birth idempotent by Pod UID; `CONT-001`, `CONT-002` as named tests.
- [ ] Partial unique index enforces one current execution per Workstream.
- [ ] Projector runner: incremental = rebuild (hash), version bump rebuilds, source references kept.
- [ ] Fact kinds registered in `contracts/schemas/fact-kinds.json` with fixtures.
- [ ] Master plan S3 marked done.

## Report

Name the fact kinds introduced and where each is normatively grounded; give the concurrency
counts used; state that no ACP fact exists yet.

# S5 — Owner request protocol, epochs and attempt recovery

- **Status:** planned
- **Depends on:** S2 (S3 for Session-scoped attempts)
- **Produces:** `packages/owner-requests`, engine epochs/attempts/sweeps, fake owners in `packages/testkit`, `contracts/schemas/owner-request.schema.json`
- **Master plan:** [S5](../master-plan.md#s5--owner-request-protocol-epochs-and-attempt-recovery)

## Goal

The part of the engine that makes external effects safe, built and proved against **fake owners**
before any real Kubernetes or OneCLI exists: durable reservation before dispatch, mutation epochs,
takeover that settles the old owner's possible dispatches first, unknown-acceptance retention,
retirement of targets that survives work-row deletion, watches and recovery sweeps. Runtime-control
(S6) and broker (S7) implement this protocol; the control plane calls it.

## Read first

1. [engine](../specs/reconciliation/engine.md): *Work generations, claims and leases* (correlation table), *Effect ownership and late requests*, *Action recovery and result handling*, *Retry budgets and fairness*, *Watches and recovery sweeps*, *Conditional finalization and admission*
2. [003 verbs](../specs/reconciliation/003_verbs.md): every verb's *Idempotency and recovery* paragraph
3. [ADR 0003 §Consequences](../adr/0003-reconciliation-over-state.md), [ADR 0009 §mutation ownership](../adr/0009-onecli-grant-authority.md)
4. [acceptance: `ENGINE-006..009, 011, 012, 014, 018`](../specs/reconciliation/acceptance.md#engine-concurrency-and-recovery)
5. Field findings [§3.2](../field-findings.md#32-what-onecli-does-not-provide-and-what-that-costs) (fail-open SDK path, idempotency keyed on the wrong thing), [§6.2](../field-findings.md#6-methodological-lessons) (fakes must enforce what the real product enforces)

## Before coding

- **P5, protocol shape.** Write `contracts/schemas/owner-request.schema.json` and a short
  normative paragraph in `engine.md` (*Effect ownership*) fixing the request envelope:
  `{ epoch, workstream_id, attempt_key, operation, target: concrete | reserved, payload, payload_digest, revision_set }`
  and the response grammar `{ accepted | rejected_stale_epoch | rejected_key_mismatch | completed | unknown }`.
  Get it reviewed before coding both sides.
- Decide where epochs live: one `mutation_epochs (workstream_id pk, epoch bigint, owner_claim uuid, issued_at)`
  row in the control plane, mirrored by each owner as the last epoch it accepted per Workstream.
  Owners reject any request with `epoch <` their recorded value.

## Deliverables

```text
contracts/schemas/owner-request.schema.json, fixtures
contracts/db/schema.sql           "S5 operational — mutation_epochs, owner_attempts, target_retirements, wake_sources"
packages/owner-requests/
  src/protocol.ts                 types from the contract; digest computation
  src/client.ts                   OwnerClient: submit(request) with reservation bookkeeping hooks
  src/server.ts                   OwnerServer helpers an owner embeds: epoch check, key/payload check, idempotent completion, unknown retention
packages/engine/
  src/epochs.ts                   issueEpoch on claim transfer; fence obsolete requests
  src/attempts.ts                 reserve → dispatch → settle | unknown; takeover records dispatch owner and recovery owner
  src/retirement.ts               retire target: forbids positive mutations and rebinding; cleanup stays authorized
  src/verb-runner.ts              executes a verb as owner requests under one attempt key (replaces the S2 fake executor)
  src/sweeps.ts                   bounded recovery sweeps over wake_sources; re-enqueue finalized Workstreams
packages/testkit/
  src/fake-owners/runtime-control.ts, broker.ts   implement OwnerServer with injectable: lost response, delayed acceptance, crash after accept, late arrival
```

## Work plan

### Step 1 — Contract and shared protocol code

Implement `protocol.ts` from the schema. `payload_digest` is SHA-256 of the canonical JSON payload.
`OwnerServer` helpers: reject `epoch` older than recorded; reject a reused `attempt_key` with a
different digest (`rejected_key_mismatch`); return the recorded result for a reused key with the
same digest; record `unknown` when the owner's own downstream call did not settle.

Acceptance: fixture round-trips; a reused key with another payload is refused (`ENGINE-002` shape
at the owner boundary).

### Step 2 — Reservation before dispatch

`attempts.ts`: within the Workstream ordering (same row lock as authoring), insert
`owner_attempts (attempt_key pk, workstream_id, epoch, operation, target, payload_digest, state reserved|dispatched|settled|unknown|superseded, dispatch_owner, recovery_owner null, reserved_at, settled_at)`,
commit, **then** call the owner outside any transaction, then settle. A crash between dispatch and
settle leaves `dispatched`, which recovery treats as possibly accepted.

Acceptance: `ENGINE-008` (BUILD response lost; inventory still empty; the reservation blocks a
second create and blocks off finalization until resolved).

### Step 3 — Epochs and takeover

On claim transfer (S2 lease expiry), issue a new epoch **after** enumerating the old owner's
`dispatched` attempts and marking each `recovery_owner`; the new owner may observe and close unsafe
access but may not start conflicting positive effects until each is settled (`settled` or
`superseded` with the target retired). Owners reject the old epoch.

Acceptance: `ENGINE-006` (worker paused in a network call; transfer blocks new old-owner dispatch
and tracks the possibly accepted request), `ENGINE-014` (revision set changes during a tick:
requests carrying the old revision are rejected).

### Step 4 — Late effects and retirement

`retirement.ts`: retiring a target (Pod UID, Agent id, reserved slot) forbids positive mutations and
rebinding forever; concrete-target cleanup remains authorized. Retirement survives work-row
deletion. Fake owners deliver a late `completed` after the target was retired; the engine must find
it discoverable by its pre-recorded correlation and route it to cleanup, never activation.

Acceptance: `ENGINE-007` (late GRANT/Agent creation after off: target stays gated, effect cleaned,
off not finalized while unresolved), `ENGINE-009` (old TURN_OFF returns after replacement: cleanup by
original UID, nothing for the successor touched), `ENGINE-018` (DB commit succeeded but owner
activation failed: execution stays gated, re-observe).

### Step 5 — Verb runner

Replace the S2 fake `VerbExecutor` with `verb-runner.ts`: a verb becomes one or more owner requests
under one attempt key, each verifying ownership and preconditions; it returns no reconciliation
value; after the attempt ends the engine emits the continuation tick. Encode each verb's
*Idempotency and recovery* paragraph as the runner's per-verb recovery function: BUILD discovers
reserved targets; TURN_OFF repeats cleanup on concrete targets and never resets the deadline;
GRANT/REVOKE reread the owner before repeating; START/RESTORE/REFILL/SET_* leave unknown acceptance
unresolved (their real recovery arrives with S8).

Acceptance: the runner never selects a different verb on failure; an exhausted budget leaves a typed
`blocking_cause`; `ENGINE-011` re-run with owner errors.

### Step 6 — Watches and sweeps

`wake_sources (source, cursor, last_seen)` and `sweeps.ts`: each source in the engine's table
(Intent, runtime inventory, OneCLI/Broker, harness, Save/Anchor, registry, attempts) has a wake
hook and a bounded sweep that can re-enqueue a Workstream **absent from the workset** (fresh
generation, same `intent_seq`). Fake owners emit wake events; a test drops them.

Acceptance: `ENGINE-012` (finalized Workstream drifts; only the sweep re-enqueues it; scanning
active rows alone fails), lost-cursor relist.

### Step 7 — Fake owners that enforce the contract

Fake runtime-control and broker implement `OwnerServer` and **enforce** what the real ones will:
epoch rejection, key/digest mismatch, unknown creation discoverable by correlation, retired-target
refusal. Injectable faults: drop response, accept-then-crash, delayed completion, duplicate
delivery. These fakes are what S6 and S7 must match; do not soften them to make a test pass
(findings §6.2).

## Reuse

None from the archive: the old grant/activation code keyed idempotency on the wrong thing and had no
epoch (findings §3.2, §5).

## Definition of done

- [ ] Owner request contract in `contracts/schemas` and `engine.md`; both client and server helpers.
- [ ] Scenarios as named tests on fake owners: `ENGINE-006, 007, 008, 009, 011, 012, 014, 018`.
- [ ] Reservation precedes every dispatch; no transaction spans an owner call.
- [ ] Retirement survives work-row deletion; late effects are cleaned, never activated.
- [ ] Verb runner replaces the S2 fake executor; per-verb recovery functions exist for all nine verbs (S8/S9 fill the ACP-facing ones).
- [ ] Master plan S5 marked done.

## Report

List the injected faults per scenario and the exact interleaving (pause points). State which verb
recovery functions are stubs awaiting S8/S9.

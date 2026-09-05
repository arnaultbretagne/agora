# ADR 0003 — Reconciliation over state realizes Intent

- **Status:** Accepted
- **Date:** 2026-08-13
- **Revised:** 2026-09-05 — HOLD, effect ownership, unknown delivery and bounded recovery.

## Context

An Intent describes what should exist for a Workstream. Realizing it may require coordinated
changes across several authoritative systems.

Those systems may change or fail independently:

- a runtime resource may disappear;
- an authority may be revoked;
- a control process may restart;
- an external operation may succeed before its local caller fails;
- several new Intents may arrive before reconciliation completes.

A persisted lifecycle status cannot determine what currently exists. Values such as
`provisioning`, `ready` or `failed` only describe what a previous process believed or attempted.

Session facts cannot answer that question either. They log an execution that actually happened,
but they remain historical after being written.

The system therefore needs a durable way to retain complete Intents, a bounded way to find pending
work, and fresh Observations from the systems that own current state.

## Decision

Agora realizes Intent through reconciliation over state.

Reconciliation is scoped by `workstream_id`. A Session is realized execution and may not exist when
an Intent is submitted. It is therefore neither the identity nor the unit of reconciliation.

Every Intent request is complete. It expresses the entire desired execution state for its
Workstream and is never interpreted as a patch over a previous Intent.

Within one PostgreSQL transaction:

1. the complete Intent is appended to `workstream_intent_events` with the next `intent_seq` for the
   Workstream;
2. `workstream_reconciliation_work` is inserted or advanced so its single row for the Workstream
   points to that `intent_seq`, with a fresh `work_generation`;
3. an empty `NOTIFY` is emitted on `workstream_reconciliation`.

```text
Complete Intent
      │
      ▼
PostgreSQL transaction: immutable Intent + coalesced work + empty NOTIFY
      │ commit
      ▼
Tick: claim due work → read Intent → observe → ordered rules
                                        │
              ┌───────────┬─────────────┼───────────────────┐
              ▼           ▼             ▼                   ▼
             PASS     ACTION(verb)     HOLD              CONVERGED
              │           │             │                   │
          next rule     attempt     active work       conditional finalize
          same tick       │        watch/backoff       no successor tick
                          ▼
                 schedule + empty NOTIFY
```

`intent_seq` provides logical ordering within one Workstream. `created_at` records when an Intent
was stored but does not resolve concurrent ordering.

`workstream_intent_events` is the append-only source of truth for desired execution.

`workstream_reconciliation_work` is a coalescing operational workset. It contains at most one row
per Workstream and points to the immutable Intent that currently requires consideration. It is not
a message queue and does not retain one work item per Intent.

`work_generation` changes whenever the Workstream is placed in the workset, including when drift or
a resynchronization request re-enqueues the same `intent_seq`. It has no domain meaning and is not
an Intent revision or a convergence status. A worker may finalize only the exact generation it
claimed, so an older pass cannot erase a later wake-up for the same Intent.

An external re-enqueue caused without a new Intent, such as drift detection or resynchronization,
advances only `work_generation`, keeps the current `intent_seq`, and emits the same empty `NOTIFY`
in one transaction.

`NOTIFY` is the tick of the reconciliation loop. Its empty payload carries no work identity or
state: every tick causes workers to reread the durable workset. The transaction that records a new
Intent emits its first tick. Polling and resynchronization produce recovery ticks when a
notification is lost or emitted while no worker is listening.

For each work row considered during one tick, the reconciler:

1. loads the referenced complete Intent;
2. obtains fresh Observations from the authoritative systems;
3. evaluates the reconciliation rules from the beginning in their deterministic order;
4. applies the result of each matching rule:
   - `PASS` continues with the next ordered rule during the same tick;
   - `ACTION(verb)` executes that action and ends evaluation of that work row for the current tick;
     after the action attempt completes, an empty `NOTIFY` emits the next tick;
   - `HOLD` ends evaluation without mutation or an immediate successor tick; the unrealized row
     remains scheduled for its owner watch and bounded backoff;
   - `CONVERGED` ends evaluation and conditionally finalizes the work row only while its Intent,
     work generation, claim, ownership and evidence remain valid; it emits no successor tick;
5. logs the resulting execution through Session facts when execution occurs.

This evaluation applies independently to each claimed work row. Every new tick reevaluates that
row from the first rule using fresh Observations. A `PASS` does not consume a tick. A continuation
tick after an action modifies neither `intent_seq` nor `work_generation`; the durable work row
remains until a rule returns `CONVERGED`. Action success is not treated as Observation: only the
following tick determines what now exists.

If a newer Intent arrives, the older pass cannot authorize further obsolete work, finalize the
newer row or reopen admission. An already dispatched external request may still complete; trusted
runtime, Broker and ACP boundaries retain, fence and settle that attempt before conflicting work
proceeds. The next evaluation uses the latest complete Intent.

`work_generation` protects workset finalization; it does not fence external effects. Claims/leases
select workers, while durable mutation ownership and target-specific attempt records constrain the
trusted effect owners. A worker-side lease check before a network call is insufficient. Unknown
Pod/Agent creation cannot be retried with a new key or ignored when finalizing absence. An old grant
request cannot make an extinguished target usable after a newer off decision.

These records are operational control, not a Runtime domain identity or current-state model.
Owners supply fresh evidence and enforce their own request boundary. Where an upstream cannot
conditionally reject stale requests, the trusted writer serializes and resolves possible acceptance
before releasing the target; inability to prove that resolution remains explicit uncertainty.

Lost notifications, expired claims and finalized rows are covered by bounded polling, source watches
and recovery sweeps. A HOLD or acquisition failure cannot disappear from scheduling; an exhausted
retry budget remains unrealized with diagnostics. Invalidating external changes re-enqueue even
when the Workstream is absent from the workset. A selected catalogue revision is shared across
workers, and publication durably schedules all affected Workstreams.

Several Intents may therefore be coalesced before execution. An Intent that is replaced before it
affects execution may produce no Session.

This design assumes that Sessions within one Workstream are successive, not independent concurrent
branches. At most one execution is current for a Workstream. Concurrent branches belong to
separate Workstreams.

## Historical facts used by reconciliation

Fresh Observation is the only evidence of what exists now.

A normative reconciliation rule may name specific Workstream or Session facts as historical
inputs. Such a fact may explain what was previously realized or provide a reference required by an
action. It never replaces a fresh Observation.

There is no generic Session state for the reconciler to read. The exact facts, Observations and
actions belong to the reconciliation decision tree and are intentionally outside this ADR.

## Why this choice

This design provides the required properties together:

- **Durable:** the complete Intent and the obligation to reconsider its Workstream commit
  atomically.
- **Responsive:** the initial `NOTIFY` starts reconciliation immediately and every completed action
  emits the tick that continues it.
- **Loss-tolerant:** losing a notification loses neither the Intent nor its work.
- **Coalescing:** rapid Intent changes retain their history while requiring only one current work
  row per Workstream.
- **Observation-based:** every decision uses current evidence from the system that owns the state.
- **Auditable:** every complete Intent remains immutable and ordered.
- **Bounded:** workers scan the operational workset rather than every historical Workstream.
- **Temporally honest:** Intent, Observation and Session facts retain distinct meanings.
- **Operationally small:** the mechanism requires no durable broker in addition to PostgreSQL.

The central statement of this decision is:

> Intent history records what was wanted; the workset says where to look; the ping says when to
> look; only fresh Observation can determine what to do.

## Options considered

### 1. Imperative lifecycle commands and a persisted state machine

```text
create
resume
suspend
close

requested
provisioning
ready
suspending
failed
```

Rejected because commands describe procedures rather than the state that should exist.

After a crash, a persisted `provisioning` or `ready` value does not determine whether its external
effects exist. Recovery would still require fresh Observation, while the state machine would add a
second and potentially contradictory account of reality.

### 2. Use the latest Session or its facts as current runtime state

Rejected because a Session records realized history.

A Session may prove that an execution existed and explain what happened during it. It cannot prove
that its process, resources or authority still exist now.

### 3. Keep only a mutable current Intent

```text
workstream_intents
  UPDATE ...
```

Rejected as the canonical source because it erases the history of what was requested.

It also does not solve work discovery: workers would still need to determine which Workstreams must
be reconsidered.

A rebuildable projection may expose the latest Intent for read convenience, but it does not become
another source of truth.

### 4. Append Intents and globally scan for the latest one

```text
workstream_intent_events
→ latest Intent per Workstream
→ scan every Workstream
```

This is functionally sufficient, but its discovery cost grows with all historical Workstreams.

The operational workset prevents permanently inactive Workstreams from being scanned to find a
small number requiring reconciliation.

### 5. Use `LISTEN/NOTIFY` as the work queue

Rejected because PostgreSQL notifications are not durable. A worker disconnected at commit time
does not receive the notification.

`LISTEN/NOTIFY` is the loop's tick mechanism, while the durable workset preserves the obligation to
reconcile when a tick is lost.

### 6. Introduce a durable message broker

A broker would provide durable delivery but would also require a distributed transaction or an
outbox between PostgreSQL and the broker.

It would model every Intent as a message to process even though reconciliation only needs the
latest desired state for a Workstream. A broker becomes relevant if every occurrence must be
delivered independently; that is not this requirement.

### 7. Create one work item for every Intent

```text
seq 41 → work item
seq 42 → work item
seq 43 → work item
```

Rejected because it forces workers to traverse desired states that may already be obsolete.

Intent history retains all three requests. The single Workstream work row advances to `43`, and
reconciliation determines what must exist from that complete Intent.

### 8. Persist `processed`, `applied_seq` or current-status fields as proof of convergence

Rejected because they describe a successful check in the past.

A resource may disappear immediately after `intent_seq = 43` was applied. The stored field would
remain unchanged while current reality had drifted.

Attempt counts, last errors and verification timestamps may be retained for operations and
diagnostics. They do not determine present convergence.

## Consequences

- Reconciliation attempts may repeat; exactly-once external execution is not assumed.
- Effects must be idempotent/safely repeatable or have explicit unknown-acceptance recovery. ACP
  prompts and context creation are never blindly retried after possible acceptance.
- For each claimed work row, a tick traverses any number of `PASS` results but executes at most one
  action.
- An action schedules the next tick; HOLD retains watch/backoff work without an immediate tick;
  CONVERGED conditionally finalizes without a successor tick.
- Intermediate Intents may never affect execution and may produce no Session.
- One Workstream has at most one coalesced desired-state work row.
- Absence from `workstream_reconciliation_work` records no permanent truth about convergence.
- External watches and bounded resynchronization must be able to place a Workstream back into the
  workset when current reality may have drifted.
- The normative engine contract defines concurrent authoring, claims, effect ownership, retry,
  acquisition and finalization. It preserves newer Intents and same-Intent wakes and prevents late
  effects from reopening retired targets. Its owner API requirements must be demonstrated.
- Operations for which every occurrence matters, such as submitting a prompt, are commands and do
  not use this coalescing mechanism.
- The exact Observation-to-action decision tree is intentionally deferred to a separate normative
  specification.

## Governing specs

- [Reconciliation](../specs/reconciliation/README.md)
- [Engine ownership and recovery](../specs/reconciliation/engine.md)

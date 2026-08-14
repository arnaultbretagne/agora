# ADR 0002 — Intent, Observation, Session and Workstream are distinct

- **Status:** Accepted
- **Date:** 2026-08-13

## Context

Agora must describe three different temporal truths:

- what should exist;
- what exists now;
- what actually happened.

Prompts, harness outputs, saves and runtime details must also be attributable to the execution during
which they were produced.

Using one object for several of these meanings creates ambiguity. Desired configuration can be
mistaken for realized execution, historical state can be mistaken for current reality, and several
independent journals can disagree about ordering.

The domain therefore needs a small set of concepts with explicit and non-overlapping roles.

## Decision

Agora uses four distinct concepts.

### Intent

An `Intent` is a complete expression of what should exist.

It records the desired execution configuration. It does not prove that the requested execution was
ever realized, and it does not describe what currently exists in external systems.

Several Intents may replace one another before any execution occurs.

### Observation

An `Observation` reports what an authoritative external system says exists now.

An Observation is bound to its source and observation time. It is used as current evidence only
while it is fresh.

An Observation may be retained for diagnostics, but a stored Observation becomes historical. Its
presence in the database never proves that the observed state still exists.

### Session

A `Session` logs one execution through facts.

A Session belongs to one Workstream and has its own immutable identity. Its facts record what
actually happened during that execution, including both:

- what was produced, such as protocol exchanges and saves;
- where and under which effective conditions it was produced, such as the resolved execution
  configuration and non-secret runtime identifiers.

A Session is realized history. It is neither desired state nor proof that its runtime still exists.

The same Intent may result in several Sessions when an execution stops and is later realized again.
Conversely, an Intent that is replaced before concrete execution begins produces no Session.

A newly usable execution, or a change to the effective conditions under which work may continue,
creates a new Session even when the underlying infrastructure can be reused. Turning execution off
ends attribution to the current Session; absence is not represented by an `off` Session. Physical
resource identity does not define Session identity.

### Workstream

A `Workstream` orders successive Sessions and their facts.

It provides one canonical ordered fact stream for related work. Facts belonging to an execution
reference its `session_id` and receive their order from the Workstream.

A Session does not own a second journal. Its history is obtained by selecting its facts from the
Workstream stream:

```text
Workstream
──────────────────────────────────────────────────────────────►

  facts for Session S1       facts for Session S2       ...
```

The Workstream is not an Intent, current runtime state or a compaction of Session logs. It preserves
the facts once, in their shared order.

The relationship between the four concepts is:

```text
Intent
  what should exist
       │
       │ may be realized
       ▼
Session
  one execution logged through facts
       │
       ▼
Workstream
  successive Sessions and their ordered facts

Observation
  what authoritative systems report now
```

The central statement of this decision is:

> An Intent states what is wanted. An Observation reports what exists now. A Session logs one
> execution through facts. A Workstream orders successive Sessions and their facts.

## Facts and related records

Session-linked facts capture the realized execution without creating another domain identity for
runtime materialization.

They may contain non-secret correlations such as a Pod UID, process generation, harness context
identifier, resolved artifact digest or policy version. These values explain where an execution
occurred; they do not assert that those resources still exist.

A save is linked to the Session that produced it. If a later Session restores that save, the
restoration is a fact of the later Session referencing the immutable save. The save itself is never
updated with a consumer or `restored_into` relationship.

Protocol and infrastructure identifiers may therefore be recorded as facts, but none of them
replaces the Agora `session_id`.

## Why this choice

It gives each question one place to obtain its answer:

- **Desired state:** read the relevant Intent.
- **Current reality:** perform a fresh Observation.
- **Realized execution:** read the Session facts.
- **Cross-Session history:** read the ordered Workstream stream.
- **Attribution:** follow the `session_id` carried by each execution fact.
- **Runtime provenance:** read the runtime details recorded with the Session facts.

This keeps the domain model small while preserving temporal honesty. Historical evidence remains
auditable without being mistaken for current state, and infrastructure details remain attributable
without becoming additional product identities.

## Options considered

### 1. Store desired configuration on the Session

Rejected because a Session would then mean both what was requested and what actually happened.

An Intent may be replaced without realization, and the same Intent may be realized more than once.
These require separate identities.

### 2. Use the Session as live runtime state

Rejected because persisted runtime status becomes stale as soon as an external system changes
independently.

A Session can prove that an execution existed. Only a fresh Observation can determine whether its
resources still exist.

### 3. Keep one journal per Session and compact them into a Workstream

Rejected because it creates two representations of the same facts and two places that must agree on
ordering.

Facts are appended once to the Workstream stream and grouped by `session_id`.

### 4. Make runtime materialization another domain aggregate

Rejected because it adds a fifth domain concept for information that can be represented by
Session-linked facts.

Operational controllers may keep internal resource records or projections, but those records do not
define realized product history.

### 5. Keep only Workstream facts without Session identity

Rejected because prompts, outputs, saves and runtime details would lack a stable execution boundary.

The Session provides that boundary without introducing another journal.

## Consequences

- Intent, Observation and Session records are never interchangeable.
- A Session exists only for concrete execution history. A request that never reaches execution
  produces none; an execution whose restore or bootstrap fails still has a Session.
- One Intent may result in zero, one or several Sessions.
- Successive Sessions may refer to the same physical resource or to different resources.
- Every execution fact is attributable to exactly one Session and ordered by its Workstream.
- Reading a Session is a filtered view of the canonical Workstream fact stream, not a copied log.
- Runtime details retained as Session facts are historical and must not be used as live proof.
- Saves remain immutable records linked to their producing Session.
- Exact Session boundary rules, fact schemas and Workstream facts used by reconciliation belong in
  normative specifications.
- The reconciliation decision tree is intentionally outside the scope of this ADR.

## Governing specs

- [Glossary](../specs/00-glossary.md)
- [Domain model](../specs/02-domain-model.md)

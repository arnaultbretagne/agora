# ADR 0009 — Postgres stores product facts and opaque custody

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Agora needs durable, ordered product history and resumable harness state. A PVC for each Loge is
operationally heavy, while treating Postgres as a sink for every infrastructure signal would mix
unrelated retention and ownership.

## Decision

One PostgreSQL cluster may physically host three strictly separated schemas:

- `product`: Workstreams, Sessions, commands, journal, grants and Anchors;
- `projection`: rebuildable read models, per-Workstream checkpoints and durable feed positions;
- `custody`: opaque payload snapshots.

Infrastructure logs, metrics, traces, Pod events and Broker audit remain in their dedicated systems.
Ephemeral Broker grant/activation state remains owned by a Broker-private operational store.
Distinct database roles enforce access boundaries within the Agora product cluster.

OneCLI owns a separate operational PostgreSQL database for encrypted provider credentials, policy,
Agents and request audit. Its `/app/data` CA/private-key state and externally supplied encryption key
are backed up with that database. None of these stores or assets belong to Agora's product cluster.

## Alternatives rejected

- **Database per concern immediately:** operational overhead without a current scale/isolation need.
- **Filesystem/PVC product history:** weak transactional ordering and backup coupling.
- **Object storage for all custody immediately:** adds distributed commit complexity for bounded
  snapshots.
- **Postgres for logs:** turns the product application into infrastructure logging machinery.
- **Place OneCLI tables in `product.*`:** couples product backup, schema authority and access roles
  to an adopted component's operational data model.

## Consequences

- SQL constraints encode core identity/order invariants.
- Backup/restore must include product and custody with compatible points.
- Custody growth thresholds must be monitored.
- Moving custody blobs later does not alter the domain contract.
- OneCLI backup/restore is an independent production gate and must preserve database, CA state and
  encryption key as one compatible recovery set.

## Governing specs

- [Journal and projections](../specs/05-journal-and-projections.md)
- [Custody](../specs/07-custody.md)

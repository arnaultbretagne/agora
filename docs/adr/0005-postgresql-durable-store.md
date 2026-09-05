# ADR 0005 — PostgreSQL is Agora's durable store

- **Status:** Accepted
- **Date:** 2026-08-13

## Context

Agora needs durable ordering, constraints and recovery for Intent history, realized execution and
resumable harness context.

Canonical facts, read models and opaque harness state do not have the same meaning or access rules.
Operational telemetry and OneCLI state have different owners again.

## Decision

PostgreSQL is Agora's durable storage technology for product and control-plane records,
projections and Saves.

It preserves distinct meanings and authority boundaries:

- append-only Intent events are the canonical history of what was wanted;
- Workstream facts are the canonical history of what was realized;
- reconciliation work and other operational control records are durable but are not product
  history;
- projections are disposable and rebuildable from those facts;
- Save metadata is product-readable, while Save payload bytes are immutable and opaque.

These boundaries have separate access authority. Their physical database, cluster and schema
layout is an implementation and deployment concern.

Logs, metrics, traces and infrastructure events remain in operational telemetry systems. OneCLI
credentials, Agents, observed effective Agent grants and request audit remain owned by OneCLI.
Neither becomes Agora product history.

## Why this choice

PostgreSQL provides transactional ordering, integrity constraints and established recovery for the
durable state Agora owns.

Logical boundaries preserve meaning and least privilege without fixing a physical topology that may
change independently.

The central statement of this decision is:

> Agora keeps its durable product and control records in PostgreSQL while preserving which records
> are canonical history, operational control, rebuildable projection or opaque payload.

## Options considered

### 1. Runtime files or persistent volumes

Rejected because durable history and continuation would become coupled to runtime storage and
lifecycle.

### 2. A different store for every concern immediately

Rejected because it adds distributed consistency and operational cost before those concerns require
different storage technology.

### 3. Store every operational signal in PostgreSQL

Rejected because telemetry and external-system state would acquire the wrong retention, access and
authority.

## Consequences

- PostgreSQL availability, migration and recovery are production-critical.
- Projections may be dropped and rebuilt without changing history.
- Save access is restricted and core product code never interprets Save payloads.
- Telemetry and OneCLI require their own retention and recovery policies.
- Storage topology may evolve without a new ADR while these authority boundaries remain intact.

## Governing specs

- [Engine persistence and ownership](../specs/reconciliation/engine.md)
- [Canonical facts and projections](../specs/reconciliation/execution.md#acp-facts-and-current-evidence)
- [Custody storage and retention](../specs/reconciliation/continuity.md#storage-and-retention)

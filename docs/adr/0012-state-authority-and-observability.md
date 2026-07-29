# ADR 0012 — State authority and observability are separated

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

Persisted “live” flags drift from real process/Pod state. Conversely, asking the application to store
all runtime logs couples product durability to infrastructure mechanics.

Users still need a coherent view combining durable work and current execution status.

## Decision

State remains with its natural owner:

- product/ACP facts in Postgres;
- live Loge/Pod state in the Loge controller and Kubernetes;
- grant state in the Broker;
- infrastructure logs/metrics/traces in OTel/Loki;
- Web state as a composed read.

Durable Session phase records protocol/product progress, not a cache of Pod liveness. Correlation uses
Session ID and trace context.

## Alternatives rejected

- **Persist a `live` boolean:** becomes stale after crashes/restarts.
- **Infer boot from timeouts only:** guesses rather than reads controller state.
- **Store Pod logs with Workstream events:** exposes content/secrets and overloads product storage.
- **Make the UI query every subsystem directly:** leaks trust boundaries and composition logic.

## Consequences

- Read APIs explicitly distinguish durable and live state.
- Reconciliation is level-based.
- Operators use telemetry stores, while users see safe typed product status.
- Infrastructure outages may degrade live status without corrupting history.

## Governing specs

- [Observability](../specs/12-observability.md)
- [Failure model](../specs/13-failure-and-idempotency.md)

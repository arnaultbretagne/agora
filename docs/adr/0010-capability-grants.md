# ADR 0010 — Independent capability grants replace profiles

- **Status:** Proposed
- **Date:** 2026-07-29

## Context

A fixed profile catalogue encodes combinations of inference, Vault and repository access. Every new
resource doubles possible combinations and freezes arbitrary names into durable history.

The Browser still must not submit raw provider scopes or escalate a Loge.

## Decision

The user requests resource-level equipment intent. A trusted policy service resolves it into
independent capability-grant facts and issues a short-lived Session-bound execution grant.

The Loge controller binds that grant to one Session-specific workload identity; no grant token is
placed in ACP descriptors. The Broker enforces the bound identity and keeps provider credentials
behind isolated adapters. `agent_id` selects Agent invocation authority and is not an equipment
profile.

Changing the capability set creates a new Session.

## Alternatives rejected

- **Enumerate every profile combination:** exponential catalogue and migration burden.
- **Browser submits capability strings:** exposes security implementation and escalation surface.
- **Mutable capability set on a live Session:** makes historical authority ambiguous and complicates
  Loge revocation.
- **Manager owns policy:** mixes Kubernetes mechanism with authorization decisions.

## Consequences

- UI presets may exist but are not durable authorization claims.
- Session capability facts are normalized and auditable.
- Broker lease/authorization code must be refactored away from `profile`.
- Cross-equipment continuity uses Workstream handoff.

## Governing specs

- [Equipment and Broker](../specs/10-equipment-and-broker.md)

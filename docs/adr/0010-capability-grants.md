# ADR 0010 — Independent capability grants replace profiles

- **Status:** Accepted
- **Date:** 2026-07-29

> **Amended by [ADR 0015](0015-onecli-credential-firewall-egress-at-relay.md) (Proposed,
> 2026-08-09).** The capability-grant model, the one-Agent-per-Session mapping and the relay stand.
> What 0015 reverses: OneCLI ≥1.44 removed project-policy authoring and has no network egress deny,
> so the "publishes deterministic first-match rules ... one final explicit `block *`" mechanism below
> does not exist on the supported product. Under 0015, OneCLI selects credentials via **grants** and
> the **relay** is the deny-by-default egress point. Read the two numbered rule items and "OneCLI's
> Default Rule is not used as a general egress deny" as superseded by 0015.

## Context

A fixed profile catalogue encodes combinations of inference, Vault and repository access. Every new
resource doubles possible combinations and freezes arbitrary names into durable history.

The Browser still must not submit raw provider scopes or escalate a Session's runtime authority.

## Decision

The user requests resource-level equipment intent. A trusted policy service resolves it into
independent capability-grant facts and issues a short-lived Session-bound execution grant.

For each grant, the Broker control adapter provisions exactly one selective OneCLI Agent for the
Session and publishes deterministic first-match rules:

1. explicit allows for the Agent runtime and approved capability facts;
2. one final explicit `block *` rule.

OneCLI's Default Rule is not used as a general egress deny.

The Session Runtime controller binds the grant to one Session-specific workload identity. A Broker
access relay authenticates that identity, resolves the Session's private OneCLI upstream bearer and
relays CONNECT traffic opaquely. The relay MUST NOT terminate provider TLS, inspect provider
payloads, inject credentials or implement provider-specific behavior; OneCLI remains the only
credential gateway.

Neither the OneCLI bearer nor an execution-grant token enters the Agent container or ACP
descriptors. Grant expiry/revocation is enforced at the relay and by rotating or deleting the
dedicated OneCLI Agent authority. `agent_id` selects Agent invocation authority and is not an
equipment profile.

Changing the capability set creates a new Session.

## Alternatives rejected

- **Enumerate every profile combination:** exponential catalogue and migration burden.
- **Browser submits capability strings:** exposes security implementation and escalation surface.
- **Mutable capability set on a live Session:** makes historical authority ambiguous and complicates
  runtime-authority revocation.
- **Manager owns policy:** mixes Kubernetes mechanism with authorization decisions.
- **Place the OneCLI `aoc_…` bearer in the Agent Pod:** allows replay from another workload until
  manual rotation and fails the Session/workload binding invariant.
- **Keep Agora provider adapters beside OneCLI:** creates two credential gateways, two policy
  surfaces and ambiguous audit authority.

## Consequences

- UI presets may exist but are not durable authorization claims.
- Session capability facts are normalized and auditable.
- Broker lease/authorization code is implemented as OneCLI control-plane lifecycle plus opaque
  workload-authenticated access, not provider credential handling.
- Cross-equipment continuity uses Workstream handoff.
- Renewal may rotate OneCLI upstream authority but MUST preserve the capability digest and dedicated
  Session mapping.

## Governing specs

- [Equipment and Broker](../specs/10-equipment-and-broker.md)

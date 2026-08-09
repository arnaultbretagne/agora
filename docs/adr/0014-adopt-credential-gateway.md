# ADR 0014 — OneCLI is the only credential gateway

- **Status:** Accepted
- **Date:** 2026-07-29

> **Amended by [ADR 0015](0015-onecli-credential-firewall-egress-at-relay.md) (Proposed,
> 2026-08-09).** OneCLI remains the *only* credential MITM, provider-secret store and injection
> gateway — that decision is unchanged and is why this ADR stands. What 0015 narrows: the Decision's
> bullet "enforce provider-route policy and record gateway request decisions" and the deliverable
> "deterministic OneCLI rule publication with explicit allows followed by `block *`". Route/network
> egress policy is **not** OneCLI's on the supported ≥1.44 product; it is Agora's, enforced at the
> relay. OneCLI's policy role is reduced to per-Agent **credential grants**.

## Context

The former runtime contains custom gateway/MITM, provider-secret storage and credential-injection
code. The mandatory P08 spike deployed self-hosted OneCLI and tested it with the operator's actual
Claude Max and ChatGPT/Codex subscription authentication.

The spike proved:

- both harnesses work through OneCLI without provider credentials in the client container;
- generated CA trust, auth stubs, injection, selective Agent grants and immediate rotation work;
- OneCLI does not install Claude Code/Codex or bind its replayable Agent bearer to a Kubernetes
  workload;
- the built-in Default Rule is not a general egress deny;
- gateway stdout logs query strings, while persisted request telemetry strips them;
- PostgreSQL credentials survive restart with the external encryption key, but `/app/data` loss
  rotates the CA.

OneCLI credential transport remains independent from the ACP adapter that exposes Session, prompt,
updates and resume.

## Decision

Agora adopts self-hosted OneCLI as the **only** component allowed to:

- terminate provider TLS for credential injection;
- store/inject Claude, Codex and tool-provider credentials;
- maintain provider-specific auth stubs and host injection behavior;
- enforce provider-route policy and record gateway request decisions.

The former custom gateway is not ported. Agora does not maintain a parallel provider adapter or
fallback credential path.

`Broker` remains Agora's logical policy and authorization boundary, implemented as:

- equipment-intent resolution into independent capability facts;
- one dedicated selective OneCLI Agent per Agora Session;
- deterministic OneCLI rule publication with explicit allows followed by `block *`;
- execution-grant issuance, expiry, renewal and revocation;
- a workload-authenticated access relay that replaces the private upstream proxy bearer and tunnels
  bytes opaquely to OneCLI.

The relay is explicitly **not** a credential gateway. It cannot terminate provider TLS, inspect
provider request bodies, inject credentials or contain provider-specific code. The OneCLI bearer
stays in Broker-private operational state; the Agent Pod receives only platform workload identity,
a credential-free relay endpoint, CA trust and non-secret auth stubs.

Production container integration uses `@onecli-sh/sdk#getContainerConfig` from the trusted Broker
control adapter. `onecli run` remains a local diagnostic, and `applyContainerConfig` is forbidden in
the controller because it can return `false` without mutating launch arguments and uses shared
host-side temporary paths.

Agent images bake pinned Claude/Codex and ACP-adapter binaries. OneCLI does not own image
construction.

The following are release-blocking requirements, not reasons to build another gateway:

1. fix OneCLI gateway logging so stdout never includes query strings;
2. enforce workload binding/confinement through the opaque relay;
3. force Session Runtime egress through the relay and publish the explicit terminal block;
4. persist and back up OneCLI PostgreSQL, `/app/data` and the external encryption key;
5. prove provider subscription renewal and CA rotation/recovery;
6. fail Session Runtime materialization closed whenever OneCLI policy/configuration is incomplete.

## Alternatives rejected

- **Port the old gateway:** duplicates a capability already proven with real subscriptions.
- **Run both gateways during normal operation:** creates ambiguous credential custody, policy,
  logging and revocation.
- **Put OneCLI's Agent bearer directly in the Agent Pod:** it is replayable, has no native TTL and
  is not workload-bound.
- **Use `onecli run` as the Kubernetes launcher:** requires the harness to be locally installed and
  risks inheriting OneCLI control credentials.
- **Use OneCLI as Agora's Agent protocol:** conflates network credential transport with ACP
  semantics.
- **Rely on OneCLI's Default Rule:** it intentionally permits uncredentialed and recognized LLM
  traffic in cases where Agora requires terminal denial.
- **Fork provider adapters immediately:** expands the adopted component before an evidenced,
  reviewed provider gap exists.

## Consequences

- ADR 0006 and ADR 0010 are accepted with this mapping.
- P08 implements the OneCLI control adapter, workload relay and policy invariants; it does not port
  the former Broker gateway.
- P09/P10 validate ACP and custody through this fixed credential path.
- OneCLI identifiers and operational rows never enter Workstream history.
- A OneCLI upgrade is gated by route-diff, log-redaction, subscription-auth and revocation tests.
- A future replacement of OneCLI requires a superseding ADR and migration/credential-rotation plan.

## Evidence

- [OneCLI spike report](../../apps/broker/ONECLI-SPIKE.md)

## Governing specs

- [Equipment and Broker](../specs/10-equipment-and-broker.md)
- [Security](../specs/11-security.md)

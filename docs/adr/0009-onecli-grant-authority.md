# ADR 0009 — OneCLI is the only external grant authority

- **Status:** Accepted
- **Date:** 2026-08-13
- **Revised:** 2026-09-05 — incarnation fencing and revocation independent of native preservation.

## Context

Every harness image contains the complete supported tool bundle. A hostile process can therefore
invoke any installed MCP server, CLI or executable.

Software presence, file injection and ACP configuration cannot determine whether that process may
access an external service. Provider credentials and revocation must remain outside the Pod and
must have one enforcement authority.

OneCLI provides selective per-Agent grants, credential storage and request-time credential
injection. It does not install harnesses or tools and it is not Agora's semantic protocol.

## Decision

OneCLI is the only system that materializes, changes and revokes external capability grants for an
Agora execution.

Agora policy determines the complete desired grant set. The reconciler converges one selective
OneCLI Agent onto exactly that set using OneCLI grant and ungrant operations, then verifies both
attached and effective grants through OneCLI before work proceeds.

OneCLI alone stores provider credentials and injects them into approved requests. Agora does not
build or retain a parallel credential store, provider adapter or enforceable grant system.

Every supported privileged MCP, CLI and tool operation must reach its external service through
OneCLI under the OneCLI Agent bound to the current Kubernetes execution. Removing its OneCLI grant
must make the operation unusable. An integration that relies on a local credential, privileged
mount, direct provider path or authority that OneCLI cannot grant and revoke is not supported.

The OneCLI Agent is operational runtime state, not a domain identity. It belongs to one Pod
incarnation. It may serve successive Sessions sequentially while that Pod is retained, but it is
never rebound to another Pod or shared across Workstreams. Its grant set is reconciled before the
next Session performs work.

The Pod receives neither OneCLI control authority nor the private upstream proxy credential. A
workload-authenticated Broker relay holds that credential and forces the Pod's external traffic
through its bound OneCLI Agent.

The relay may only narrow transport reachability using a fixed deterministic projection of
OneCLI's observed effective grant set. It cannot authorize an operation, create a capability grant,
inject a provider credential or widen policy independently. A permitted route without a matching
OneCLI grant confers no credential-backed capability.

No provider secret, OneCLI token or renewable execution authority may enter ACP facts, product
projections, persona or skill files, or Saves.

Grant and ungrant are hot reconciliation actions. They do not inherently require a new image or Pod.
They affect subsequent requests; they cannot erase data already returned or retroactively cancel an
operation that has completed.

Shutdown and restriction close affected relay paths and existing tunnels without waiting for ACP,
quiescence or a Save. OneCLI grant and Agent removal are then verified independently. A request
already accepted by an external provider may still complete; Agora records that uncertainty and
does not claim remote rollback. The relay remains an opaque transport, never a provider TLS endpoint
or a parser of request content.

Mutation ownership must be enforced at Broker/runtime boundaries, not only checked before updating
the reconciler's work row. A delayed grant, Agent creation or Pod creation from an obsolete attempt
cannot revive an extinguished incarnation. Where an upstream lacks conditional mutation or
idempotency, its unknown in-flight operation must be resolved or its target retired and fenced
before conflicting work proceeds. The normative engine contract defines this obligation without
assuming that OneCLI implements an Agora epoch parameter.

## Why this choice

One authority gives grant, credential injection, rotation and revocation one observable source of
truth. Installed tools remain harmless without the authority required to perform privileged work.

Keeping credentials outside hostile Pods prevents a model or invoked tool from copying and replaying
them beyond the execution boundary.

The central statement of this decision is:

> Tools are present in the runtime; only a OneCLI grant makes their external authority usable.

## Options considered

### 1. Put provider credentials in Pod files or environment

Rejected because hostile code could read, copy and reuse them independently of later revocation.

### 2. Maintain an Agora credential gateway beside OneCLI

Rejected because it creates two secret stores, two injection paths and two accounts of authority.

### 3. Use MCP descriptors, skills or executable presence as grants

Rejected because each is visible to and controllable by the hostile process. Removing a descriptor
does not prevent direct invocation of an installed executable.

### 4. Make the relay a second capability authority

Rejected because grant state could disagree between the relay and OneCLI. The relay only enforces
transport confinement derived from the OneCLI grant set.

## Consequences

- OneCLI availability and correctness are production-critical for external capabilities.
- A grant change can be reconciled without rebuilding or restarting the Pod.
- Every supported privileged integration must have a complete OneCLI grant and revocation path.
- OneCLI Agent lifecycle, binding, retries and strict in-flight revocation semantics belong in the
  normative security specification.
- The reconciler observes OneCLI for effective authority and never treats a stored Session fact as
  proof that a grant still exists.
- Replacing OneCLI requires a superseding ADR and credential migration and rotation plan.

## Governing specs

- [Owners and isolation](../specs/reconciliation/execution.md#owners-and-isolation)
- [Exact grant evidence](../specs/reconciliation/002_observation.md#exact-grant-comparison)
- [Effect ownership](../specs/reconciliation/engine.md#effect-ownership-and-late-requests)

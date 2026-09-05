# ADR 0007 — Kubernetes is the execution runtime

- **Status:** Accepted
- **Date:** 2026-08-13
- **Revised:** 2026-09-05 — bootstrap admission, hot transitions and context identity.

## Context

Agora must run hostile harness processes with reproducible artifacts, workload identity, resource
limits and network isolation.

Introducing a generic execution-backend model would add selection, compatibility and lifecycle
concepts for an alternative that does not exist.

Kubernetes resources are nevertheless ephemeral infrastructure. They must not become desired
product vocabulary or another durable domain identity.

## Decision

Agora materializes executions in isolated Kubernetes Pods.

Kubernetes is the only execution runtime. Agora defines no `ExecutionBackend` catalogue, selection
policy or public backend identifier.

At most one Pod may perform work or retain external authority for a Workstream at a time. A
predecessor is quiesced and deauthorized before successor work begins. A Pod is never reassigned to
another Workstream and never concurrently carries several Sessions.

Under node partition or forced API deletion, extinction may remain unproved. Runtime control keeps
an operational retirement obligation for that Pod UID until termination or infrastructure fencing
proves it cannot continue work. External access is cut independently; a successor remains gated
while local execution could still overlap. A lease timeout or missing API object is not such proof.

Agora opens a Session when an Intent first acquires a concrete execution boundary.

For a new runtime incarnation, Kubernetes must first establish the Pod. Agora then opens the
Session before native restore, ACP bootstrap or any harness work. The Pod identity and provisioning
outcome become facts of that Session. A provisioning request that never produces a Pod remains a
reconciliation attempt and produces no Session; once the Pod exists, a failed restore or bootstrap
remains recorded in its Session.

The established Pod remains gated until Session creation. Opening the Session permits only
controlled bootstrap attributed to it; user-purpose prompts, tool use and external work remain
gated until their prerequisites are verified. Required grants are reconciled before native/ACP
bootstrap that needs them. A Handoff is an effectful prompt and may begin only after authority,
context creation and the requested model/effort are verified. User-purpose prompts additionally
wait for context synchronization. Creating a Session is therefore distinct from admitting work.

For a retained Pod, Agora first reaches a quiescent boundary and applies and verifies the change.
Any ACP exchange used to perform that transition remains a fact of the previous Session. Once the
new effective execution exists, Agora opens the new Session and switches fact attribution before
accepting subsequent harness work. A transition that has no effect creates no new Session.

New Intent, lost current evidence or detected drift closes prompt admission before a transition.
The control plane serializes that boundary with prompt dispatch and all effective mutations.
Revocation can cut external access immediately; it must not wait for ACP cooperation. Remaining
updates from interrupted work retain their original Session attribution.

A crash during transition leaves work gated. Recovery observes the actual Pod, process, ACP context,
configuration and authority, then completes or abandons the same transition. A recorded successful
check cannot reopen admission. The boundary is committed idempotently only for the still-current
Intent, target incarnation and verified effective conditions.

Every new Pod incarnation therefore starts a new Session. The Pod UID, image digests, workload
identity and other non-secret runtime details are logged as facts of that Session.

A safe change may retain an existing Pod across successive Sessions only at that quiescent
boundary. No Save, restore, ACP resume or refill occurs because the native context remained live.
Reusing physical infrastructure never merges Sessions.

The live context is correlated by Pod UID, harness process generation and ACP context identifier.
Reconnecting to that same live context creates no new execution by itself. Losing the process or
context invalidates its evidence even if the Pod UID is unchanged. The runtime controller must
surface that loss; it cannot silently attach new work to the previous Session.

There is no persisted `Runtime` or `SessionRuntime` entity and no `runtime_id`. Kubernetes owns live
resource state. The reconciler determines current existence and readiness through fresh Kubernetes
Observations; recorded Session facts remain historical provenance only.

The runtime controller materializes a resolved execution. It does not decide Intent, capability
policy or ACP meaning.

## Why this choice

Kubernetes already provides the isolation, scheduling and observation primitives the product needs.
Declaring it directly keeps the architecture honest and avoids a speculative portability layer.

Keeping Kubernetes identity out of the domain preserves the distinction between current
infrastructure and realized Session history.

The central statement of this decision is:

> Executions run in Kubernetes; Pods are observed infrastructure, not product identity.

## Options considered

### 1. Define a generic execution-backend abstraction

Rejected because there is one runtime implementation and no concrete second backend whose needs
could define an honest common contract.

### 2. Persist a Runtime domain entity

Rejected because it would turn ephemeral infrastructure into a second account of execution and
duplicate Session identity.

### 3. Create a new Pod for every Session

Rejected because a Session boundary may be realized by a safe hot change that does not require
physical replacement.

### 4. Reuse Pods across Workstreams

Rejected because it would mix isolation, authority, workspace and native harness context between
unrelated histories.

## Consequences

- Kubernetes is a production dependency rather than an interchangeable adapter.
- Supporting another runtime requires a new architectural decision.
- A Pod may span successive Sessions but never successive Workstreams.
- A new Pod always means a new Session, even when it restores earlier native context.
- Pod lifecycle, specification, naming and health details belong in normative runtime specs.

## Governing specs

- [Execution boundaries](../specs/reconciliation/execution.md)
- [Observable runtime evidence](../specs/reconciliation/002_observation.md)

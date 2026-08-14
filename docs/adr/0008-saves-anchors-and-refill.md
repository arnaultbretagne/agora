# ADR 0008 — Saves, Anchors and refill preserve harness context

- **Status:** Accepted
- **Date:** 2026-08-13

## Context

A Workstream may use the same harness across several Sessions or switch between harnesses.

The Workstream retains product history, but a harness also maintains native context that cannot be
reconstructed exactly from ACP facts. Pods are disposable, while that native context may be useful
after a Pod disappears.

A new Pod is a new realized execution and therefore a new Session. Continuation must not depend on
reusing the identity of the Session that produced the context.

## Decision

Agora uses immutable Saves and monotonic Anchors for durable harness continuation.

A Save is an opaque harness artifact captured during controlled shutdown, after the harness is
quiescent and before its Pod is intentionally deleted. It records:

- its producing Session and harness definition;
- format and compatibility metadata;
- checksum and size;
- the inclusive Workstream synchronization frontier `W` incorporated by the native context under
  the recorded seed and refill policy.

Core product code never interprets Save bytes.

A Save contains no provider credential, OneCLI authority, execution grant, workload credential or
other renewable authority. A later Session obtains fresh authority independently.

Saves are not periodic checkpoints and are not created after every turn or Session. A Session
transition that keeps the live Pod and native context requires no Save and does not advance the
durable Anchor.

Each `(workstream_id, harness_id)` has at most one Anchor. It points to a committed compatible Save
and its watermark never decreases.

The Save is produced by the current Session whose live context is being stopped. Controlled Pod
deletion follows this order:

1. stop accepting new prompts and quiesce the harness;
2. select the represented Workstream watermark;
3. capture and commit the Save;
4. advance the Anchor;
5. revoke the Pod's OneCLI grants and relay binding, then remove its OneCLI Agent;
6. delete the Pod;
7. observe that execution and authority are absent.

This is also how an `off` Intent is realized. Every durable fact produced while extinguishing the
execution remains attributed to the Session being stopped. Agora creates no `off` Session because
absence is not an execution.

If capture fails, the Anchor remains unchanged. A healthy Pod is not intentionally deleted unless
an explicit forced-shutdown policy accepts the loss.

When Kubernetes has established a new Pod, Agora freezes `H` as the Workstream head and opens its
Session before restore, ACP bootstrap or harness work. That cutoff and Session creation are one
ordered operation, so bootstrap and refill facts can never enter their own input range.

Continuation then follows one of these paths:

- With a compatible Anchor, Agora binds fresh authority to the new execution, **restores** its Save,
  initializes ACP, **resumes** the native context with ACP
  `session/resume`, then **refills** the missing Workstream range `(W, H]`.
- Without a compatible Anchor, Agora binds fresh authority to the new execution, initializes a clean
  context with ACP `session/new`, then **cross-seeds** it from `(0, H]`.

An empty range requires no refill or cross-seed.

The terms are distinct:

- **restore** loads opaque Save bytes;
- **resume** is the ACP operation that reopens restored native context;
- **refill** supplies Workstream facts absent since the restored watermark;
- **cross-seed** supplies Workstream context to a fresh harness context.

Refill and cross-seed are Agora operations carried by ordinary ACP `session/prompt` requests. ACP
defines neither operation, nor Saves, Anchors or Workstream watermarks. The selected source range,
rendering-policy version and digest are facts of the new Session.

All ACP envelopes exchanged during either attempt belong to the new Session. Resuming an ACP
context never resurrects the Session that produced the Save.

A permanent restore or ACP-resume failure remains recorded in the Session that attempted it. A
fresh-context fallback opens another Session against a clean runtime, uses ACP `session/new` and
cross-seeds `(0, H]`; it never silently changes continuation mode inside the failed Session.

Any Pod loss without a newly committed Save, whether uncontrolled or explicitly forced after a
capture failure, does not move the Anchor. Recovery starts from the old Anchor and refills `(W, H]`
again.

## Why this choice

An Anchor points only to native context known to have been committed. Opaque Saves preserve
information unavailable in product history, while deterministic refill restores subsequent
product-visible context.

Capturing only before destructive shutdown avoids unnecessary Save churn. Fresh authority on
every new Pod prevents restoration from reviving expired or revoked access.

The central statement of this decision is:

> Before a Pod is intentionally deleted, Agora Saves its native context; a later Session restores
> that Save and refills everything recorded since its Anchor.

## Options considered

### 1. Reuse the previous Session after Pod replacement

Rejected because a Session logs one realized execution. Replacement is a new realization even when
ACP resumes the same native context.

### 2. Save after every turn or Session

Rejected because a Session boundary does not imply impending context loss. It adds storage and
coordination without improving a context retained in a live Pod.

### 3. Reconstruct all context from Workstream history

Rejected because ACP facts cannot reproduce every piece of harness-native state. Cross-seeding
remains the fallback when no compatible Save exists.

### 4. Treat an Anchor as the latest live context

Rejected because live context can disappear before capture. An Anchor is a durable recovery point,
not current-state Observation.

### 5. Restore execution authority from a Save

Rejected because it could revive revoked credentials and couple native context retention to
security authority.

## Consequences

- The latest Anchor may intentionally lag behind live execution.
- An `off` Intent ends the current execution without creating another Session.
- After an uncontrolled loss, native-only state after the Anchor may be lost; retained Workstream
  facts are supplied again by refill.
- Switching back to a harness uses that harness's own Anchor.
- One ACP context identifier may appear across several Agora Sessions and cannot define Session
  identity.
- Refill and cross-seed prompts are inspectable synchronization facts; they do not duplicate their
  source Workstream facts.
- Save compatibility, access, retention, limits and seed rendering belong in normative specs.

## Governing specs

- [Anchors and refill](../specs/06-anchors-and-handoffs.md)
- [Saves](../specs/07-custody.md)

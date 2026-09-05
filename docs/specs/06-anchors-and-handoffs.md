# Anchors, refill and native continuity

## Scope and identities

[ADR 0008](../adr/0008-saves-anchors-and-refill.md) governs durable continuation. An Anchor belongs
to `(workstream_id, harness_id)` and references an immutable Save produced by an earlier Session.
Restoring it always occurs in a new Agora Session on a new Pod. A native ACP context identifier may
be reused by resume; the producing Agora Session never is.

Saves preserve native context. Handoffs supply a deterministic rendering of product facts missing
from that context. Neither makes opaque harness state a second product journal.

## Anchor invariants

- At most one Anchor exists per Workstream and harness.
- Its Save belongs to that Workstream/harness and to its producing Session.
- Only a fully committed, validated Save can advance an Anchor.
- The Anchor and Save have the same inclusive synchronization frontier `W`.
- `W` never decreases and never exceeds the Workstream's committed canonical head.
- Native state retained only in a live Pod is never an Anchor.
- Compatibility and invalidation are checked afresh at use; an older Anchor can become unusable.
  Such a record is retained as provenance, without pretending that it is still resumable.

Anchor publication is a conditional product transaction after Save commit. It verifies provenance,
compatibility, the capture authorization and the expected previous Anchor. A competing or delayed
capture cannot replace a newer Anchor merely because its numeric watermark is equal. A committed
Save that loses publication remains unreferenced and follows retention policy.

The represented frontier is established from the quiescent native context and the recorded seed
policy. Reading the latest journal head is insufficient: queued prompts or concurrently committed
facts may not have reached that context. The driver/control-plane contract must account for every
selected item through `W`; excluded fact kinds are explicit policy exclusions. If only a lower
frontier is provable, record it and do not lower the Anchor. Never claim a greater frontier to make
publication succeed.

## Opening descriptor and cutoff

After Kubernetes establishes the gated Pod, one operation serialized with Workstream appends pins
`H` to the existing canonical head and opens the new Agora Session. This happens before any of
that Session's provisioning, restore, ACP or Handoff facts are appended (spec 03).

The native context's immutable opening descriptor binds:

- origin Agora Session and Pod UID, then verified process generation and ACP context identifier;
- selected Save and its frontier `W`, or a fresh origin with `W = 0`;
- fixed cutoff `H`, with `0 ≤ W ≤ H`;
- the rendering-policy version and, when needed, the opening Handoff command and content digest.

Selecting a Save and assigning an ACP identifier complete the same descriptor idempotently before
use; they cannot silently replace a bound origin. A hot Session transition on the same live context
references this descriptor. It does not sample another `H` or refill its own new Session facts.

The range is always `(W, H]`, never `(W, head at dispatch]`. A context opened on an empty Workstream
has `H = 0` even though its own bootstrap subsequently appends facts. When `W = H`, no Handoff is
sent; the verified context origin is sufficient for opening synchronization.

## Choosing continuation

The Anchor is read for the harness actually established by construction, using the trusted target
registry revision. A compatible, non-invalidated Save selects `RESTORE`; absence or verified
incompatibility selects `START`. Returning A → B → A can restore A's own Anchor. A driver upgrade
checks format, adapter and workspace compatibility instead of assuming every same-harness Save fits.

Restore places and verifies bytes through runtime custody control before ACP opens the context.
Resume binds the restored native context to the new Agora Session. Fresh start opens a clean
context at zero. Configuration and grants are verified before either path sends a Handoff.

A permanent restore/resume failure remains a fact of its attempted Session. The custody owner must
verify and record either artifact corruption or incompatibility of the exact Save/target pair
under spec 07. Runtime control retires the failed incarnation, and the `SESSION` or `CONSTRUCTION`
rule selects cleanup. Only after cleanup can a later rule create a clean Pod and a new Session,
with its own cutoff, to cross-seed. The failed Session never changes from restore to fresh mode.
A transient read failure or ambiguous ACP response cannot invalidate recovery material.

## Handoff representation

One durable command binds the context descriptor, range, rendering-policy version, digest and
standard ACP content blocks. Its product purpose is `handoff`; correctness requires no custom ACP
`_meta`. The stable descriptive resource URI is:

```text
agora://workstreams/{workstream_id}/handoffs/{command_id}
```

The baseline sends the bounded content as a standard embedded resource; the pinned integration must
negotiate support. A resource link alone is not delivery of its contents. ACP defines these content
forms, not Agora watermarks or synchronization proof
([ACP content](https://agentclientprotocol.com/protocol/v1/content)).

The builder folds canonical Workstream facts or uses a projector proven complete through `H`.
It never reads an unversioned Web cache. Committing the Handoff does not append duplicate copies of
its source facts; the product renders one inspectable synchronization item with source references.

## Seed policy and fidelity

The versioned policy specifies inclusion and ordering for user/harness messages, durable outcomes,
thoughts, plans, permission decisions, tool summaries/results, resources and prior synchronization
markers. It excludes transport/bootstrap bookkeeping and expansion of earlier Handoffs as duplicate
history. A selection through `H` is complete only under this declared policy.

Required metadata includes size limits, encoding, deterministic truncation/manifest rules, resource
access requirements, digest and every fidelity reduction. Included resources must remain authorized
and available for the promised retention period. If a required source is unavailable or the input
cannot fit the policy, acquisition/rendering fails visibly; no unrecorded model summary substitutes
for the selected range. A product confirmation required by a specific fidelity policy cannot be
inferred from timeout. It does not block an independently requested shutdown.

The existing `contracts/policies/handoff-seed-v1.md` must be aligned and versioned before enabling
this baseline; this design revision neither inspects nor validates that machine-adjacent contract.
Policy changes do not silently re-seed a live context or rewrite Save metadata.

## Current native proof

A driver-specific, bounded read obtains evidence from the actual current native context. It must
establish the exact opening input by range, policy and digest, and completed incorporation under
the integration's documented turn/continuity semantics. It binds the evidence to the Pod UID,
process generation and native context lineage. This is an integration conformance obligation,
not an ACP method or a generic transcript parser in core.

A URI occurrence alone can be an echo, a partial input or an artifact from another context. An ACP
response or durable command alone proves no current native contents. A native input marker before
completion is not proof that the effectful Handoff finished. Cancellation, failure or partial
acceptance must be classified explicitly and cannot automatically establish synchronization.

Compaction may preserve a verifiable native lineage for the incorporated input; its conformance
contract must specify how. If the driver cannot distinguish incorporation from absence, acquisition
fails and work stays gated. It must not invent `stale` to make another prompt possible.

`observation.sync = current` means that the verified origin has an empty range, or that this exact
non-empty Handoff was incorporated and its continuity remains verifiable. `stale` requires current
proof of absence and that no possibly accepted opening attempt is still unresolved. Prompt receipts
are useful for ambiguity resolution, not substitutes for native proof. Spec 13 forbids blind resend.

This proof covers the declared rendering policy; it does not prove that the model understood the
input, kept every token forever or can reconstruct arbitrary native state. Evidence is invalidated
by process loss, context replacement or a break in verifiable lineage. Mono-active execution alone
does not rule out such drift. A transport reconnect to the same verified context and a hot Agora
Session change do not by themselves require refill.

## Failure and loss exposure

A live context may be synchronized while its durable Anchor is old. A crash restores the old Save
and opens a new range; previously journaled facts retain their original identity. This is a new
native context and a new Handoff delivery scope, not retry of an ambiguous prompt to the old context.
Any external action already triggered by an earlier Handoff remains subject to external-system
idempotency; synchronization is not an exactly-once business transaction.

Shutdown-only Saves provide no fixed maximum native-state loss window. Native-only data since the
last usable Save can disappear. Product history can be rendered again under policy; uncommitted
workspace edits, native reasoning and external side effects cannot be claimed recovered from ACP
facts. The workspace and artifact boundaries are specified in [Saves](07-custody.md).

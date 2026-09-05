# Native continuity

[ADR 0008](../../adr/0008-saves-anchors-and-refill.md) separates native recovery from product history.
A Save is immutable opaque recovery material from a producing Session. An Anchor selects a Save
for `(workstream_id, harness_id)`. A Handoff supplies missing product facts to the native context
under a versioned rendering policy. Neither is a second product journal or a runtime identity.

## Opening descriptor

[Session birth](execution.md#session-birth-and-admission) pins `H` to the canonical Workstream head
before any fact of the new Session. Its native context descriptor binds that originating Session
and Pod UID, then verified process/context, selected Save with inclusive frontier `W` or fresh
origin `W = 0`, and rendering-policy revision. Selecting the Save and binding the actual ACP context
complete the same descriptor idempotently; bound origin values cannot be replaced silently.

The opening range is exactly `(W, H]`, with `0 ≤ W ≤ H`. When non-empty, its stable Handoff command
and content digest complete the descriptor before delivery. The range never reads the journal head
at dispatch and never incorporates its own Session's bootstrap facts. `W = H` requires no empty
prompt: current proof of that native origin suffices. Hot Sessions on the same verified context
reference the original descriptor; they do not choose another cutoff or opening Handoff.

## Saves, capture and workspace

Only the registered custody driver interprets payload bytes. Core reads non-secret metadata:

- Save ID, producing Session, Workstream and harness;
- producing image/registry/driver revisions and format ID/version;
- byte length, checksum, creation time, frontier `W` and seed-policy provenance;
- native-origin correlation and declared immutable workspace/artifact dependencies.

A Save never acquires a mutable consumer or `restored_into` field. Each restore is a fact of its
consuming Session referencing the original Save. Driver continuity evidence is a bounded typed
interface; it gives core no right to inspect native transcripts or payloads.

Capture binds a stable key to the producing Pod/process/context, verified frontier and driver
revision. Repeating it discovers the same Save; another payload/frontier under that key is a
conflict. The driver captures only a quiescent, consistent native/workspace cut under declared size
and time limits. Bytes and metadata become visible atomically after checksum/length verification.
A partial stream is unusable. Capture needs no provider access and cannot delay revocation.

An unverified restore, unsynchronized opening context or unknown lineage is ineligible for Anchor
publication. Failure to establish an eligible cut skips preservation with a typed reason. The
original shutdown budget survives retries and crashes; capture or publication failure never vetoes
termination or requires another forced-loss approval.

Every persistent dependency has an explicit recovery classification:

| Data | Recovery obligation |
|---|---|
| Native harness state | Included in the opaque Save or proved unnecessary for resume |
| Required workspace files | Included in the bundle or referenced by an authorized immutable snapshot with matching revision/checksum |
| Published artifacts | Independently committed and retained, with immutable authorized references where needed |
| Caches and scratch files | Explicitly disposable, with no recovery guarantee |
| Credentials, workload identity, Agent tokens and relay material | Excluded; rematerialized by their authoritative owners |

A Pod-local path or unversioned directory is no durability proof. The driver must demonstrate a
consistent native/workspace cut or reject capture/restore, never pair an old transcript with
arbitrary newer files while claiming exact continuation. This defines a dependency contract, not
a new public workspace aggregate or an unselected snapshot backend.

## Anchors and frontiers

At most one Anchor exists per Workstream/harness. It references a fully committed Save from that
Workstream/harness and carries the same inclusive frontier `W`. Publication is conditional on
capture authority/provenance, compatibility and the expected previous Anchor. Its frontier never
decreases or exceeds the committed canonical head. Equal numeric frontiers cannot let a stale
capture overwrite a newer publication. A committed Save that loses publication remains unreferenced.

The driver/control-plane contract accounts for every policy-selected item through `W` using the
quiescent context. Queued commands or concurrent product facts may not have reached it: copying the
journal head is insufficient. Explicitly excluded fact kinds follow the seed policy. If only a
lower frontier is provable, record it without lowering the Anchor or inventing incorporation.

## Compatibility, restore and fallback

Fresh Anchor/Save metadata is checked against the harness actually observed in construction and
its reviewed target definition. Compatibility covers format, driver, frozen default persona,
workspace dependencies and verified exclusions. A → B → A can restore A's own compatible Anchor;
the change of harness alone says nothing about its existence.

Runtime custody authorizes the Save for this target, validates metadata/dependencies and the clean
native-state location, then streams and verifies bytes before ACP launch. Partial placement is
cleaned or resumed under the same attempt, never over unrelated state. Standard native resume binds
the restored context to the new Agora Session. Config and authority precede any Handoff.

Invalidation is append-only evidence with cause, verifier, target and time. Verified checksum
corruption can exclude an artifact; a permanent format/resume failure may exclude only the exact
Save/driver pair. Temporary unavailability, deadline expiry or an ambiguous response prove neither.
A corrected driver may undergo explicit compatibility validation without erasing prior failure.
Anchor reads retain provenance while excluding known unusable pairs.

Permanent restore failure remains attributed to its attempted Session. Runtime control retires
that incarnation; fresh registered evidence lets the rules select cleanup. Only verified cleanup
allows a new Pod/Session, a new cutoff and fresh-context continuation. There is no restore-to-start
switch inside the failed Session. Unknown new/resume acceptance follows
[engine recovery](engine.md#prompt-delivery-and-context-creation) before another context can do work.

## Handoff and seed policy

One durable `handoff` command binds the descriptor, exact range, policy revision, digest and standard
ACP embedded resource content. Its descriptive URI is
`agora://workstreams/{workstream_id}/handoffs/{command_id}`. The pinned integration must support the
content form; a resource link alone does not deliver bytes. Correctness needs no custom ACP metadata.

Rendering folds canonical facts or uses a projector proved complete through `H`. Source facts keep
their identity; the product synchronization item references them rather than duplicating history.
No unversioned Web cache supplies the range.

Before enablement, a versioned seed policy must specify inclusion/order for messages, durable
outcomes, thoughts, plans, permission decisions, tool summaries/results, resources and prior sync
markers. It excludes transport/bootstrap bookkeeping and recursive expansion of earlier Handoffs.
Pin encoding, size limits, deterministic truncation/manifest rules, resource access requirements
and every fidelity reduction. Required resources must remain authorized and available for the
promised retention. Unavailable sources or an input that cannot satisfy the policy fail visibly;
no unrecorded model summary substitutes for the range. Any confirmation required by that explicit
fidelity policy requires an answer; it cannot block an independently requested shutdown.

This baseline defines the policy's obligations, not a finished renderer or wire schema. Policy
changes never silently re-seed a live context or rewrite Save metadata.

## Current native proof and loss exposure

[Observation](002_observation.md#observationsync) defines `current` and `stale`. For a non-empty
range, the pinned driver must obtain bounded current evidence of the exact input, policy/digest,
completed incorporation and continuing native lineage for this Pod/process/context. An echoed URI,
partial input, recorded command or past ACP success alone proves none of these. Supported compaction
must preserve verifiable lineage; a break invalidates evidence and gates admission.

Cancellation, failed delivery and possible acceptance remain explicit. `stale` requires positive
proof of absence and no unresolved possibly accepted delivery. An ambiguous Handoff cannot be
resent automatically; reproducible command bytes are not a provider idempotency guarantee. A clean
replacement is a new context/delivery scope, while earlier remote effects can remain unknown.

Proof covers the declared rendering policy, not model understanding, permanent token retention or
arbitrary native state reconstruction. A live synchronized context can have an old durable Anchor.
Shutdown-only Saves provide no fixed native recovery point: unsaved native data and workspace edits
can disappear. Product facts and independently durable artifacts remain recoverable under their
policies; they cannot establish recovery of every native detail or exactly-once external effects.

## Storage and retention

[ADR 0005](../../adr/0005-postgresql-durable-store.md) places bounded Save payloads in PostgreSQL
behind a separate custody boundary. Core reads metadata only; custody reads/writes authorized bytes;
Web and Pods have no direct payload-store access. Scoped capture/restore streams, storage roles,
encrypted transport/storage and audited Workstream authorization enforce this separation. Break-glass
access is separately audited. Driver exclusions must be demonstrated; payload bytes never enter logs.

Retain Saves referenced by Anchors or authorized in-flight restores, and the latest successful Save
per retained producing Session under product retention policy. Unreferenced generations and partial
staging have bounded grace periods. Invalidation cannot delete still-required material. Workstream
deletion extinguishes execution before removing its recovery material and dependent private artifacts.
Retain producer definitions needed for running old images and declared compatibility; unsupported
native resume requires explicit fresh-context continuation. Exact retention values, seed policy and
driver/workspace mechanisms remain implementation prerequisites to demonstrate in
[acceptance](acceptance.md), not guarantees supplied by this design text.

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

### Registered driver: `claude-code` (P12)

Format `claude-code-transcript`, version `1`. The measurements this contract rests on were taken
against the pinned adapter and are recorded in `harnesses/claude-code/README.md`; where this
contract makes a choice rather than reporting a measurement, it says so.

**Captured artifact.** Exactly one file: the harness's own JSONL transcript for the context being
captured, at `<harness home>/.claude/projects/<workspace root slug>/<context id>.jsonl`, where the
slug is the workspace root with every character outside `[A-Za-z0-9-]` replaced by `-` and case
preserved (measured against the pinned adapter: `/a/A_b.c-d 1` gives `-a-A-b-c-d-1`; reading it as
"slashes become dashes" points at the wrong directory for any path containing a dot). The harness
home is the container's `HOME`, declared in the harness definition and the one writable path in the
Pod. Nothing else is captured. The file is the whole payload; its
byte length and checksum are the Save's.

**Excluded, always.** Credentials and workload identity under the harness home
(`.claude/.credentials.json` above all), harness settings, caches, any other context's transcript, and every file under the
workspace root. Exclusion is not an optimisation: a Save that carried credentials would move secrets
into a store core can read the metadata of, and a Save that carried arbitrary workspace files would
claim a consistency it cannot verify.

**Quiescent cut.** Capture requires, in order: admission closed for the Session; no prompt turn in
flight and none possibly accepted (an `unknown` dispatch is not quiescence); the context's process
alive at the generation the Save is keyed to; and the transcript file unchanged across two
consecutive reads. A cut that cannot satisfy all four is refused with a typed reason rather than
captured partially — a partial stream is unusable, and a transcript read while a turn is being
written is a partial stream.

**Workspace dependency classification.** This driver captures the conversation, not the workspace.
For the fixed workspace root it therefore declares: no workspace files in the bundle, and no
authorized immutable snapshot reference. A Save whose `workspace_deps` is empty claims exact
continuation of the native context ONLY; any workspace state a restored context expects is either
independently committed (published artifacts) or disposable (caches and scratch). A restore that
needs a versioned workspace dependency this driver did not record is rejected rather than attempted
(`CONT-011`). Extending the driver to reference an immutable snapshot is a change to this contract,
not a driver implementation detail.

**The captured frontier, and who can prove it.** A Save's frontier is the journal position its
context provably holds. The driver proves it from the transcript alone and therefore reports a
conservative floor — for a transcript-based driver, `W = 0`, because a Handoff digest is the only
thing a transcript can be searched for. The **control plane** can prove more, and by provenance
rather than by reading anything: a fact journaled FROM this Session's own ACP stream passed through
this context. So the recorded frontier is raised to the newest such fact, and only from a base the
context is known to hold — an opening range that was empty (vacuously incorporated, `CONT-002`) or a
restore, whose Save carries its own proven frontier. A Session that opened over a non-empty range
that was never established keeps the driver's floor: the gap below its own stream is exactly what
must not be guessed at (`CONT-006`).

This is not cosmetic. Loss exposure counts the facts newer than the anchored frontier, so a frontier
stuck at the floor reports the entire record as possibly lost immediately after a clean shutdown
that captured all of it — a warning that is always on, and therefore says nothing.

**Proving the exact opening input and lineage.** The driver proves incorporation of an opening
descriptor `(W, H]` from the transcript alone:

- an empty range (`W = H`) is vacuously incorporated — there is nothing to incorporate, which is
  why a cross-seeded first Session needs no Handoff;
- a non-empty range is incorporated only when the Handoff command's own recorded digest appears in
  the transcript as a received user message; the digest, not the text, because equal content is not
  equal delivery;
- anything else is **unprovable**, which is distinct from "not incorporated" and never authorises a
  resend. Native compaction or context replacement that removes the evidence makes the range
  unprovable, invalidates the lineage and gates admission (`CONT-006`); it never silently downgrades
  to `stale`.

**Limits (first values; `S11` pins them after the conformance suite proves them on the pinned
infrastructure, as `runtime-settings.json` already does for `P7`).** Maximum captured payload
32 MiB; capture must complete within 10 s of the cut being established; restore placement must
complete within 30 s. Exceeding a limit refuses the capture with a typed reason and, at shutdown,
leaves the previous Anchor in place with loss exposure recorded — it never extends the preservation
budget.

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

**The digest is delivered with the resource, in the same user message.** Incorporation is proven by
finding the command's recorded digest in a received user message (above), and the digest is taken
over the resource's own bytes — so it can never appear inside them. The Handoff turn therefore
carries a plain ACP text block naming the URI and that digest alongside the embedded resource.
Without it the two halves of this contract are individually correct and jointly unsatisfiable: every
driver answers `unprovable`, `observation.sync` stays unavailable, and a Session opened over any
existing history never converges. That was the live behaviour before this sentence existed.

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

### Retention, first values (P14)

Chosen, not derived — recorded here so a sweep can be written against a number instead of a feeling.
Every one of them is a floor on how long something is kept, never a promise that it is deleted the
moment it expires.

| Material | Grace period | Why this one |
|---|---|---|
| A Save under an Anchor | Indefinite, while the Anchor names it | It is the recovery point. Deleting it is deleting the ability to resume. |
| A Save an Anchor no longer names | **14 days** from the moment it stopped being named | Long enough for a human to notice a bad restore and ask for the previous one; short enough that a busy Workstream does not accumulate a month of transcripts. |
| The latest successful Save of a retained producing Session | **14 days** past that Session's own retention | Keeps "what did that Session end with" answerable for as long as the Session itself is. |
| Payload bytes with no Save row | **1 hour** | A capture that never committed its metadata. One hour covers a controller restart mid-shutdown; beyond that it is garbage nobody can identify. |
| A staged placement that never verified | **1 hour** past the Pod's own termination | The Pod that would have placed it is gone; the bytes are still in the store under their Save and lose nothing. |
| An invalidated (Save, driver revision) pair | The Save's own period, unchanged | An invalidation is evidence, not a deletion trigger: a corrected driver revision may still read those bytes (`CONT-008`). |

An invalidation therefore never shortens retention, and a retention sweep never deletes material an
Anchor or an authorized in-flight restore still needs — the two rules together are what stop a
cleanup from quietly removing the recovery point it was meant to tidy around.

**Workstream deletion** extinguishes execution FIRST: Pods and Agents gone, authority revoked,
attribution ended. Only then are Saves, payloads and Anchors removed. Deleting a payload while a Pod
could still be restoring from it would leave that Pod holding native state nothing can account for.

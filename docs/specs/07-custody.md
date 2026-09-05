# Saves and custody

## Purpose and opacity

A Save is immutable recovery material from the verified native context of a producing Session.
It can be restored by a later Session of the same harness under an explicitly compatible driver.
It is neither product history nor an execution identity. [ADR 0008](../adr/0008-saves-anchors-and-refill.md)
and [spec 06](06-anchors-and-handoffs.md) define Anchor and frontier semantics.

Only the pinned custody driver interprets payload bytes. Core sees non-opaque metadata:

- Save ID, producing Session, Workstream and `harness_id`;
- producing image/registry/driver revisions and readable format ID/version;
- byte length, checksum and creation time;
- inclusive frontier `W`, seed-policy provenance and native-context origin correlation;
- the declared workspace/artifact dependency manifest and compatibility metadata.

Even a JSONL native format is stored and transported as opaque bytes. Driver evidence of native
continuity is a separate bounded integration interface; it does not give core access to payloads.
A Save never gains a mutable consumer or `restored_into` field. Each later restore is a fact of its
consuming Session referencing the immutable Save.

## Capture identity and commit

A capture request is bound to the producing Session, live Pod/process/context, frontier and driver
revision. Reusing its stable request ID yields the same Save ID and committed bytes. A different
payload or frontier under that ID is a conflict. Request bookkeeping is operational idempotency,
not evidence that capture finished or that a Pod still exists.

The runtime controller invokes the reviewed driver after the harness, children and native storage
have reached the documented quiescent/consistent boundary. It streams within declared size and
shutdown-time budgets, verifies checksum/length and commits bytes plus metadata atomically. A
reference becomes usable only after complete commit; a truncated stream never becomes a ready Save.

Capture requires no provider request, grant or secret. Revocation and transport closure proceed
independently. The control plane may publish the committed Save to the Anchor only under spec 06's
conditional transaction. A retry after commit discovers that Save; it does not recapture a changed
context under the old request ID.

An unverified restore, unsynchronized opening context or unknown context lineage is ineligible to
replace an Anchor. A shutdown that cannot establish a valid frontier skips capture with a typed
reason. Its old Anchor remains untouched. Saving is best-effort; termination is mandatory after
the fixed budget even when capture or Anchor publication fails.

## Restore and invalidation

Before launching the ACP context, runtime control:

1. authorizes access to the Save for this Workstream and target harness;
2. resolves the pinned producer metadata and target driver compatibility;
3. verifies the dependency manifest and clean target native-state location;
4. streams and verifies size/checksum through a scoped restore channel;
5. places the bytes consistently through the driver and records placement for this target attempt;
6. permits ACP launch only after verification, retaining the new Agora Session attribution.

The Pod can already exist with its controlled launcher waiting; restoring "before ACP launch" does
not require creating the product Session or reading bytes before Kubernetes establishes the Pod.
Partial placement is cleaned or resumed under the same attempt. Existing unrelated native state is
never overwritten, and an unknown resume cannot be followed by an unrelated `session/new`.

Invalidation is append-only metadata with cause, verifier, affected format/driver target and time.
Checksum corruption can invalidate the artifact; a rejected resume format can exclude just that
Save/target pair. Unavailability, deadline expiry or uncertain transport alone do neither. The
original Save and Anchor are not rewritten; reads consider the current verified exclusions.
A corrected driver revision may pass a new explicit compatibility validation, without erasing the
prior failure. Repeatedly selecting a pair already proven incompatible is forbidden.

## Native state, workspace and artifacts

A Save is not a snapshot of the entire container filesystem. Each reviewed harness definition
must classify every persistent dependency:

| Data | Durability and recovery contract |
|---|---|
| Native harness state | Included in the opaque Save or explicitly unnecessary for resume |
| Workspace files needed to interpret native context | Included in the driver bundle, or referenced by an immutable authorized workspace snapshot with matching revision/checksum |
| Published artifacts | Independently committed and retained; Save metadata references authorized immutable artifacts when needed |
| Ephemeral caches and scratch files | Explicitly disposable; no recovery guarantee |
| Credentials, workload identity, Agent tokens, relay material | Excluded and freshly materialized by their owners |

A reference to an unversioned directory or a Pod-local path does not establish durability. A driver
must demonstrate a consistent native/workspace cut or reject capture/restore; it cannot combine an
old transcript with arbitrary newer files while claiming exact native continuation. This obligation
does not add a public workspace domain identity or presume a storage backend beyond the reviewed
mount/snapshot contract.

After loss, only committed Saves, retained product facts and independently durable artifacts are
recoverable under their policies. Shutdown-only capture has no fixed recovery-point objective for
native state or unsaved workspace edits. A future periodic checkpoint guarantee needs an explicit
ADR amendment, storage budget and consistency contract.

## Storage and access

The baseline stores bounded payloads in PostgreSQL under a separate custody boundary, as selected
by ADR 0005. Payload and metadata become visible in one commit. The repository interface remains
blob-backend-neutral; changing physical storage requires a separate decision when justified by
measured sizes/throughput, without changing Save identity or Anchor semantics.

The control plane reads metadata only; the runtime custody service reads/writes authorized payloads;
Web has no payload access. Pods receive scoped restore/capture streams and no database credentials.
Database roles and separate relations or explicit column grants enforce the separation. Operators
have audited break-glass access only. Existing SQL/API schemas require alignment before implementation.

Payloads can contain sensitive prompts, paths and results: encrypt storage/transport, authorize and
audit reads, never log bytes, and apply Workstream deletion and retention policy. Drivers explicitly
exclude credential paths. OneCLI trust roots and non-secret stubs are rematerialized from trusted
deployment state. A claimed exclusion requires tests against the pinned harness bundle.

## Retention and compatibility

Every Save still referenced by an Anchor or an in-flight authorized restore is retained. The latest
successful Save per retained producing Session is retained according to product retention policy;
unreferenced prior generations and partial staging data have bounded grace periods. Invalidation
does not permit deleting an object while retained references still require it. Workstream deletion
first extinguishes execution, then removes its recovery material and dependent private artifacts.

Registry upgrades retain enough producer metadata to capture a running old image and enough driver
support to read its declared compatible Saves. Otherwise they explicitly choose a new Session
cross-seeded from product history. No upgrade may claim successful resume after silently dropping
native/workspace dependencies. Conformance scenarios belong in [spec 15](15-acceptance-and-migration.md).

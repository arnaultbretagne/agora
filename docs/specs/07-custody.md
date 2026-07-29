# Custody

## Purpose

Custody preserves the harness state required to resume one ACP Session after its Loge Pod is gone.
It is not product history, ACP replay, an observability sink or a portable cross-Agent format.

## Opacity

Only the Session's custody driver may interpret payload bytes. Core services treat:

- format ID;
- format version;
- adapter version;
- byte length;
- checksum;
- watermark;
- creation time

as metadata and treat the payload as an opaque byte stream.

Even when the payload is JSONL, it MUST be stored as bytes and MUST NOT be queried as JSON.

## Snapshot identity

Snapshots are immutable and append-only:

```text
(session_id, generation) -> snapshot_id
(session_id, capture_request_id) -> same snapshot_id on retry
```

Generation is monotonically increasing per Session. A committed snapshot cannot be overwritten.

## Capture contract

The Loge controller calls the registered driver:

```ts
capture(source: HarnessHome): AsyncIterable<Uint8Array>
```

Capture MUST:

1. operate on a quiescent or driver-consistent harness state;
2. stream with a configured maximum size and timeout;
3. calculate SHA-256 while streaming;
4. write payload and metadata atomically;
5. expose the row only after complete commit;
6. bind the caller's capture request ID to that generation;
7. return a reference, never the payload, to the control plane.

A capture error leaves no ready partial snapshot.

## Restore contract

Before Pod startup, the controller:

1. checks snapshot Session ownership;
2. resolves the pinned Agent runtime definition;
3. validates format/adapter compatibility;
4. streams bytes while verifying size and checksum;
5. calls the custody driver's `restore`;
6. prevents overwrite of unexpected pre-existing native state;
7. starts the ACP Agent only after restore succeeds.

Restore failure prevents Pod readiness and is reported with a typed reason.

## Storage

The baseline stores payloads in Postgres `bytea` under the `custody` schema because:

- expected native transcripts/bundles are bounded;
- transactional metadata and bytes simplify atomicity;
- TOAST handles compression/out-of-line storage;
- a dedicated PVC is unnecessary.

The repository interface MUST remain blob-backend-neutral. A size/throughput threshold may trigger a
future object-store ADR without changing Session or Anchor semantics.

## Access control

- `control-plane`: metadata `SELECT`, no payload access;
- `loge-controller`: payload read/write for authorized Sessions;
- `web`: no custody access;
- `loge`: no database credentials; bytes enter through one-time restore/capture streams;
- operators: audited break-glass access only.

Database grants MUST enforce these rules independently of application code.

## Confidentiality

Custody may contain prompts, tool results, file paths or harness metadata. It MUST:

- use encrypted storage and encrypted transport;
- never contain active Broker leases, OneCLI control/upstream authority, generated auth stubs or
  provider secrets by design;
- never be logged;
- have payload reads audited;
- follow Workstream deletion and retention policy.

The custody driver MUST explicitly exclude known credential paths.
The OneCLI CA and non-secret runtime stubs are rematerialized from trusted deployment state rather
than captured.

## Retention

- Every snapshot referenced by an Anchor is retained.
- The newest successful snapshot per non-deleted Session is retained.
- A small configurable number of unreferenced prior generations MAY be retained for rollback.
- Partial, invalid and unreferenced snapshots are garbage-collected after a grace period.
- Deleting a Workstream eventually deletes all of its custody after runtime cleanup.

## Compatibility

An Agent runtime definition declares readable and writable custody formats. An upgrade that cannot
read an existing anchored format MUST either:

- keep the old adapter available for restore and migration;
- require a new Session seeded from product history.

It MUST NOT pretend native resume succeeded.

# @agora/acp

ACP capture seam, bridge client and command dispatch for Agora (slice S4).

## SDK pin (P3)

- **Pinned:** `@agentclientprotocol/sdk` **1.4.0** (protocol version `1`, stable). The archived
  spike measured 1.3.0; this pin was re-verified against 1.4.0 before any code was written.
- **`x-method` method definitions in the pinned schema:** **74** (unchanged from 1.3.0), every one
  classifiable by the `Request`/`Response`/`Notification` name suffix.
- **`SessionUpdate` discriminator variants:** **15** — the 13 known at 1.3.0 plus
  `compaction_update` and `compaction_summary_chunk`. `validate.ts` derives this list from the
  pinned schema at runtime instead of hard-coding it, so a future variant is an `unknown`-bucket
  item, never a silent drop.
- **`allowBatches`:** supported by the SDK's JSON-RPC connection and **defaults to `true`**; the
  high-level app builder does not expose the flag, so batch rejection is enforced at the capture
  seam itself: a batch frame never becomes a fact and yields a content-free diagnostic
  (`error_class=batch`). Stable v1 rejects batches.

## The capture seam

The persisted canonical value is the **raw NDJSON frame text bound as `$n::jsonb`**
(findings §1): `JSON.parse` rounds `9007199254740993` to `…992` and the SDK's generated parsers
strip unknown members, so the canonical path never round-trips a frame through a JavaScript object.
Validation parses losslessly (`lossless.ts`, integers preserved as strings) and feeds **validation
only**; reads that need fidelity select `payload::text`.

Every complete frame is committed (validated + inserted as an `acp.envelope` fact) **before** it is
forwarded — outbound before the transport write, inbound before SDK handling. A database failure
stalls the stream (backpressure); it never drops or forwards a frame.

## Frame rules (P4, recorded in execution.md)

- Frame ceiling: **32 MiB** per NDJSON frame (no newline inside that budget → connection failed
  closed, never grown further).
- Frames are UTF-8 text containing **exactly one** JSON value; trailing whitespace only.
- The development bridge authenticates the client with a shared secret (S4 only; S8 replaces it
  with incarnation credentials).

## Local development harness

`dev-harness.ts` spawns an in-process fake ACP Agent (built on the pinned SDK) behind an
in-memory duplex pair, so tests and local development exercise the full capture → persist →
project path without Kubernetes or provider credentials. Point `AGORA_ACP_BRIDGE_URL` at a local
bridge to run the real adapter instead; the client authenticates with `AGORA_ACP_BRIDGE_TOKEN`.

```sh
npm run dev:harness   # from apps/control-plane: API + worker + fake agent on an in-memory pair
```

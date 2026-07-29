# ACP wire journal spike

- **Status:** passed with required design corrections
- **Date:** 2026-07-29
- **ACP SDK:** `@agentclientprotocol/sdk@1.3.0`
- **Protocol:** stable ACP v1 (`PROTOCOL_VERSION = 1`)

## Question

Can Agora persist the exact ACP message model without defining a parallel local model, while
committing every accepted envelope before dispatch or handler execution?

“Exact” means semantic JSON identity: every member and value that crossed the ACP wire survives.
JSON whitespace, object-key order and the NDJSON delimiter are not protocol semantics.

## Harness

[`spike/wire-journal.mjs`](spike/wire-journal.mjs) connects the official high-level ACP Client and
Agent APIs through real byte streams and the official `ndJsonStream`.

The observation seam frames NDJSON immediately below `ndJsonStream`:

```text
outbound SDK object
  -> official JSON.stringify
  -> raw-frame durable append
  -> bridge write

bridge read
  -> raw-frame durable append
  -> official JSON.parse / typed routing
  -> Agora handler
```

The spike derives method validators from the pinned official schema's `x-method` and `x-side`
metadata. It does not copy an ACP request, response, update or content type.

## Results

| Gate | Result | Evidence |
|---|---|---|
| Outbound commit precedes Agent handling | pass | prompt frame commit is ordered before the fake Agent prompt handler |
| Inbound commit precedes Client handling | pass | update frame commit is ordered before the Client update handler |
| Both JSON-RPC directions | pass | prompt request/response plus Agent-to-Client permission request/response |
| Response correlation without payload mutation | pass | direction-aware pending-request map recovers the method from JSON-RPC ID |
| Command correlation | pass | `AsyncLocalStorage` context reaches the serialized outbound frame |
| Unknown ordinary members | pass at raw seam | nested and top-level members survive although the SDK's typed parser strips them |
| ACP `_meta` | pass | nested `_meta` survives raw storage and typed SDK parsing |
| Standard extension method | pass | `vendor/example` is accepted as an ACP extension notification |
| Unknown `SessionUpdate` discriminator under v1 | rejected as required | raw frame is observed; method-specific v1 validation and the SDK reject it |
| JSON-RPC batch under stable v1 | rejected as required | raw frame is observed before the high-level SDK closes; stable ACP sets `allowBatches: false` |
| Split byte chunks/backpressure seam | pass | one frame split across transport chunks is committed before SDK parsing |
| ACP `uint64` beyond JavaScript's safe range | raw seam pass, object seam fail | `9007199254740993` survives the raw frame; `JSON.parse` changes it to `9007199254740992` |
| PostgreSQL 17 `jsonb` numeric retention | pass | direct raw-text cast and text extraction return `9007199254740993` |

The pinned schema exposes 74 method-specific request, response and notification definitions and 13
stable `SessionUpdate` variants. The spike discovers those definitions from the package rather than
maintaining another list of message shapes. It asserts the 13 discriminators so an SDK/schema
upgrade changes the test visibly.

## Important findings

### Capture must be below `ndJsonStream`

Capturing the SDK object is not complete:

- generated Zod objects strip unknown ordinary members;
- JavaScript `JSON.parse` cannot represent all ACP `uint64` values exactly.

The canonical insert therefore receives the complete raw JSON frame and binds it directly as
`$n::jsonb`. Application code MUST NOT perform `JSON.parse` followed by `JSON.stringify` before the
insert.

PostgreSQL `jsonb` preserves the numeric value but canonicalizes lexical representation and object
key order. That matches the selected semantic-identity contract. If byte-for-byte transport audit
ever becomes a requirement, it needs a separate restricted raw-byte store and a new decision; it
must not silently turn the product journal into infrastructure packet capture.

Reads that require canonical fidelity MUST request `envelope::text` or configure the PostgreSQL
driver to return JSONB as text. The default JavaScript JSONB parser would reproduce the same
large-integer loss on read.

### The root ACP JSON Schema is not a sufficient validator

The official root schema permits arbitrary extension notifications. Because method and parameter
shape are not tied together at that root, an invalid future discriminator sent under the standard
`session/update` method passes the root schema through `ExtNotification`.

Validation must dispatch by:

- JSON-RPC kind;
- direction/receiving side;
- standard method;
- correlated request method for responses.

It then applies the matching official method definition. An unrecognized method remains a valid ACP
extension. A recognized method with the wrong body or direction is a protocol error, not an
extension.

### “Future ACP” does not mean “valid stable ACP v1”

Stable v1 accepts `_meta`, additional schema-permitted members and extension methods. It does not
accept a new discriminator inside the v1 `SessionUpdate` union. Such a frame is retained by this
spike only as rejection evidence; production MUST record a content-free protocol-failure signal and
MUST NOT append it as a canonical Workstream event.

When a later negotiated ACP version officially admits a variant, the raw `jsonb` storage needs no
shape migration. The pinned validator/projector version does.

## Production decision

Agora does not replicate the ACP message model in SQL, JSON Schema or local TypeScript unions.

`product.workstream_events.envelope jsonb` remains the canonical payload, with only Agora indexing
and causation metadata beside it. The implementation contract is:

1. frame one complete inbound or outbound JSON object at the authenticated transport seam;
2. enforce UTF-8, frame-size, JSON-object and stable-v1 no-batch rules;
3. validate standard methods with validators generated from the pinned official schema;
4. insert the original JSON text directly into `jsonb` in the same transaction as sequence,
   command-state and outbox changes;
5. only after commit, forward outbound bytes or enqueue inbound bytes to the official SDK;
6. project from canonical rows using official ACP discriminators, while retaining the complete
   envelope as the source of truth.

Invalid frames never enter `product.workstream_events`. Operational telemetry may retain only safe
diagnostics such as protocol version, direction, error class, byte count and a digest; it must not
become a second content journal.

JSON-RPC IDs remain unmodified in the payload. Agora uses string IDs for the requests it originates.
The official TypeScript SDK cannot faithfully echo an inbound numeric ID outside JavaScript's safe
integer range; adapters must reject that case or an upstream SDK fix is required.

## Commands and observed output

```sh
npm exec --yes --package=node@22 -- node --version
# v22.23.1

npm exec --yes --package=node@22 -- node packages/acp/spike/wire-journal.mjs
# protocolVersion: 1
# officialMethodSchemas: 74
# rootSchemaAcceptsKnownMethodCollision: true
# methodDispatchedValidationRequired: true
# objectLevelCaptureLossyForUint64: true
# rawFrameCaptureRetainsUint64Lexeme: true
# persistBeforeDispatch: true
# persistBeforeHandling: true
```

The PostgreSQL gate ran in an ephemeral `postgres:17-alpine` container (observed image digest
`sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`) using:

```sh
psql --set=ON_ERROR_STOP=1 --file=packages/acp/spike/jsonb-uint64.sql
```

Observed result: PostgreSQL returned `9007199254740993` unchanged.

## Remaining implementation gates

- Run this harness against the production authenticated ACP bridge, not only in-memory streams.
- Exercise every standard v1 method used by Agora and compare generated method routing with the SDK.
- Add a real PostgreSQL repository test proving raw-text insert and `envelope::text` readback through
  the selected Node driver.
- Keep protocol-rejection content out of application logs and product tables.
- Re-run the spike whenever the ACP SDK/schema pin changes.

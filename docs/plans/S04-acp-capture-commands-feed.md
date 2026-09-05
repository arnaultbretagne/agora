# S4 — ACP capture seam, bridge client, commands and feed

- **Status:** planned
- **Depends on:** S3
- **Produces:** `packages/acp`, ACP fact kinds, `command_dispatches`, message/turn projectors, the resumable feed, a local development harness, web plumbing part 2
- **Master plan:** [S4](../master-plan.md#s4--acp-capture-seam-bridge-client-commands-and-feed)

## Goal

Every complete ACP envelope becomes a Session fact losslessly, in both directions, committed before
transport write or semantic handling. Prompts are commands with a durable dispatch reservation and
an honest unknown-delivery state. Readable items are deterministic projections streamed to the
browser. This slice runs against a **local** harness process, not Kubernetes.

## Read first

1. [ADR 0004](../adr/0004-acp-boundary-and-session-facts.md) in full
2. [execution: ACP facts and current evidence](../specs/reconciliation/execution.md#acp-facts-and-current-evidence)
3. [engine: Prompt delivery and context creation](../specs/reconciliation/engine.md#prompt-delivery-and-context-creation)
4. [execution: Session birth and admission](../specs/reconciliation/execution.md#session-birth-and-admission) (one turn in flight; queued command revalidated at dispatch)
5. [acceptance: Validation boundary](../specs/reconciliation/acceptance.md#validation-boundary), `SESSION-A05`, `CONT-005`
6. Field findings [§1 ACP capture and validation](../field-findings.md#1-acp-capture-and-validation-slice-s4) **in full**, [§2.4 second prompt](../field-findings.md#24-a-second-prompt-during-a-running-turn), [§6](../field-findings.md#6-methodological-lessons), [§7](../field-findings.md#7-reuse-register)

## Before coding

- **P3, SDK pin.** Check the current stable `@agentclientprotocol/sdk` (1.3.0 was tested). Re-run
  the archived wire-journal spike logic against the chosen version before writing code: number of
  `x-method` definitions, the `SessionUpdate` discriminator list, `allowBatches`. Record the pin and
  the counts in `packages/acp/README.md`.
- **P4, bridge authentication and frame limits.** The bridge is an authenticated WebSocket
  carrying NDJSON. Decide and record in `execution.md` (*ACP facts and current evidence*): the
  frame ceiling (32 MiB was chosen before; keep or justify), the UTF-8 and single-object rules, and
  how the client authenticates to a local development bridge (a shared secret is acceptable for S4
  only; S8 replaces it with incarnation credentials).
- Register the ACP fact kind: `acp.envelope` with metadata `direction`, `rpc_kind`, `method`,
  `correlated_method`, `rpc_id`, `command_id`, `connection_id`, `observation_id`. Content equality
  is never a deduplication key; `observation_id` is the stable occurrence identity.
- A choice to make explicit in the PR: the persisted value is the **raw frame text bound as
  `$n::jsonb`** (findings §1). Never `JSON.parse` → `JSON.stringify` on the canonical path.

## Deliverables

```text
contracts/db/schema.sql          "S4 canonical history — ACP envelopes" (columns beside payload), "S4 operational — command_dispatches", "S4 projections — items, turns, feed_events"
contracts/schemas/fact-kinds.json  + acp.envelope
contracts/api/control-plane.openapi.yaml  + prompts, cancel, permissions, feed
packages/acp/
  src/framing.ts                 NDJSON frame buffer with ceiling and incremental scan (reuse)
  src/lossless.ts                lossless parse for validation only (integers as bigint/string); never used to reserialize
  src/classify.ts                JSON-RPC kind (reuse)
  src/validate.ts                per-kind/direction/method validators compiled from the pinned schema's x-method/x-side
  src/capture.ts                 journalDuplexStream(inner, persist): commit-before-forward both ways (reuse)
  src/persist.ts                 persist = validate → append acp.envelope fact (raw text) in one tx with dispatch state
  src/bridge-client.ts           WebSocket → DuplexByteStream; reconnect surfaces as connection loss, never silent
  src/client.ts                  ACP Client (SDK) over the journaled stream; Client callbacks (permissions, fs, terminal) confined and projected
  src/commands.ts                reserveDispatch, markDispatched, markResponded, markUnknown
  src/diagnostics.ts             invalid frame → direction, error class, size, digest; no content
  src/dev-harness.ts             spawn a local adapter (or the SDK fake agent) behind a local bridge for tests and development
packages/projections/src/acp/*.ts   messages, thoughts, tool calls, plans, permission interactions, prompt turns, unknown-item bucket
apps/control-plane/src/http/…    prompt, cancel, permission decision, feed (SSE over fetch)
apps/web/src/client/api.ts, app.ts   conversation view on the new feed (web plumbing part 2)
```

## Work plan

### Step 1 — Framing, lossless validation, classification

Carry `journaling-stream.ts` and `frame-bounds.test.ts` over (findings §7). Add `lossless.ts`
using a lossless JSON parser configured to keep integers exact; it feeds **validation only**. Carry
the validator derivation from the archived `wire-journal.mjs`: dispatch by kind, direction/side,
method, correlated request method; unknown method = extension (valid); known method with wrong body
or direction = protocol error; batch = rejected; unsafe numeric inbound `id` = rejected with a
diagnostic (findings §1).

Acceptance: the archived spike's gates as unit tests, including `9007199254740993` surviving to
the persisted text; the ceiling and reassembly tests by falsification; the discriminator list
asserted against the pinned schema.

### Step 2 — Schema and persistence

`workstream_facts.payload` holds the envelope; add nullable indexed columns for the ACP metadata
listed above (they are indexing metadata, not a second model). `command_dispatches (id uuid pk,
workstream_id, session_id, kind prompt|cancel|handoff, request jsonb, state reserved|dispatched|
responded|unknown|rejected_before_acceptance, request_key unique per workstream, reserved_at,
dispatched_at, settled_at, linked_predecessor uuid null)`.

`persist(direction, text)` runs in one transaction: validate (Step 1), `appendFact` with the raw
text as `$n::jsonb`, update the correlated dispatch state, commit. Only then the frame is
forwarded. A database failure applies backpressure (the stream stalls) and never drops or forwards
the frame. Reads that need fidelity select `payload::text`.

Acceptance: a real PostgreSQL test proves raw-text insert and `::text` readback of the large
integer; two identical envelopes produce two facts; an invalid frame produces a diagnostic row and
no fact; outbound commit is ordered before the transport write (spy on the inner writable).

### Step 3 — ACP Client over the bridge

`bridge-client.ts` opens the WebSocket with the S4 development credential and exposes a
`DuplexByteStream`. `client.ts` builds the SDK `client()` on `journalDuplexStream(bridge, persist)`.
Implement Client callbacks minimally and safely: `session/request_permission` becomes a projected
permission interaction that waits for a decision from the API (Step 5); `fs`/`terminal`
capabilities are advertised **false** in S4. Connection loss is surfaced as an event with the
`connection_id`; late frames from an old connection keep their attribution (`SESSION-A05`).

Acceptance: against `dev-harness.ts` (SDK fake agent first, then the real `claude-agent-acp`
adapter if credentials are available locally), `initialize` → `session/new` → `session/prompt`
round-trips with every envelope captured in order; a frame arriving after the connection was
replaced is attributed to the old `connection_id`.

### Step 4 — Commands and unknown delivery

`POST /v1/workstreams/{id}/prompt` with `Idempotency-Key`: revalidate the current Session and that
no turn is in flight (at most one per Workstream; findings §2.4 is why), insert the dispatch
`reserved` in the same transaction as the check, commit, then send. The outbound envelope's fact
carries `command_id`. Response → `responded`. Crash or connection loss between `dispatched` and a
response → `unknown`, exposed on the feed as `prompt_delivery_unknown`; the next turn is gated
until S8's recovery resolves it. A user retry is a **new** command linked to its predecessor and is
refused while the predecessor is unresolved.

Acceptance: `CONT-005` shape for prompts (lost response → `unknown`, no automatic resend on
reconnect); a second prompt during a running turn is rejected 409, never sent; replay of the same
key returns the same command.

### Step 5 — Projections and feed

Projectors from `acp.envelope` facts using official ACP discriminators only: assembled messages,
thoughts, tool calls with current state, plans, permission interactions (request + decision),
prompt turns (running/completed/cancelled/failed with stop reason and usage), and an `unknown`
generic item for accepted-but-unmodeled envelopes. Item identity is a name-based UUID of
`(session_id, kind, entity_key)` so rebuilds reproduce ids (findings §7). `feed_events` is an
append-only per-Workstream position stream of `upsert|remove|status|reset` that a rebuild never
truncates. `GET /v1/workstreams/{id}/feed?after=N` streams SSE over a plain response so the
browser can send its principal header (the carried-over client already reads SSE over `fetch`).

Acceptance: rebuild equals incremental (hash) on a recorded real transcript; the `unknown` bucket
receives a synthetic extension notification; feed resumes from `after` without gaps.

### Step 6 — Web plumbing, part 2

Replace the conversation part of `api.ts` (`listItems`, `listTurns`, `subscribeFeed`,
`promptSession`, `cancel…`, permission decisions) with the new endpoints; keep the view-model tests
green by adapting fixtures to the new item shapes. Sessions are read, never "activated" from the
browser: remove the imperative lifecycle calls from `app.ts` (they have no server side) and show
the Intent-driven status instead.

## Reuse

Allowed (findings §7): `journaling-stream.ts`, `frame-bounds.test.ts`, `classify.ts`, validator
derivation from `wire-journal.mjs`, projector identity/hash helpers. Forbidden: archived
`coordinator.ts` (bootstrap/phase logic), `prompt-queue.ts`, `store-persist.ts` outbox coupling.

## Definition of done

- [ ] Capture below the SDK in both directions; commit precedes forward; lossless integers proven on PostgreSQL.
- [ ] Method-dispatched validation from the pinned schema; batches, unknown v1 discriminators and unsafe ids rejected with content-free diagnostics.
- [ ] `command_dispatches` with reservation before send and `unknown` on lost response; one turn in flight enforced server-side.
- [ ] Projectors deterministic and rebuildable; feed resumable; `SESSION-A05` and `CONT-005` (prompt) as named tests.
- [ ] Local development harness documented in `packages/acp/README.md` with the SDK pin and schema counts.
- [ ] Browser shows a live conversation against the local harness.
- [ ] `execution.md` records P4 decisions; master plan S4 marked done.

## Report

Give the SDK version pinned, the schema counts, which adapter the end-to-end test used, and list
what recovery is still deferred to S8 (reconnect-and-discover for `unknown`).

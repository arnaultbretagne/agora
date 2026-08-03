# Journal and projections

## Canonical record

`product.workstream_events` is the canonical record of ACP interaction visible to the product. Each
row stores the complete ACP JSON-RPC envelope and belongs to exactly one Session and Workstream.

The journal is append-only. Corrections are represented by later events or projection rebuilds, not
by rewriting envelopes.

“Complete” means every JSON member and value is retained, including unknown `_meta`; Postgres may
canonicalize JSON object key order because lexical byte identity is not an ACP semantic.

## Durable commands

Externally retried product actions are first represented in `product.commands`.

A command contains:

- Agora command ID;
- Workstream and optional Session;
- caller idempotency key;
- authenticated `human | service | system` actor;
- command type and purpose;
- request body;
- optional handoff source range;
- dispatch/completion state;
- timestamps and typed terminal error.

A command may be accepted before its Session is ready. Immediately before an outbound ACP
operation, the exact envelope, the command's dispatch-state transition and its journal-outbox row
MUST commit in one transaction before network dispatch. A dispatcher may retry only according to the
operation's ACP safety classification.

## Ordering

Appending an event MUST:

1. lock the owning Workstream row;
2. increment `last_event_seq`;
3. increment the Session's `last_event_seq`;
4. insert the event with both allocated positions;
5. insert one `product.journal_outbox` row referencing the event;
6. commit once.

This gives:

- gap-free order per Workstream;
- gap-free order per Session;
- stable pagination after process restarts;
- a single order across Agent switches.

Timestamps are descriptive only and MUST NOT decide ordering.

## Event shape

Indexed columns include:

- `workstream_id`, `workstream_seq`;
- `session_id`, `session_seq`;
- `direction`;
- JSON-RPC kind, method and ID;
- complete `envelope`;
- command causation;
- purpose;
- ACP entity kind and opaque ID when present;
- opaque bridge observation ID when available for recovered-frame deduplication;
- ingest mode;
- observation timestamp.

Unknown ACP fields and `_meta` values MUST survive round trips through storage.

## Outgoing versus incoming

For Client-to-Agent messages:

- the event means “durably scheduled for dispatch”;
- delivery attempts are operational facts recorded in command state and telemetry;
- a response or protocol error completes the command.

For Agent-to-Client messages:

- the event means “observed and durably accepted”;
- the control plane MUST append before acknowledging any bridge-level reliable-delivery mechanism.

The system provides at-least-once dispatch around process crashes. Idempotency and ACP operation
classification prevent semantic duplication.

## Ingest modes

- `live`: first observation during a live prompt or protocol operation;
- `load_replay`: history replayed by `session/load`;
- `recovered`: an envelope recovered from a durable bridge spool after reconnect.

Only `live` and deduplicated `recovered` events produce new Workstream feed meaning. A bridge
observation ID is transport metadata, not an ACP entity ID. `load_replay` updates a Session replay
projection and is reconciled against existing history.

## Entity correlation

The projector uses Agent-owned opaque IDs:

- `messageId` for user, agent and thought messages when available;
- `toolCallId` for tool calls;
- positional/full-state semantics for plans;
- protocol-specific identifiers for terminals and other entities.

IDs are scoped to a Session and entity kind. If ACP v1 omits a message ID, the projector creates a
synthetic projection key scoped to the current prompt turn. It MUST retain the original missing-ID
fact.

## Projection model

The projection is a typed relational read model, entirely rebuildable, with three parts:

- `projection.turns`: one row per prompt turn;
- `projection.workstream_items`: the ordered spine of renderable items;
- typed satellite tables, exactly one row per item for the high-frequency kinds:
  `projection.messages`, `projection.tool_calls` (plus `tool_call_locations`),
  `projection.plans` (plus `plan_entries`) and `projection.permission_requests`.

It provides current renderable items:

- assembled user/agent/thought content;
- current tool-call state and complete update trail reference;
- current plan state;
- permission interactions;
- handoff cards;
- terminal summaries;
- context-window/cumulative-cost usage telemetry;
- unknown ACP events as generic inspectable items;

and, on turns, the prompt-response stop reason and cumulative usage snapshot.

Every item references its first and latest canonical event. Projection writes MUST be deterministic
and idempotent by event ID.

The public item shape is `contracts/schemas/workstream-item.schema.json`; the public turn shape is
`contracts/schemas/workstream-turn.schema.json`. Values are ACP-derived and projector-versioned;
they do not replace the canonical envelope.

### Naming and enum rules

Column and field names follow ACP v2 nomenclature in snake_case/camelCase (`toolCallId` →
`tool_call_id`, `rawInput` → `raw_input`, `cachedReadTokens` → `cached_read_tokens`). The wire
protocol remains stable v1 (ADR 0003); v2 naming is a storage/read-model forward-compatibility
choice only and changes no ACP semantics.

- ACP-owned enums (`ToolKind`, `ToolCallStatus`, plan entry `priority`/`status`, `StopReason`,
  permission outcomes) are open sets: stored as plain text verbatim, never as SQL enums or CHECK
  lists. The projector validates known values and stores unknown ones unchanged.
- Agora-owned closed enums (turn `status`, permission `status` and `decided_by`, message `role`)
  are constrained executable in SQL.

### Prompt turns

A turn row is keyed by the durable `PromptSession` command ID and carries `purpose`
(`user`/`handoff`), an ordinal per Session, lifecycle `status`
(`running`/`completed`/`cancelled`/`failed`), the verbatim ACP stop reason, its Workstream sequence
range and the verbatim cumulative usage snapshot — never billing guesses.

The fold rules are:

- the journaled `session/prompt` command event opens the turn as `running`;
- the ACP prompt response closes the turn: `stopReason` verbatim, usage snapshot copied verbatim
  (v1 `PromptResponse.usage`; v2 idle `state_update.usage`) — per the pinned SDK schema these
  counters are cumulative across the Session, so per-turn deltas are derived at read time and
  never stored; status `completed` (or `cancelled` when the response reports cancellation); a
  terminal protocol failure closes it `failed`;
- `usage_update` events are context-window and cumulative-cost telemetry (`used`, `size`, `cost`):
  they update the Session-scoped `usage` item and never touch turn columns;
- turn state changes are published on the feed as `status` events with subject `command`, keyed by
  the same durable command ID.

Items produced inside a turn carry its `turn_id`; Session-level items (for example `session_info`)
stay outside any turn.

### Storage discipline

The five high-frequency kinds — `message`, `thought`, `tool_call`, `plan`, `permission` — MUST NOT
store an inline generic value on the spine; their current state lives in typed satellite columns
bound one-to-one by `(item, kind)` executable foreign keys. Low-frequency kinds (`elicitation`,
`terminal`, `session_info`, `handoff`, `unknown`) keep a contractual `current_value` on the spine,
which also absorbs future ACP update variants without schema migration. Message content and tool
call content remain ordered official ACP content blocks (spec 04: no protocol wrapper). A projector
MAY bound a copied `raw_output`; the complete value stays in the canonical journal.

### Required item mapping

| `kind` | Entity key | Storage | Current-state rule |
|---|---|---|---|
| `message` | Agent `messageId` or prompt-scoped synthetic key | `projection.messages` | role, ordered assembled official ACP content blocks and completion state |
| `thought` | Agent `messageId` or prompt-scoped synthetic key | `projection.messages` (role `thought`) | ordered assembled thought blocks exactly as exposed by the Agent and completion state |
| `tool_call` | Agent `toolCallId` | `projection.tool_calls` + `tool_call_locations` | latest official ACP tool-call state (name/title/kind/status/content/raw input/raw output/locations) plus references to every contributing event |
| `plan` | `planId` or prompt-scoped synthetic plan key | `projection.plans` + `plan_entries` | latest complete official ACP plan state and contributing event |
| `permission` | Agora callback-request ID | `projection.permission_requests` | exact ACP subject/options and final selected/cancelled outcome, linked to its tool-call item when identified |
| `elicitation` | Agora callback-request ID | spine `current_value` | exact ACP request schema/content and final safe outcome |
| `terminal` | Agent terminal ID | spine `current_value` | current terminal metadata/status and canonical references; unbounded output remains chunked/resources |
| `usage` | Session-scoped key | spine `current_value` | latest context-window and cumulative-cost facts verbatim (`used`, `size`, `cost`), never billing guesses |
| `session_info` | Session-scoped key | spine `current_value` | latest Agent-advertised mode/config/session information |
| `handoff` | Handoff command ID | spine `current_value` | source range, policy version, digest, fidelity and target outcome; copied source items are not expanded |
| `unknown` | canonical event ID | spine `current_value` | method/update discriminator and inspectable complete envelope with no inferred semantics |

Missing optional ACP fields remain missing; a projector MUST NOT fabricate them for rendering
convenience.

## Projection scheduling and feed storage

`product.journal_outbox` is a reliable notification that canonical work exists. It is not the Web
feed. Missing or duplicate notifications cannot change correctness: the projector compares each
Workstream's canonical head with its own per-Workstream checkpoint and folds missing events in
sequence order.

The projector commits these together:

- item spine and satellite upserts/removals;
- turn upserts;
- the `(projector_name, workstream_id)` checkpoint;
- one or more durable `projection.feed_events`.

Feed positions order projection changes; Workstream sequences order canonical ACP facts. They MUST
NOT be used interchangeably.

## Rebuild

A full rebuild:

1. emits or arranges a client `reset` boundary;
2. truncates only rebuildable projection state (item spine, satellites, turns, checkpoints) while
   preserving feed-position monotonicity;
3. reads Workstream events in `(workstream_id, workstream_seq)` order and joins any referenced
   durable command metadata;
4. applies the versioned projector;
5. compares resulting Workstream heads and item hashes;
6. emits a reset at a new feed position and resumes publication.

Production MUST periodically prove rebuild equivalence on a representative snapshot.

## Visibility, persistence and seedability

These are independent:

- persistence: all valid ACP envelopes;
- visibility: all events available, with UI collapse/filter choices;
- seedability: an explicit versioned policy selecting context for handoff.

No database column named `hidden` may silently remove thoughts or tool calls from the product.

## Feed

The Web feed is a committed projection stream with its own monotonic position and a
`through_workstream_seq` completeness watermark. Clients reconnect with their last applied feed
position. A feed message may update an existing item; it need not correspond one-to-one with an ACP
chunk.

The feed MUST expose enough source position information for a client to detect gaps and refetch.

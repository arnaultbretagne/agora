# Product API and feed

## Contract

The normative HTTP shape is `contracts/openapi/product-api.yaml`. This document defines behavior not
fully expressible in OpenAPI.

All mutation endpoints require:

- authenticated principal;
- authorization for the Workstream;
- `Idempotency-Key`;
- JSON body limits and schema validation.

## Workstream endpoints

### Create

`POST /v1/workstreams` atomically accepts:

- category;
- initial Agent ID;
- workspace intent;
- equipment request;
- initial ACP content blocks.

It returns `202 Accepted` with Workstream, initial Session and command IDs. Provisioning continues
asynchronously.

An invocation cannot be created without its single user prompt.
The authenticated creator becomes an `owner` membership in the same transaction.

### Read/list

`GET /v1/workstreams` returns metadata/read projections, never custody or execution-grant data.

`GET /v1/workstreams/{id}` returns:

- Workstream metadata;
- the caller's `owner | editor | viewer` role;
- Sessions and durable phases;
- current Session;
- projection head;
- safe typed errors.

ACP Session IDs are diagnostic/internal and are omitted from the default public representation.

`GET /v1/workstreams/{id}/items` returns reverse-chronological, rebuildable Workstream items. The
first page includes:

- the canonical Workstream sequence through which the projection is complete;
- the durable feed position from which concurrent changes must be applied;
- an exclusive sequence cursor for older pages.

Items, projection watermark and feed position are read from one database snapshot. Applying later
feed events is idempotent, so an item observed both in the page and a concurrent upsert is harmless.

It is the required refetch path after a feed `reset`; clients never rebuild history from SSE events
alone.

### Patch/delete

`PATCH` changes title/pinning only. `DELETE` starts ordered cleanup and returns a deletion command.

### Memberships

Owner-only membership endpoints list and put/delete `owner | editor | viewer` relations. Membership
commands are idempotent and MUST reject removal/demotion of the last owner.

## Session endpoints

`POST /v1/workstreams/{id}/sessions` creates a Session with immutable:

- Agent;
- workspace;
- equipment request.

It may activate the Session. Creating a Session never mutates another Session's Agent or grants.

`GET /v1/sessions/{id}` returns durable Session phase plus current live Loge status from its owner
when requested.

`POST /v1/sessions/{id}/activate` performs suspend/switch/handoff orchestration.

`POST /v1/sessions/{id}/suspend`, `/cancel`, and `/close` are explicit commands.

## Prompt endpoint

`POST /v1/sessions/{id}/prompts` accepts standard ACP-compatible content blocks and a user purpose.

The API:

- rejects a non-current Session;
- enforces invocation cardinality;
- returns the durable command ID immediately;
- streams results through the feed;
- exposes delivery-unknown distinctly from prompt failure.

Configuration changes use separate endpoints mapped to ACP mode/config option methods; prompt bodies
do not carry hidden runtime config.

`PUT /v1/sessions/{id}/mode` and
`PUT /v1/sessions/{id}/config-options/{option_id}` validate against the currently advertised ACP
state before dispatch.

Pending ACP permission and elicitation requests receive Agora request IDs and are answered through
their dedicated Session endpoints. Decisions are idempotent, authorized through the Workstream and
rejected after the underlying request has completed or expired.

## Discovery and command status

`GET /v1/agents` returns only the safe public projection of Agent registry entries available to the
caller. `GET /v1/equipment-catalogue` returns the versioned resource-intent vocabulary, never raw
provider scopes.

`GET /v1/commands/{id}` returns durable state and a safe typed failure. Authorization is always
evaluated through the owning Workstream; a command UUID is not a capability.

## Feed

`GET /v1/workstreams/{id}/feed?after={position}` is a resumable SSE baseline. A future WebSocket
transport may be added without changing feed event semantics.

Feed events include:

- Workstream ID;
- monotonic feed position;
- canonical Workstream sequence through which the projection is complete;
- operation `upsert | remove | status | reset`;
- projection item or safe state payload.

`upsert` carries one complete `WorkstreamItem`; `remove` carries its item ID. `status` carries a safe
Command/Session/runtime/projection state, and `reset` carries a reason plus a mandatory refetch
instruction. The exact envelope is `contracts/schemas/feed-event.schema.json`.

Clients:

- fetch the current item page and its feed position before consuming live changes;
- apply in position order;
- reconnect after the last applied position;
- refetch on `reset` or a detected gap;
- never infer completeness from a disconnected socket.

Feed retention may be bounded. Positions are never reused or decreased; when `after` predates the
retained window, the server emits `reset(reason=retention_gap)` and the client refetches items before
continuing from the reset's new position.

## Errors

Public errors have stable codes and safe details:

- `workstream_not_found`;
- `session_not_found`;
- `session_not_current`;
- `invocation_already_prompted`;
- `session_busy`;
- `session_closed`;
- `agent_unavailable`;
- `equipment_denied`;
- `resume_failed`;
- `prompt_delivery_unknown`;
- `custody_unavailable`;
- `runtime_unavailable`;
- `conflict`;
- `validation_failed`.

Provider messages, stack traces, Pod specs, tokens and custody paths are never returned.

## Authorization

Every Session endpoint rechecks access through its Workstream. Knowledge of a Session UUID is never
sufficient authorization.

Feed subscriptions are revoked when Workstream access is removed.

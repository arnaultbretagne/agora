# ACP integration

## Protocol baseline

Production integrations MUST use stable ACP v1 through the official
`@agentclientprotocol/sdk`. The dependency is pinned centrally. ACP v2 is draft and requires a new
ADR, compatibility plan and migration tests before adoption.

The control plane is the ACP Client. Agent packages provide or select an ACP Agent implementation.

Normative upstream references, verified for this baseline on 2026-07-29:

- [ACP v1 Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP v1 Schema](https://agentclientprotocol.com/protocol/v1/schema)
- [Official TypeScript library](https://agentclientprotocol.com/libraries/typescript)

## No protocol wrapper

Local code MUST NOT define replacements for:

- Session;
- prompt turn;
- content blocks;
- session updates;
- tool calls;
- plans;
- permission requests;
- modes;
- config options;
- stop reasons.

Those types flow from the official SDK. Local metadata may correlate a durable command or Workstream
range, but it does not alter ACP semantics.

## Connection bootstrap

For every materialization:

1. authenticate the ACP bridge using a one-time, Session-scoped credential;
2. establish a duplex stream;
3. create an SDK Client connection;
4. call `initialize`;
5. validate protocol version and required capabilities;
6. perform `session/new` or `session/resume`.

Initialization responses and negotiated capabilities MUST be persisted as Session facts or exact
protocol events. A bridge endpoint is never persisted after its short expiry.

## Session creation and binding

`session/new` is sent without a client-selected ACP Session ID. The Agent-returned `sessionId` is
bound to the existing Agora Session exactly once.

A different returned ID during retry after a response was durably observed is a protocol conflict;
the control plane MUST stop rather than overwrite the binding.

## Resume and load

Normal native continuation MUST use `session/resume`, which restores context without replaying
history.

`session/load` MAY be used only for:

- importing a Session owned outside Agora;
- compatibility with an Agent lacking resume, behind an explicit adapter plan;
- projection rebuild validation.

Events received during load MUST be tagged `ingest_mode=load_replay` and MUST NOT receive new
business meaning or appear as duplicate Workstream items.

## Prompt correlation

Every outbound prompt has an Agora command ID and purpose:

- `user`;
- `handoff`.

The command ID is stored beside, not inside, the canonical ACP envelope. `_meta` MAY carry the ID for
diagnostics when propagation is supported, but correctness MUST NOT depend on an Agent echoing it.

Because v1 permits missing `messageId`, the projector associates updates with the single in-flight
prompt turn and creates a synthetic projection entity key when required. Synthetic keys MUST never
be sent back as ACP IDs.

## Host callbacks

The control plane implements ACP Client responsibilities for:

- permission requests;
- filesystem operations;
- terminal operations;
- elicitation;
- session updates.

Each request and response MUST be journaled. Permission policy MAY auto-decide only rules explicitly
authorized by the Session's grants; otherwise the request is surfaced to the user and remains
pending until answered or timed out.

## Content visibility

All ACP output MUST be retained:

- user and agent message chunks;
- thoughts/reasoning updates exposed by the Agent;
- plans;
- tool-call starts, updates and results;
- permission interactions;
- terminal references;
- usage and session-info updates;
- unknown future update variants.

The UI MAY collapse items. Persistence and Web delivery MUST NOT silently discard them.

## Modes and config options

Agent-advertised modes and configuration options are authoritative. The product MAY cache them for
selection but MUST validate changes against the current negotiated state and send standard
`session/set_mode` or `session/set_config_option` operations.

Model and reasoning effort MUST NOT become hard-coded columns in the core Session schema.

## Cancellation and close

`session/cancel` is advisory and racing updates may still arrive. The journal MUST continue accepting
valid final updates until the prompt response reports cancellation.

`session/close` is used only when advertised. Killing the bridge is a runtime fallback, not a
protocol-level successful close.

## Transport requirements

The bridge MUST:

- be bound to one Agora Session ID;
- authenticate both ends;
- enforce maximum frame size;
- preserve ordering and backpressure;
- attach an opaque observation identity when it can replay a previously delivered frame;
- close on credential expiry or Session mismatch;
- emit transport telemetry without logging content by default.

The bridge MUST NOT inspect Agent meaning, synthesize tool calls, collapse chunks or provide its own
resume abstraction.

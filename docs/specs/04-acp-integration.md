# ACP integration

This specification implements [ADR 0004](../adr/0004-acp-boundary-and-session-facts.md) and the
[Session boundary contract](03-session-lifecycle.md). Its types come unchanged from the pinned
stable ACP v1 SDK/schema. ACP v2 adoption requires a separate ADR and migration.

## Protocol and ownership

The control plane is the ACP Client; each reviewed harness exposes the ACP Agent role. OneCLI is
neither an ACP role nor an ACP transport. The ACP bridge authenticates, frames and captures ACP;
the Broker provider relay tunnels provider traffic opaquely. These are distinct responsibilities.

Use standard ACP requests, content blocks, updates, config options, permissions, tool calls and
responses. Product causation metadata does not replace those types. No local semantic wire wrapper
or native harness command is accepted through the product API.

Normative protocol references:

- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP schema](https://agentclientprotocol.com/protocol/v1/schema)

These references define ACP. Integration-specific guarantees below must be demonstrated for the
pinned harness; documentation does not certify any existing adapter implementation.

## Bootstrap and binding

A concrete Agora Session exists before `initialize`, `session/new` or `session/resume` is scheduled
or accepted. Each connection is authenticated for its Pod/process/context and current attribution
boundary using short-lived, single-purpose credentials outside the ACP envelopes.

Initialization verifies the negotiated version and required capabilities. A registry expectation
alone is insufficient. Native restore precedes opening the restored ACP context; the runtime
controller's controlled launch seam may exist while the ACP process is still gated.

`session/new` obtains a harness-chosen ACP context identifier. `session/resume` reopens the native
context identified by the selected Save, after checking negotiated resume support. Both bind to the
new Agora Session's context descriptor. Resuming never reuses the producing Agora Session identity.

Unknown acceptance is handled by [the failure contract](13-failure-and-idempotency.md). Creating a
second native context or overwriting an existing binding is not a generic retry strategy.

## Current evidence and configuration

`observation.session`, `observation.model` and `observation.effort` are registered in the
[Observation taxonomy](reconciliation/002_observation.md). An enabled integration MUST demonstrate:

- how an initial authoritative snapshot is acquired for the actual live context;
- which standard config option ids represent the reviewed model and effort;
- truthful current values after native resume, rather than defaults echoed from the client;
- ordering of config updates, completeness of dependent options and effective-on-next-turn behavior;
- how current evidence is renewed and invalidated when the process or connection changes.

A read can be a fresh owner snapshot, or a freshly validated view maintained from a complete ordered
owner stream since such a snapshot. The latter is allowed only while the same process/context and
unbroken stream are verified. Lost continuity, unknown buffered updates or reconnection invalidates
it. Copying the last persisted ACP response or refreshing its timestamp does not renew evidence.
An action response is never itself the next tick's Observation; acquisition must establish current
owner evidence independently under this contract.

A session listing proves only discovery unless the pinned integration supplies a stronger verified
live-state contract. Generic ACP support does not imply a universal config getter, liveness query
or native-transcript read method. An integration lacking a required read stays unavailable for the
corresponding product behavior until the contract is fulfilled; Agora invents no ACP method.

Model changes use `session/set_config_option`. Effort is validated against the model observed after
that change; dependent option clamping is observed on the next tick. An invalid or disappeared
option leaves admission closed with a typed incompatibility, never a silently selected default.
Persona is frozen at `default` in this iteration; native restore must not reintroduce an unverified
custom persona. Effective settings are recorded as facts, not mutable Session desired-state columns.

## Capture and attribution

Capture complete accepted serialized envelopes before controlled transport write or semantic
handling. Preserve all accepted JSON members, unknown `_meta`, array order and lossless numbers.
Validation must not replace canonical JSON with lossy SDK objects. Invalid frames generate only
safe operational diagnostics, never canonical content.

Each envelope occurrence has stable dispatch/observation causation and exactly one Agora Session
attribution in Workstream order. Content equality does not deduplicate occurrences. A connection
may survive a hot boundary only if its capture seam can preserve the old/new attribution rule;
otherwise drain and reconnect before admitting new work.

Outgoing commit means scheduled dispatch; incoming commit means observed and durably accepted.
Neither proves a later effect. Database failure applies backpressure; uncontrolled loss before
capture cannot be represented as an accepted fact that Agora never actually received.

## Prompt and callback handling

Each prompt is a durable command with purpose `user` or `handoff`, a stable command id and the
selected Session/context. There is one in-flight prompt per Workstream. A Handoff uses ordinary
ACP content and can invoke the model/tools; its prerequisites are specified in spec 03.

Commands and complete outgoing envelopes commit before dispatch. `_meta` propagation is optional
and cannot be the universal deduplication proof. Missing ACP entity ids remain missing; deterministic
projection-only fallback keys never enter the protocol.

The control plane implements negotiated Client responsibilities for permissions, files, terminals,
elicitation and updates. Requests and responses are captured. Host operations are restricted to
the owning workload and authorized roots; a runtime request never borrows the control plane's
filesystem, infrastructure identity or credentials. Local permissions cannot grant external rights
that OneCLI denies.

MCP registration is the fixed reviewed image registration. It contains no provider secret, OneCLI
identifier, upstream bearer or relay credential. Capability changes affect grants, not descriptors.

## Resume, replay and cancellation

Normal native continuation uses `session/resume` without message replay. `session/load`, if used by
a separately specified import/validation workflow, must preserve replay provenance and cannot turn
old source messages into new product history. Reconciliation does not load history to fake a fresh
config read.

Cancellation is advisory. Final updates and responses remain attributable to the interrupted turn.
Quiescence requires the stronger runtime/transport proof in spec 03. Closing a socket or killing a
process never fabricates a successful ACP cancellation or close response.

## Transport and retention

The bridge enforces authentication, frame limits, ordered capture, backpressure and credential
expiry. It records replay/dispatch identities where delivery recovery is supported. It emits no
query strings, headers, prompts, tool content or tokens in operational logs.

Every accepted ACP update remains canonical, including unknown future updates. Product views may
collapse them; deterministic projections retain their source references. Save payloads and native
continuity inspection stay behind the custody driver and never become an alternate product journal.

# Glossary

## Purpose

This glossary is the sole vocabulary authority. A new synonym that represents an existing object is
a modelling bug. New terms require a specification change and, when they change an architectural
decision, an ADR.

## Product terms

### Workstream

The durable business object shown in Agora. A Workstream has a non-null Agora-issued ID and exactly
one category.

A Workstream is not necessarily a conversation. It may represent an interactive discussion or a
single invocation. It orders the output of one or more ACP Sessions.

### Workstream category

One of:

- `discussion`: accepts multiple user-purpose prompt turns and may move between Agents;
- `invocation`: accepts exactly one user-purpose prompt turn in v1.

No catch-all, ad hoc or nullable category is allowed.

### Workstream membership

The authorization relation between one principal and one Workstream, with role `owner`, `editor` or
`viewer`. It is product state, not inferred from infrastructure logs or Session possession.

### Session

One ACP execution context belonging to exactly one Workstream and exactly one Agent. It is the
unit formerly confused with an application Run.

A Session has:

- an Agora `id`, allocated before runtime provisioning;
- an opaque ACP `sessionId`, bound after `session/new`;
- one logical Loge;
- zero or more ACP prompt turns;
- zero or more custody snapshot generations.

A Session is never reused by another Workstream or Agent.
Harness-local names such as a Codex “thread” are opaque adapter/custody details of this Session, not
another Agora entity.

### Durable command

One idempotent product intent recorded before its external side effects. A command carries its
authenticated human/service/system actor and may cause one or more canonical ACP events; it is not
another execution identity.

### Prompt turn

The ACP term for one `session/prompt` request and all updates until its `PromptResponse`. A
discussion may have many prompt turns. An invocation has exactly one user-purpose prompt turn.

`handoff` prompt turns are protocol-visible context synchronization operations and do not count as
user-purpose prompts.

### Agent

An ACP-speaking agent distribution selected by `agent_id`, for example a particular Claude Code ACP
adapter or Codex ACP adapter. `agent_id` identifies a trusted registry entry, not a model, capability
profile, arbitrary command or provider credential.

### Harness

The native agent implementation hidden behind an ACP adapter, such as Claude Code or Codex. Core
product code MUST NOT depend on harness file formats, command-line flags or native resume mechanics.

### Adapter

Agent-specific code that:

- exposes the harness through ACP;
- launches it using a trusted runtime definition;
- captures and restores its opaque custody.

An adapter does not create a second product protocol.

## Runtime terms

### Loge

The logical isolated runtime resource of exactly one Session. Its identity is the Agora Session ID;
there is no separate persisted `loge_id`.

A Loge may be dematerialized and later rematerialized. At most one Pod incarnation may exist for it
at a time.

### Pod incarnation

One Kubernetes Pod currently materializing a Loge. Its Pod UID is infrastructure identity, not
product identity. A resumed Session may have a different Pod UID without becoming another Session.

### Loge controller

The trusted control-plane service that materializes, inspects, captures and dematerializes Loges. It
owns Kubernetes workload permissions but does not understand Workstream content or ACP semantics.

### ACP bridge

An authenticated byte/framing bridge between Agora's ACP Client and the ACP process in a Loge. It
MUST preserve ACP JSON-RPC semantics unchanged.

## Persistence terms

### Workstream event

One complete ACP request, response or notification observed for a Session, plus minimal indexing and
causation metadata assigned by Agora. The canonical payload is the full ACP envelope.

### Workstream sequence

A gap-free, monotonically increasing ordering allocated transactionally within one Workstream.
Sequence order reflects durable observation order, not wall-clock time.

### Session sequence

A gap-free, monotonically increasing ordering within one Session.

### Projection

A disposable, rebuildable read model derived only from canonical product facts. Examples include
assembled messages, current tool-call state, current plan and Web feed items.

A projection MUST NOT become the only copy of information.

### Workstream item

The current rebuildable Web representation of one ACP-derived entity such as a message, thought,
tool call, plan, permission interaction or Handoff. It references its first/latest canonical events
and is not a second source of truth.

### Feed position

A durable, monotonically increasing position in the projection feed. It orders client updates and
is distinct from canonical Workstream sequence.

### Anchor

The durable pointer for one `(workstream_id, agent_id)` pair. It identifies a Session, a committed
custody snapshot and the Workstream sequence through which that snapshot's restored context is known
to be synchronized.

### Custody

Harness-specific state required to faithfully resume a Session. Custody is opaque to the product
core and is never product history or infrastructure logging.

### Custody snapshot

One immutable generation of custody bytes plus non-opaque metadata: Session, format, adapter
version, checksum, size and synchronized Workstream watermark.

### Watermark

The inclusive Workstream sequence known to be represented by a custody snapshot or synchronized
Agent context.

### Handoff

A prompt turn whose purpose is to synchronize a target Session with the selected Workstream delta
after its anchor. It contains an explicit source range and seed-policy version.

## Capability terms

### Equipment request

A user-visible request for resources and access levels, such as `vault/read-write` or
`github/propose`. It is intent, not authority.

### Capability grant

One policy-resolved, auditable capability fact belonging to a Session. Capability grants are
independent rows, not named combinations.

### Execution grant

A short-lived, opaque Broker authorization issued for a Session from its resolved capability
grants. Its transient activation reference is consumed by the Loge controller and bound to that
Loge's workload identity. It MUST NOT be persisted as a bearer token.

### Broker

The security boundary that authorizes execution-grant use, proxies provider/MCP operations and
mints downstream credentials without exposing provider secrets to the Loge. It may integrate an
adopted gateway such as OneCLI; it does not imply a custom implementation.

## Forbidden legacy terms

The following are not valid domain concepts:

- `Conversation`;
- `Run`;
- `native_session_id`;
- `Thread` as a product aggregate;
- runtime `kind`;
- reusable Loge `group`;
- combined capability `profile`;
- channel;
- pipe.

They may appear only in migration notes describing the removed system.

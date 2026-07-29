# Domain model

## Aggregate boundaries

`Workstream` is the product aggregate root. `Session` is a durable child entity with its own
lifecycle and external ACP binding. Custody and projections are separate storage concerns linked to
the aggregate by immutable identifiers.

```text
Workstream 1 ────── 1..N Session
    │                    │
    │                    ├── 1 Agent
    │                    ├── 1 logical Loge
    │                    ├── 0..N prompt turns
    │                    └── 0..N custody snapshots
    │
    └── 0..N Agent anchors, at most one per agent_id
```

## Workstream invariants

- `id` MUST be allocated by Agora and MUST NOT be null.
- `category` MUST be `discussion` or `invocation`.
- A Workstream MUST be created atomically with its first Session intent.
- A Workstream MUST be created atomically with an `owner` membership for the authenticated
  principal.
- Membership roles are exactly `owner`, `editor` or `viewer`; at least one owner MUST remain.
- At most one Session may be current in a Workstream.
- A current Session MUST belong to that Workstream.
- Deleting a Workstream is a product command distinct from closing a Session.
- Titles and pinning are metadata and MUST NOT alter event ordering.

Membership mutation locks the Workstream before counting owners so concurrent demotions/deletions
cannot both remove the last owner.

### Category rules

For `discussion`:

- any positive number of user-purpose prompt turns is allowed;
- additional Sessions may be created for another Agent, a new security envelope, or recovery.

For `invocation`:

- exactly one user-purpose prompt turn is allowed;
- handoff and protocol turns do not count toward that limit;
- a business retry creates a new Workstream;
- infrastructure retries of the same durable command remain inside the same Session.

## Session invariants

- A Session belongs to one immutable `workstream_id`.
- `agent_id` is immutable.
- The Agora `id` is immutable and is the Loge resource key.
- `acp_session_id` is absent before binding and immutable after binding.
- `(agent_id, acp_session_id)` MUST be unique when bound.
- One Session has one immutable workspace root specification and one resolved capability envelope.
- The submitted equipment request is immutable and persisted separately from its resolved
  capability facts.
- The capability policy version and digest are bound once before provisioning and cannot change.
- ACP modes and config options MAY change inside a Session through standard ACP operations.
- A failed native resume MUST NOT clear or replace `acp_session_id`.
- A fresh Agent context requires a new Session.

## Why two Session identifiers

Agora must persist intent and provision a Loge before calling ACP `session/new`; ACP assigns its
opaque `sessionId` in the response. Therefore:

- `Session.id` is the local durable identity and Loge key;
- `Session.acp_session_id` is the protocol locator.

They identify the same entity at different boundaries. No binding table or separate native Session
entity is introduced.

## Current Session

`is_current` is a product routing pointer, not runtime liveness. A partial unique database constraint
MUST enforce at most one current Session per Workstream.

Changing current Session is transactional:

1. validate the target belongs to the Workstream;
2. clear the previous pointer;
3. set the target pointer;
4. commit before accepting a user prompt for the target.

The current Session may be suspended; prompt handling is responsible for rematerializing it.

## Commands

The domain accepts these commands:

- `CreateWorkstream`;
- `RenameWorkstream`;
- `OpenSession`;
- `ActivateSession`;
- `PromptSession`;
- `CancelSession`;
- `SuspendSession`;
- `CloseSession`;
- `DeleteWorkstream`.

Every externally retried command MUST carry an idempotency key scoped to its aggregate.
Every command also records the authenticated human, service or system actor that created the
durable intent. Actor identity is not inferred later from logs.

## Facts versus live state

Persisted facts include:

- Workstream identity/category/metadata;
- Workstream memberships;
- Session identity, Agent, immutable launch envelope and ACP binding;
- original equipment intent, capability-policy version and resolved capability facts;
- every observed ACP envelope;
- terminal failure and close reasons;
- resolved capability facts;
- custody snapshot metadata;
- anchors.

Live infrastructure state includes:

- Pod phase and UID;
- ACP bridge socket presence;
- container restarts;
- node placement;
- transient bearer and tunnel tokens.

Live infrastructure state MUST be queried from its owner and MUST NOT be presented as a durable
product fact.

## Deletion

Deletion is asynchronous and ordered:

1. reject new commands;
2. cancel/close current ACP work where possible;
3. capture custody only when retention policy requires it;
4. dematerialize all Loges;
5. revoke execution grants;
6. delete product rows and custody snapshots according to policy.

A database cascade MUST NOT be the only runtime cleanup mechanism.

# Equipment and Broker

## Objective

Users select useful resources without composing low-level security claims. Policy resolves that
intent into independent capability facts; the Broker enforces them and keeps real credentials out of
Loges.

`Broker` names the logical security boundary and Agora-facing contracts, not a requirement to build
a custom credential gateway. ADR 0014 and P08 require an adopt-before-build evaluation of OneCLI.

## Equipment request

An equipment request is a list of resource intents:

```json
{
  "catalogueVersion": "2026-07-29",
  "resources": [
    { "resource": "vault", "access": "read-write" },
    { "resource": "github", "access": "propose" }
  ]
}
```

The Broker is authoritative for the safe catalogue. The product projects it through
`GET /v1/equipment-catalogue`; both shapes use
`contracts/schemas/equipment-catalogue.schema.json`. It is versioned and never contains provider
OAuth scopes, token values, endpoint overrides or arbitrary MCP server definitions.

A request contains at most one entry per resource. Duplicate or contradictory access intents are
validation errors, not “last value wins”.

## Policy resolution

Policy evaluates:

- authenticated principal;
- Workstream category;
- Agent ID;
- requested resources/access;
- environment;
- operator rules.

It returns either a typed denial or:

- normalized capability-grant facts;
- a policy version;
- safe ACP MCP server descriptors;
- an opaque execution-grant reference.

Resolved capability facts are persisted against the Session. Bearers are not.

## No combined profiles

Capabilities are independent rows. The system MUST NOT create names for every combination such as
`repo-dev-vault-v1`.

Policy may define reusable rules or UI presets, but a preset expands to facts and is not the
authorization claim stored on a Session.

## Execution grant

An execution grant:

- is bound to one Session ID and Agent ID;
- contains or resolves only approved capability facts;
- expires;
- is revocable;
- cannot be upgraded in place;
- exposes one transient activation reference to the control plane for immediate forwarding to the
  Loge controller;
- is bound by the controller to one authenticated Loge workload identity;
- is never returned to the Browser;
- is never stored as plaintext in product tables.

Grant renewal MUST preserve the same capability set. Changing equipment creates a new Session.

## Broker planes

The Broker separates:

- policy/admin plane: authenticated control-plane issuance and revocation;
- data plane: Loge requests authorized by execution grant;
- isolated provider adapters: mint/use actual downstream credentials.

Real provider credentials never cross into the policy front, control plane or Loge.

Grant issuance, activation, expiry and revocation state is owned by a Broker-private operational
store, not `product.*`. It MUST survive Broker process restart or invalidate outstanding grants
fail-closed. Its backend and retention are implementation/operations concerns selected in P08; they
do not become Workstream history.

### Activation

The control plane passes the transient `grantRef` directly to the Loge controller. The controller
creates the Session-specific workload identity and calls the Broker activation operation. Broker
atomically binds:

```text
grant + session_id + agent_id + workload_identity
```

The activation response contains identifiers and expiry only. It returns no provider credential or
data-plane bearer. Repeating the same request ID is idempotent; attempting to bind the reference to a
different identity fails closed.

## Agent invocation

The right to invoke the selected Agent/provider is resolved automatically from `agent_id` and
principal policy. It is not user-visible “equipment”.

Tool/data equipment such as Vault or GitHub remains separately selectable and auditable.

## MCP servers

Policy returns safe ACP `mcpServers` connection descriptors corresponding to grants. Descriptors:

- contain no real provider secret;
- contain no execution-grant token or secret header;
- point to Broker-controlled endpoints or trusted local shims;
- are resent explicitly on ACP new/resume as required;
- are scoped to the current execution grant.

The Broker data plane authenticates the Loge's bound workload identity outside the ACP descriptor.
Consequently, the complete `session/new`/`session/resume` envelope can be journaled without
persisting a credential.

The Loge controller MUST NOT derive MCP servers from a profile or append harness-specific CLI flags.

## Authorization

Every Broker data-plane request checks:

1. grant authenticity and expiry;
2. Session binding;
3. required capability;
4. resource scope/constraints;
5. revocation.

Denial occurs before a request reaches a provider adapter.

## Lifecycle

- Issue before materialization.
- Activate against the controller-created identity only for that Loge.
- Renew without changing facts when necessary.
- Revoke on dematerialization, Session close, deletion or policy emergency.
- Audit issue, deny, use class, renewal and revocation without logging content or tokens.

## Equipment change

The immutable security envelope is part of Session identity. A user requesting different equipment:

1. durably suspends the current Session;
2. opens a new Session with the new request;
3. uses Workstream handoff to preserve product continuity.

ACP mode/model/config changes that do not alter resource authority remain inside the Session.

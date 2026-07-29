# Equipment and OneCLI-backed Broker

## Objective

Users select useful resources without composing low-level security claims. Agora policy resolves that
intent into independent capability facts. Broker binds those facts to one Session and configures
self-hosted OneCLI, the sole credential gateway.

The ownership split is normative:

| Concern | Owner |
| --- | --- |
| User equipment vocabulary and capability resolution | Agora Broker policy |
| Execution-grant/workload lifecycle | Agora Broker |
| Session-to-OneCLI Agent lifecycle and rule publication | Agora Broker control adapter |
| Workload authentication and opaque CONNECT relay | Agora Broker access relay |
| Provider credential storage/injection, CA/MITM and route decision | OneCLI |
| Pod lifecycle and fixed safe runtime bundle | Loge controller |

Agora MUST NOT implement provider TLS interception, a provider-secret store, credential injection or
a fallback credential gateway.

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
OAuth scopes, token values, endpoint overrides, OneCLI rules or arbitrary MCP server definitions.

A request contains at most one entry per resource. Duplicate or contradictory access intents are
validation errors, not “last value wins”.

## Policy resolution

Policy evaluates:

- authenticated principal;
- Workstream category;
- Agent ID and exact runtime-definition version;
- requested resources/access;
- environment;
- operator rules.

It returns either a typed denial or:

- normalized capability-grant facts;
- policy and Agent route-set versions;
- one deterministic capability digest;
- safe ACP MCP server descriptors;
- an opaque execution-grant reference.

Resolved capability facts and versions are persisted against the Session. OneCLI identifiers, rules,
control keys, proxy URLs and bearers are not product facts.

## No combined profiles

Capabilities are independent rows. The system MUST NOT create names for every combination such as
`repo-dev-vault-v1`.

Policy may define reusable rules or UI presets, but a preset expands to facts and is not the
authorization claim stored on a Session. The pinned Agent route set expresses reviewed network needs
for one runtime definition; it is not a capability-combination profile.

## One Session, one OneCLI Agent

Before a grant becomes issuable, the Broker control adapter:

1. derives a unique operational identifier from the Agora Session ID without exposing it publicly;
2. creates or reconciles exactly one OneCLI Agent for that Session;
3. forces selective mode;
4. associates only the provider credentials required for Agent invocation and approved equipment;
5. publishes the complete ordered policy;
6. verifies the effective credentials and rules before activation.

The OneCLI default Agent and `all` credential mode are forbidden for Loges. A OneCLI Agent is never
shared or reassigned across Sessions.

While a Session is suspended, the OneCLI Agent may remain as the same operational principal, but its
relay binding is disabled and upstream bearer is rotated. Terminal Session/Workstream cleanup
deletes it after revocation.

## Route-policy compilation

OneCLI policy uses first-match ordering:

1. explicit allow rules for the pinned Agent route set;
2. explicit allow rules derived from approved capability facts and constraints;
3. one final explicit network `block *` rule.

OneCLI's built-in Default Rule MUST remain decision-neutral for Agora. It is not a general
deny-by-default because it may allow uncredentialed traffic and recognized LLM hosts.

The compiler MUST:

- be deterministic from policy version, route-set version and capability facts;
- reject empty/malformed targets and duplicate or shadowed terminal rules;
- publish atomically or leave the grant unusable;
- verify post-publication ordering/effective state;
- fail activation when cache invalidation/publish outcome is unknown;
- narrow OpenAI/ChatGPT hosts to the endpoints required by the pinned Codex runtime.

Agent upgrades require a reviewed route diff. An analytics or newly observed endpoint is denied until
explicitly approved.

## Execution grant

An execution grant:

- is bound to one Session ID and Agora Agent ID;
- resolves only the persisted capability digest and route-set version;
- maps to the Session's dedicated OneCLI Agent;
- expires independently from OneCLI's upstream Agent token;
- is revocable;
- cannot be upgraded in place;
- exposes one transient activation reference to the control plane for immediate forwarding to the
  Loge controller;
- is bound by the controller to one authenticated Loge workload identity;
- is never returned to the Browser;
- is never stored as plaintext bearer material in product tables.

Grant renewal MUST preserve the same capability digest, Agent/runtime definition and OneCLI Agent
mapping. Renewal MAY rotate private upstream authority. Changing equipment creates a new Session.

## Broker planes

### Control plane

The Broker control adapter is the only Agora component allowed to use the OneCLI control API and
organization/project key. It uses pinned `@onecli-sh/sdk` and:

- creates/configures/deletes dedicated OneCLI Agents;
- publishes and verifies policy;
- calls `getContainerConfig`;
- extracts the upstream OneCLI proxy bearer into Broker-private encrypted state;
- verifies returned CA/stub material against the operator-managed runtime bundle expected by the
  Loge controller;
- rotates authority on revoke/renew;
- updates provider subscription authentication through an operator-only path.

`onecli run` and SDK `applyContainerConfig` are not production launch contracts. A `false`,
incomplete or unavailable OneCLI response is a hard provisioning failure.

### Access relay

The Broker access relay:

- authenticates platform workload identity outside the Agent container;
- resolves exactly one active grant and private OneCLI upstream bearer;
- checks Session, Agent, expiry and revocation;
- accepts only traffic permitted to reach the OneCLI gateway;
- attaches upstream proxy authentication;
- tunnels CONNECT traffic opaquely.

It MUST NOT:

- terminate provider TLS;
- possess OneCLI CA private keys or provider credentials;
- inspect provider paths/bodies after CONNECT;
- inject or mint provider credentials;
- implement provider-specific behavior;
- accept a Browser or ACP-supplied bearer.

This relay is an authorization seam, not a second credential gateway.

### OneCLI

OneCLI alone owns:

- provider credentials and subscription auth state;
- Agent access tokens and selective credential mapping;
- gateway CA/private key;
- MITM and credential injection;
- provider-specific auth stubs/host matching;
- gateway policy enforcement;
- request decision telemetry.

Its image is pinned by digest. Agora treats its public API/SDK as an external contract and never
imports OneCLI database tables into product code.

## Activation

The control plane passes `grantRef` directly to the Loge controller. The controller creates the
Session-specific workload identity and calls Broker activation. Broker atomically binds:

```text
grant + session_id + agent_id + workload_identity + onecli_agent
```

The activation response contains identifiers and expiry only. It returns no provider credential,
OneCLI control key or data-plane bearer. Repeating the same request ID is idempotent; attempting to
bind the reference to a different identity fails closed.

The Loge controller supplies a fixed safe runtime bundle from trusted deployment state:

- credential-free Broker relay endpoint;
- OneCLI CA trust;
- non-secret harness auth stubs/placeholders.

The bundle contains no OneCLI upstream bearer and is never accepted from Browser input.
Broker activation fails when `getContainerConfig` does not match that bundle; the activation
response does not become a runtime-configuration transport.

## Agent invocation

The right to invoke the selected Agent/provider is resolved automatically from `agent_id`, runtime
definition and principal policy. It is not user-visible equipment.

Claude Max and ChatGPT/Codex subscription auth live in OneCLI. Agent images contain the pinned
harness and ACP adapter; OneCLI does not install them.

Tool/data equipment such as Vault or GitHub remains separately selectable and auditable. Its
credentials are stored/injected by OneCLI when supported. A missing OneCLI provider capability
requires an explicit ADR before any alternative credential path is implemented.

## MCP servers

Policy returns safe ACP `mcpServers` descriptors corresponding to grants. Descriptors:

- contain no provider secret;
- contain no execution-grant, relay or OneCLI token/header;
- point to Broker-controlled endpoints or trusted credential-free shims;
- are resent explicitly on ACP new/resume as required;
- are scoped by the active grant outside the descriptor.

The Broker authenticates the Loge's workload identity outside ACP. Consequently, complete
`session/new`/`session/resume` envelopes can be journaled without persisting credential material.

The Loge controller MUST NOT derive MCP servers from a profile or append harness-specific CLI flags.

## Persistence

Broker-private operational state stores:

- grant/activation lifecycle and idempotency records;
- workload binding;
- OneCLI Agent mapping;
- encrypted upstream proxy authority;
- publication/reconciliation state.

It is not `product.*`. It MUST survive Broker restart or invalidate outstanding access fail-closed.

OneCLI separately owns:

- its PostgreSQL database;
- `/app/data` CA/private-key state;
- an externally supplied encryption key.

Production backup/restore MUST preserve those three OneCLI assets as a compatible recovery set.

## Lifecycle

- **Issue:** create/reconcile selective OneCLI Agent and full policy before returning `grantRef`.
- **Activate:** bind the controller-created workload identity and enable the relay mapping.
- **Suspend:** disable relay mapping and rotate upstream authority; retain only same-Session
  operational mapping needed for resume.
- **Renew:** preserve capability digest and rotate/extend private authority.
- **Revoke:** deny at the relay first, then rotate/delete OneCLI authority idempotently.
- **Close/delete:** remove relay mapping and dedicated OneCLI Agent after runtime cleanup.
- **Provider renewal:** update OneCLI-owned subscription auth without touching custody/product
  history.

Every transition is audited without prompt/tool content, URLs with query strings or tokens.

## Failure behavior

- OneCLI control API unavailable: no issue/renew/materialize succeeds.
- Policy publication uncertain: grant remains inactive.
- Broker relay unavailable: no provider traffic bypasses it.
- OneCLI gateway unavailable: the Agent call fails; no direct provider fallback exists.
- Upstream bearer suspected leaked: disable relay mapping, rotate OneCLI Agent token and reconcile.
- CA state lost/mismatched: Loges fail TLS readiness; operators restore the compatible recovery set
  or perform an explicit rotation.
- Provider token expires: typed provider-auth failure and operator renewal; never copy the token into
  the Loge.

## Equipment change

The immutable security envelope is part of Session identity. A user requesting different equipment:

1. durably suspends the current Session;
2. revokes its active relay/grant;
3. opens a new Session with a distinct OneCLI Agent and new capability digest;
4. uses Workstream handoff to preserve product continuity.

ACP mode/model/config changes that do not alter resource authority remain inside the Session.

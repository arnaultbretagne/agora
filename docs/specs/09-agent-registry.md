# Agent registry

## Purpose

The Agent registry is the trusted, versioned catalogue that turns an `agent_id` into a safe runtime
definition. It prevents the product API from becoming arbitrary remote execution.

## Authority

Registry definitions are code/operator configuration reviewed and deployed with the Loge controller.
The Browser and control plane may select enabled IDs but cannot submit or mutate definitions.

The UI receives `GET /v1/agents`, a public projection containing labels and availability, never
image digests, commands, custody paths or unverified runtime capabilities.

The Loge controller is the launch authority and exposes an internal safe selection projection:

```text
GET /v1/agents -> registry revision + (agent_id, exact runtime-definition version, public metadata)
```

The product endpoint derives from that projection. A Session freezes the exact returned version;
the Browser still submits only `agent_id` and cannot select a stale/private runtime definition.

## Runtime definition

Each versioned definition contains:

- stable `agent_id`;
- human label and description;
- immutable image digest;
- static ACP process command;
- bridge mode;
- supported stable ACP protocol range;
- custody driver ID;
- custody formats readable and writable;
- workspace mount requirements;
- resource defaults/limits;
- health probe;
- rollout state;
- public availability metadata.

The machine-readable shape is `contracts/schemas/agent-runtime.schema.json`.

The immutable image MUST already contain the exact harness and ACP-adapter executables; readiness
cannot install or download them. CI records their versions and smoke-tests both commands before the
image digest becomes launchable.

Broker policy maintains a reviewed route-set mapping keyed by the exact runtime-definition version.
That mapping is privileged operator configuration, not Browser input or a combined capability
profile.

## Agent ID semantics

`agent_id` identifies an ACP Agent distribution, not just a provider name. A materially different
adapter with different custody semantics receives another definition version and, when incompatible,
a distinct ID.

Examples may include:

- `claude-code`;
- `codex`.

Names such as `claude`, `sonnet`, `gpt-5`, `kind` or an arbitrary executable are not interchangeable
with `agent_id`.

## ACP capabilities

The registry describes what can be launched. The Agent's `initialize` response remains authoritative
for runtime capabilities. The control plane MUST intersect:

- registry expectations;
- actual ACP capabilities;
- product feature requirements.

A mismatch is a typed provisioning failure, not an optimistic fallback.

## Version pinning

A Session records the resolved runtime-definition version. Resume SHOULD use a compatible version:

- exact version when available;
- a newer version declaring read compatibility with the custody format;
- otherwise no native resume.

Automatic upgrades MUST NOT strand anchored custody without a tested rollback path.
They also MUST NOT publish new OneCLI provider routes without an explicit route diff and terminal
block validation.

## Driver boundary

Custody drivers are selected only through the registry. A driver declares:

- format identifier/version;
- capture roots/allow-list;
- credential exclusions;
- consistency mechanism;
- maximum size;
- restore collision behavior;
- compatibility matrix.

The driver may know native harness layout; product code may not.

## Rollout

Definitions move through:

- `disabled`;
- `internal`;
- `enabled`;
- `deprecated`;
- `retired`.

Deprecation blocks new Sessions while allowing resume. Retirement is allowed only when no retained
Session requires the definition or a migration path exists.

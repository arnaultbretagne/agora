# Security

## Threat model

The Agent and everything it executes inside a Loge are untrusted. Prompt injection may cause
arbitrary code execution within that Loge.

Primary assets are:

- provider and infrastructure credentials;
- other users' Workstreams and custody;
- Kubernetes control;
- product database integrity;
- capability policy;
- repository/vault write authority.

The design does not rely on the Agent following instructions.

## Trust boundaries

```text
Internet
  │
  ▼
Web/API ── product identity ── Control plane
                                  │
                 ┌────────────────┴───────────────┐
                 ▼                                ▼
          Loge controller                      Broker
                 │ workload API                  │ provider secrets
                 ▼                                ▼
          untrusted Loge ── scoped grant ── Broker data plane
```

Every arrow crosses authenticated authorization. Same-repository code does not imply same runtime
trust.

## Authentication and authorization

- Human/API requests use the platform identity provider.
- Workstream authorization is checked against durable `owner | editor | viewer` membership.
- Service-to-service calls use workload identity and authenticated TLS.
- Loge materialization requires an execution grant bound to Session and Agent.
- ACP bridge credentials are one-time or short-lived and Session-bound.
- Database access uses distinct roles per deployable.
- Authorization is checked at every resource boundary, not only in the UI.

Baseline role semantics are:

- `owner`: read/write, membership administration and deletion;
- `editor`: read/write Sessions, prompts and metadata, but no membership administration/deletion;
- `viewer`: read items/feed/status only.

System/service commands carry their actor and an explicit delegated authority path; they do not
manufacture a human membership.

## Kubernetes

Only the Loge controller ServiceAccount may create/delete Loge workloads.

Loge Pods:

- use no Kubernetes API token;
- run non-root;
- receive a restrictive security context and runtime class;
- cannot mount host paths or arbitrary PVCs;
- cannot select an image, command, env or ServiceAccount;
- have CPU, memory, PID and ephemeral-storage limits;
- carry deterministic Session/Agent labels without user-controlled label keys.

The controller validates the generated PodSpec before submission.

## Network

Default-deny NetworkPolicies isolate:

- Loges from product Postgres;
- Loges from the Kubernetes API;
- Loges from other Loges;
- public Web ingress from internal control APIs;
- Broker admin plane from Loges.

Required Agent/provider egress and Broker data-plane access are explicitly allowed. Broad Internet
egress, if required by an Agent, does not weaken secret isolation.

## Secrets

- Provider secrets live only in Broker adapters.
- Execution-grant activation references and Loge workload credentials are ephemeral and never
  persisted in product tables, ACP envelopes or logs.
- ACP tunnel credentials are ephemeral and redacted.
- Custody drivers exclude credential paths.
- Workspace content and custody are never placed in environment variables.
- Secrets are not embedded in registry definitions or Pod templates.

## Database

Required roles:

- `agora_product`: product facts and journal;
- `agora_projector`: projection rebuild/write;
- `agora_custody_meta`: custody metadata only;
- `agora_custody_runtime`: custody payload read/write;
- `agora_migrator`: DDL only.

The control-plane role MUST receive an explicit column-level denial for custody payload where
supported, backed by separate repository credentials.

## ACP and content

ACP envelopes are untrusted input. The control plane:

- enforces frame/body limits;
- validates JSON-RPC and stable ACP types;
- preserves unknown `_meta` without executing it;
- escapes content in Web rendering;
- validates filesystem paths against Session roots;
- applies permission policy before tool/terminal actions;
- rate-limits abusive update streams.

Thoughts/tool output may contain secrets from the workspace; access follows Workstream authorization.

## Browser boundary

The Browser may submit:

- Agent IDs from the public registry;
- equipment intent from the public policy projection;
- standard prompt content;
- user permission decisions.

It may not submit runtime definitions, raw capabilities, provider endpoints, commands/env, custody
references belonging to another Session, or execution-grant material.

## Supply chain

- Runtime images are pinned by digest.
- Agent adapter package versions are pinned and scanned.
- Registry changes require review.
- CI uses least-privilege tokens.
- Production deployment artifacts are provenance-attested where available.
- An adapter upgrade includes custody-compatibility and ACP contract tests.

## Audit

Security audit records include actor, Session, action class, decision, policy version and outcome.
They exclude prompt content, tool output, tokens and custody bytes.

Break-glass custody reads and policy overrides require dedicated, durable audit events.

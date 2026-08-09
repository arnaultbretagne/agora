# Security

## Threat model

The Agent and everything it executes inside a Session Runtime are untrusted. Prompt injection may
cause arbitrary code execution within that runtime.

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
          Session Runtime controller           Broker control/policy ──► OneCLI control API
                 │ workload API                  │
                 ▼                               ▼
          untrusted Session Runtime Pod ── workload ID ──► Broker access relay
          Broker access relay ── opaque CONNECT ─────────► OneCLI gateway ──► provider
```

Every arrow crosses authenticated authorization. Same-repository code does not imply same runtime
trust.

## Authentication and authorization

- Human/API requests use the platform identity provider.
- Workstream authorization is checked against durable `owner | editor | viewer` membership.
- Service-to-service calls use workload identity and authenticated TLS.
- Session Runtime materialization requires an execution grant bound to Session and Agent.
- One dedicated selective OneCLI Agent is mapped to exactly one Agora Session.
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

Only the Session Runtime controller ServiceAccount may create/delete Session Runtime workloads.

Pods materializing Session Runtimes:

- use no Kubernetes API token;
- run non-root;
- receive a restrictive security context and runtime class;
- cannot mount host paths or arbitrary PVCs;
- cannot select an image, command, env or ServiceAccount;
- cannot receive OneCLI control keys, upstream Agent bearers or provider credentials;
- have CPU, memory, PID and ephemeral-storage limits;
- carry deterministic Session/Agent labels without user-controlled label keys.

The controller validates the generated PodSpec before submission.

## Network

Default-deny NetworkPolicies isolate:

- Session Runtime Pods from product Postgres;
- Session Runtime Pods from the Kubernetes API;
- Session Runtime Pods from other Session Runtime Pods;
- public Web ingress from internal control APIs;
- Broker admin plane from Session Runtime Pods.

Session Runtime Pods may reach the authenticated Broker access relay, ACP bridge and explicitly
required internal services. They MUST NOT reach providers, the public Internet, OneCLI control API
or OneCLI gateway directly.

The relay may reach only the OneCLI gateway. OneCLI policy MUST contain reviewed explicit allows
followed by a final explicit `block *`; its Default Rule is not sufficient. Agent/runtime upgrades
require a route-set diff and negative tests for unlisted ordinary and LLM hosts.

## Secrets

- Provider secrets and subscription auth live only in OneCLI.
- The OneCLI organization/project control key is available only to Broker control.
- The dedicated OneCLI Agent upstream bearer is encrypted in Broker-private operational state and
  available only to the access relay.
- Execution-grant activation references and platform Session Runtime workload credentials are
  ephemeral and never persisted in product tables, ACP envelopes or logs.
- ACP tunnel credentials are ephemeral and redacted.
- Custody drivers exclude credential paths.
- Workspace content and custody are never placed in environment variables.
- Secrets are not embedded in registry definitions or Pod templates.
- OneCLI CA trust and `onecli-managed`/placeholder stubs are non-secret deployment assets and cannot
  be used to recover upstream authority.

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
- OneCLI is pinned by digest and its source/release provenance is verified.
- Agent adapter package versions are pinned and scanned.
- Agent images already contain pinned harness/adapter binaries; Pods install nothing at startup.
- Registry changes require review.
- CI uses least-privilege tokens.
- Production deployment artifacts are provenance-attested where available.
- An adapter upgrade includes custody-compatibility and ACP contract tests.
- A OneCLI/Agent upgrade includes route-diff, provider-auth, query-log-redaction and revocation tests.

## Audit

Security audit records include actor, Session, action class, decision, policy version and outcome.
They exclude prompt content, tool output, tokens and custody bytes.

Break-glass custody reads and policy overrides require dedicated, durable audit events.
OneCLI gateway stdout MUST omit query strings, headers and bodies. OneCLI manual approval is disabled
for content-bearing LLM/tool routes because its approval preview may summarize request bodies.

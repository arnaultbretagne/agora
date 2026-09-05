# Instructions for agents

Agora is in design phase. The current baseline is the accepted ADRs and
`docs/specs/reconciliation/`; the previous implementation is available only in Git history.

## Before working

Read [docs/AGENTS.md](docs/AGENTS.md) completely and follow its baseline and topic routing before
architecture reasoning, design answers, specification changes or implementation. Use current
repository sources, distinguish decisions from open questions, and repair conflicting contracts
before implementing dependent behavior. Do not infer the new design from retired code or schemas.

## Implementation discipline

Add implementation only for a specified behavior with identified acceptance scenarios. Introduce
its aligned machine-readable contracts, code and meaningful failure/concurrency validation together.
The old package layout and plans supply no defaults. Follow
[ADR 0001](docs/adr/0001-unified-repository.md) when adding deployables or shared packages.

Keep work scoped and commit coherent changes. Do not weaken an invariant to make a check pass.
A design scenario is not an executed test; report the actual validation and remaining limitations.
Implementation acceptance needs aligned docs/contracts, demonstrated owner behavior and safe
operational correlation, without placeholders or silent fallbacks.

## Domain and protocol invariants

- Intent is complete desired state; Observation is fresh owner evidence; Session is realized history;
  Workstream provides one canonical order. Keep those temporal meanings separate.
- Do not introduce Conversation, Run, Loge, Runtime/SessionRuntime or harness Thread as product
  aggregates, or `run_id`, `loge_id`, `runtime_id` or `native_session_id`.
- Use `harness`/`harness_id` for the integration; reserve Agent for ACP and OneCLI roles.
- Register fields, values, results and verbs before using them in rules. Use no combination profiles
  or new semantic protocol around ACP.
- Import pinned stable ACP v1 SDK types. Preserve complete envelopes, unknown metadata and lossless
  JSON numbers. Do not duplicate/fork ACP types; a bridge may authenticate/frame, never translate.
- Projections are disposable. Core treats Save bytes as opaque. Infrastructure telemetry does not
  belong in the product journal.
- Retried external operations require stable attempt identity and operation-specific recovery;
  unknown acceptance never authorizes a blind prompt or context-creation retry.

## Trust boundaries

- Browser input selects reviewed public values, not provider scopes, OneCLI identifiers, images,
  commands or executable runtime configuration. Only trusted policy compiles exact grants.
- Only runtime control owns Kubernetes workload permissions. Harness images are complete and pinned;
  Pods install no harness/adapter at startup.
- OneCLI is the sole credential gateway and grant authority. Build no parallel injector, secret
  store, MITM or provider adapter. Broker forwards provider traffic opaquely and cannot widen grants.
- A dedicated selective OneCLI Agent belongs to one Pod incarnation and may serve only successive
  Sessions on that Pod. It is never rebound to a successor or another Workstream.
- Provider secrets remain OneCLI-owned. Its control key and upstream Agent bearer never enter Pods.
  Encrypted Broker-private upstream authority is separate from product data, projections and Saves.
- Bearers, bridge tokens and provider credentials never enter ACP facts, product data, Saves or logs.
  Logs also omit query strings, headers, prompts, tool content and payload bytes.
- Revocation does not wait for ACP or Save capture. Physical retirement requires owner evidence;
  Kubernetes API absence alone cannot authorize overlapping successor execution.

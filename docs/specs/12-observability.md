# Observability

## Separation

Observability explains infrastructure and service behavior. It is not the Workstream transcript.

- ACP/product content goes to the product journal.
- Logs, metrics, traces and Kubernetes events go to OTel/Loki-compatible infrastructure stores.
- Broker security audit goes to the security audit sink.
- OneCLI request decisions remain in its operational audit store and may be exported to the security
  sink; they are never imported as Workstream events.

The application MUST NOT copy stdout/stderr or Pod logs into Postgres as product history.

## Correlation

All signals use safe identifiers when available:

- `workstream_id` in product/control-plane signals;
- `session_id` across all components;
- `agent_id`;
- `command_id`;
- `custody_snapshot_id`;
- `execution_grant_id`;
- operational OneCLI Agent ID only inside Broker/OneCLI security telemetry;
- `pod_uid`;
- W3C `traceparent`.

Provider tokens, OneCLI control/upstream bearers, URL query strings, ACP tunnel credentials, prompt
content and custody bytes are forbidden attributes.

The Loge controller only requires `session_id`; observers may join to Workstream metadata through
authorized product tooling.

## Structured logs

Logs are structured and include:

- event name;
- component/version;
- correlation IDs;
- typed result/error class;
- duration where relevant.

Default logs MUST NOT include complete ACP envelopes, prompts, tool arguments/results, terminal
output or environment variables. Temporary content logging requires an explicit local-only debug
mode and must never be enabled in production.

OneCLI gateway logs MUST render only query-free scheme/host/path plus safe decision metadata.
Collector-side filtering is defense in depth and does not excuse emitting a signed query value.

## Traces

Trace boundaries include:

- HTTP command acceptance;
- database transaction;
- execution-grant issuance;
- OneCLI Agent/rule reconciliation and relay activation;
- Loge materialization;
- ACP connection/initialize;
- prompt turn;
- custody capture/restore;
- journal-notification publication and projection/feed commit.

ACP chunks MAY be summarized as counts/bytes under the enclosing prompt span rather than one span
per chunk.

## Metrics

Required baseline metrics:

- command latency/outcomes by command type;
- active Workstreams/Sessions by phase;
- Loge provisioning/ready/delete latency;
- duplicate-Pod reconciliation incidents;
- ACP initialize/new/resume/prompt outcomes;
- prompt turn duration and stop reason;
- journal append and projection lag;
- feed subscriber lag/reconnects;
- custody capture/restore bytes, latency and failures;
- handoff range size, rendered bytes and outcome;
- grant issue/deny/revoke counts;
- Broker relay allow/deny/revoke counts;
- OneCLI policy publish/cache-invalidation outcomes;
- OneCLI gateway injected/blocked outcomes without URL queries or content;
- provider-auth renewal outcomes without provider messages.

High-cardinality IDs belong in traces/logs, not metric labels.

## Health

- Liveness proves the process event loop is responsive.
- Readiness proves required dependencies for new work.
- Loge readiness follows `08-loge-control.md`, not container liveness.
- A degraded projector may leave command ingestion ready while marking Web feed degraded, according
  to explicit deployment policy.

## Alerts

Minimum alerts cover:

- two Pods for one Session;
- repeated permanent ACP resume failure;
- custody checksum mismatch;
- anchor referencing missing custody;
- journal-notification, projection or feed lag;
- Broker authorization anomaly;
- OneCLI explicit terminal block missing/reordered;
- relay bypass/direct provider or OneCLI gateway egress attempt;
- OneCLI CA/encryption-key continuity failure;
- gateway query-string leak canary;
- leaked secret pattern detection;
- Loge unable to dematerialize/revoke;
- database role permission regression.

## User-visible diagnostics

The product may expose safe Session lifecycle states and typed failures derived from their owners.
It MUST NOT ask users to infer health from raw logs or persist a stale “live” boolean as truth.

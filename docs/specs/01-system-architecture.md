# System architecture

## Objective

Agora MUST present durable Workstreams while executing ACP Agents inside isolated, resumable Loges.
The architecture separates product history, agent protocol, runtime lifecycle, credentials,
custody, and infrastructure observability.

## Component view

```text
Browser
  │ HTTPS + resumable feed
  ▼
Web ───────────────► Control plane
                       │
                       ├── product/store repositories ─────► Postgres product.*
                       ├── projector/feed ─────────────────► Postgres projection.*
                       ├── custody metadata only ──────────► Postgres custody.*
                       ├── equipment request ──────────────► Broker/policy
                       ├── Loge lifecycle ─────────────────► Loge controller
                       └── ACP v1 over opaque bridge ──────► Loge
                                                              ├── ACP adapter
                                                              ├── harness
                                                              └── custody driver

Loge controller ── capture/restore bytes ─────────────────► Postgres custody.*
Broker ── grant/activation state ─────────────────────────► Broker-private operational store
All services/Pods ── logs, metrics, traces ────────────────► OTel/Loki
```

## Deployables and ownership

| Deployable | Owns | MUST NOT own |
|---|---|---|
| Web | rendering, local UI state, user commands | ACP, Kubernetes, grants, custody |
| Control plane | Workstreams, Sessions, ACP Client, journal, anchors, feed | Pods, provider secrets, custody bytes |
| Loge controller | Pod lifecycle, runtime definition resolution, bridge endpoint, custody streaming | Workstream content, ACP interpretation, capability policy |
| Broker | policy, grants/activations, provider credential adapters and private operational state | Workstream history, Pod lifecycle |
| Loge | one Agent Session execution | another Session, policy authority, durable product history |
| Postgres | product facts, projections, opaque custody | infrastructure logs |
| OTel/Loki | telemetry and infrastructure audit | user-visible product history |

## Trust zones

The repository is a monorepo but each deployable MUST use a distinct workload identity:

- `web`: public ingress, no direct database or runtime access;
- `control-plane`: product schema read/write, projection read/write, custody metadata read;
- `loge-controller`: Kubernetes workload API, custody payload read/write, execution-grant consume;
- `broker`: policy and provider-secret access;
- `loge`: one scoped workload identity bound to its execution grant, no Kubernetes API and no
  product database.

No shared all-powerful ServiceAccount is allowed.

## Product data path

1. The Browser submits a command with an idempotency key.
2. The control plane validates Workstream and Session invariants.
3. Any outbound ACP envelope is durably appended before dispatch.
4. Incoming ACP envelopes are appended in observation order.
5. The same transaction writes a journal-notification outbox record.
6. The projector folds canonical gaps using a per-Workstream checkpoint.
7. Projection changes and durable Web feed positions commit together.

The runtime controller never participates in this semantic data path.

## Runtime control path

1. The control plane obtains an execution grant from policy/Broker.
2. It requests `PUT /v1/loges/{session_id}`.
3. The Loge controller resolves `agent_id` from its trusted registry.
4. The controller binds the grant to the Session-specific Loge workload identity.
5. It restores custody when requested, creates the Pod and exposes safe readiness status.
6. Once ready, the control plane requests a separate one-time ACP connection.
7. The control plane establishes ACP and performs `initialize` plus `session/new` or
   `session/resume`.

The Loge controller MUST be idempotent by Session ID.

## Custody path

1. The control plane chooses a committed Workstream watermark.
2. The Loge controller asks the Session's custody driver to capture bytes.
3. The controller writes a new immutable snapshot and verifies its checksum.
4. Only after the snapshot is committed may the product anchor advance.
5. The Pod may then be deleted.

Agora core never reads or parses snapshot bytes.

## ACP transport

ACP v1 is the only semantic protocol between the control plane and Agents. If cluster topology
requires a remote bridge while the upstream remote transport evolves, the bridge MAY add:

- authentication;
- framing;
- backpressure;
- connection liveness;
- byte limits.

It MUST NOT rename methods, normalize updates, drop unknown fields or synthesize semantic responses.

## Non-goals

The baseline does not:

- support concurrent active Sessions in one Workstream;
- support one Session across several Agents;
- support sharing one Loge;
- make ACP v2 stable by local convention;
- guarantee cross-Agent reproduction of hidden model context;
- make infrastructure logs a user-facing transcript;
- permit arbitrary third-party Agent images at runtime.

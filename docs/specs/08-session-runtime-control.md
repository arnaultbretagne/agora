# Session Runtime control

## Scope

The Session Runtime controller owns the mechanism of creating and deleting isolated runtime Pods.
Product policy stays in the control plane and Broker.

Its HTTP contract is `contracts/openapi/session-runtime-control.yaml`.

## Resource identity

The resource path is:

```text
/v1/sessions/{session_id}/runtime
```

`session_id` is the Agora Session ID and the only resource key. `SessionRuntime` has no separate
identifier, persistence row or lifecycle outside its Session.

The controller MUST ensure at most one non-terminal Pod for a Session ID.

## Materialize

`PUT` is idempotent and accepts only:

- Session ID from the path;
- trusted `agent_id`;
- expected runtime-definition version;
- workspace mount reference;
- opaque execution-grant reference;
- optional custody snapshot reference;
- trace context.

It MUST NOT accept:

- arbitrary image;
- command or argv;
- environment variables;
- Kubernetes object fragments;
- provider token;
- capability list;
- Workstream history;
- ACP Session ID.

The registry and Broker resolve all privileged details.

The controller consumes `executionGrantRef` exactly once to bind the generated Session Runtime
workload identity. It may retain/label the non-secret grant ID, but MUST NOT place the reference in a
Pod, Kubernetes annotation, status object or log.

The resulting Pod receives only a fixed credential-free Broker relay endpoint, operator-managed
OneCLI CA trust and non-secret harness auth stubs. The controller MUST NOT receive or mount the
OneCLI control key, dedicated Agent upstream bearer or provider credential.

## Materialization states

- `absent`;
- `provisioning`;
- `ready`;
- `capturing`;
- `terminating`;
- `failed`.

These are live controller states and do not replace the durable Session phase.

## Reconciliation

The controller MUST reconstruct truth from Kubernetes labels and status after restart. In-memory maps
may cache but MUST NOT be authoritative.

Required labels include:

- Agora Session ID;
- Agent ID;
- runtime-definition version;
- execution-grant ID, never bearer;
- controller revision.

Pod UID and node placement are telemetry only.

If multiple Pods are observed for one Session, the controller MUST fail closed, stop returning a
ready endpoint and reconcile according to a deterministic survivor policy.

## Readiness

A Session Runtime is `ready` only when:

- workspace mounts are ready;
- optional custody restore completed;
- execution grant, dedicated OneCLI policy and workload relay binding are active;
- ACP process is running;
- authenticated bridge health passes.

Container running alone is insufficient.

## ACP endpoint

Materialization and credential minting are separate. `PUT` and `GET` return safe live status only.
Once status is `ready`, the control plane calls:

```text
POST /v1/sessions/{session_id}/runtime/acp-connections
```

The response returns:

- transport kind;
- endpoint;
- one-time or very short-lived connect credential;
- expiry;
- runtime-definition version;
- live Session Runtime state.

Credentials MUST be Session-bound, single-purpose, never stored in product tables and redacted from
logs. Repeating a connection request ID may return the same still-unused credential; a consumed or
expired credential is never revived.

## Capture

`POST /v1/sessions/{session_id}/runtime/custody-snapshots`:

- requires the Workstream watermark supplied by the control plane;
- binds `X-Request-Id` to exactly one immutable snapshot generation;
- leaves the Pod alive;
- serializes concurrent capture requests;
- returns the committed snapshot metadata;
- is idempotent by request ID;
- refuses a Session/Agent/driver mismatch.

Capture and deletion are separate operations so product Anchor commit can occur between them.

## Dematerialize

`DELETE /v1/sessions/{session_id}/runtime`:

- is idempotent;
- revokes/ends bridge credentials;
- terminates the Pod with a bounded grace period;
- revokes the execution grant and relay mapping and rotates/disables OneCLI Agent authority;
- waits or reports asynchronous deletion state;
- never captures custody implicitly.

Callers must request capture explicitly.

## Idle collection

The controller MAY garbage-collect an idle materialized Session Runtime only after asking the
control plane to perform a durable suspension or after an emergency hard limit.

It MUST NOT silently delete a healthy resumable context whose latest state has no committed custody.

## Agent isolation

Each Pod:

- runs one Session;
- uses a non-root identity;
- has no Kubernetes API token;
- receives only its Session-bound workload identity for Broker-relay access;
- can reach the Broker relay but not providers, the Internet or OneCLI directly;
- cannot access product Postgres or another Session's workspace/custody.

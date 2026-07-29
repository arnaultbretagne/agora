# Loge control

## Scope

The Loge controller owns the mechanism of creating and deleting isolated runtime Pods. Product
policy stays in the control plane and Broker.

Its HTTP contract is `contracts/openapi/loge-control.yaml`.

## Resource identity

The resource path is:

```text
/v1/loges/{session_id}
```

`session_id` is the Agora Session ID and is also the logical Loge key. There is no `group`, `run_id`
or separate Loge identifier.

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

The controller consumes `executionGrantRef` exactly once to bind the generated Loge
workload identity. It may retain/label the non-secret grant ID, but MUST NOT place the reference in a
Pod, Kubernetes annotation, status object or log.

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

A Loge is `ready` only when:

- workspace mounts are ready;
- optional custody restore completed;
- execution grant is consumable;
- ACP process is running;
- authenticated bridge health passes.

Container running alone is insufficient.

## ACP endpoint

Materialization and credential minting are separate. `PUT` and `GET` return safe live status only.
Once status is `ready`, the control plane calls:

```text
POST /v1/loges/{session_id}/acp-connections
```

The response returns:

- transport kind;
- endpoint;
- one-time or very short-lived connect credential;
- expiry;
- runtime-definition version;
- live Loge state.

Credentials MUST be Session-bound, single-purpose, never stored in product tables and redacted from
logs. Repeating a connection request ID may return the same still-unused credential; a consumed or
expired credential is never revived.

## Capture

`POST /v1/loges/{session_id}/custody-snapshots`:

- requires the Workstream watermark supplied by the control plane;
- binds `X-Request-Id` to exactly one immutable snapshot generation;
- leaves the Pod alive;
- serializes concurrent capture requests;
- returns the committed snapshot metadata;
- is idempotent by request ID;
- refuses a Session/Agent/driver mismatch.

Capture and deletion are separate operations so product Anchor commit can occur between them.

## Dematerialize

`DELETE /v1/loges/{session_id}`:

- is idempotent;
- revokes/ends bridge credentials;
- terminates the Pod with a bounded grace period;
- revokes the execution grant;
- waits or reports asynchronous deletion state;
- never captures custody implicitly.

Callers must request capture explicitly.

## Idle collection

The controller MAY garbage-collect an idle materialized Loge only after asking the control plane to
perform a durable suspension or after an emergency hard limit.

It MUST NOT silently delete a healthy resumable context whose latest state has no committed custody.

## Agent isolation

Each Pod:

- runs one Session;
- uses a non-root identity;
- has no Kubernetes API token;
- receives only its Session-bound workload identity for Broker data-plane access;
- has network access constrained by policy and required Agent endpoints;
- cannot access product Postgres or another Session's workspace/custody.

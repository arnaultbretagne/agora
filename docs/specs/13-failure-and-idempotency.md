# Failure model and idempotency

## Principles

- Durable intent precedes external side effects.
- Retried commands reuse the same idempotency key.
- Safe retries are explicit per operation.
- Unknown delivery is not reported as success or silently duplicated.
- Compensation never rewrites history.
- Runtime state is reconciled from its owner.

## Command states

```text
accepted -> dispatching -> acknowledged -> completed
                    │             │
                    ├-> unknown   └-> failed
                    └-> failed
```

`unknown` means the remote side may have accepted the operation but Agora lacks proof. Resolution is
operation-specific.

## Retry classification

| Operation | Automatic retry | Rule |
|---|---|---|
| Create Workstream/Session rows | yes | database transaction + idempotency key |
| Issue equivalent execution grant | yes | same Session and capability digest |
| Reconcile dedicated OneCLI Agent | yes | deterministic Session mapping; selective mode required |
| Publish OneCLI policy | conditional | same policy digest; verify complete ordered published state |
| Bind grant/relay workload identity | yes | same request, Session, Agent and identity only |
| Materialize Loge | yes | idempotent `PUT` by Session |
| Read Loge status | yes | read-only |
| ACP `initialize` | connection-scoped | reconnect creates a new connection |
| ACP `session/new` | no after unknown acceptance | reconcile if Agent supports discovery; otherwise fail provisioning |
| ACP `session/resume` | only before accepted response | same Session ID, classified transport errors |
| ACP `session/prompt` | no blind retry after possible acceptance | preserve command as unknown and reconcile/user-decision |
| ACP cancel | yes | notification is idempotent in effect |
| Capture custody | yes | same capture request ID; one committed generation |
| Dematerialize Loge | yes | idempotent `DELETE` |
| Revoke grant | yes | idempotent |
| Rotate/delete OneCLI Agent authority | yes | same Session/grant cleanup intent |
| Projection apply | yes | event ID/checkpoint |
| Journal outbox publish | yes | event identity + per-Workstream canonical-head sweep |
| Feed read/replay | yes | durable feed position + idempotent item operation |

## Prompt delivery ambiguity

ACP v1 does not provide a universal product-level idempotency key for prompts. Therefore:

- the control plane journals before dispatch;
- the bridge acknowledges transport acceptance;
- once acceptance is possible, the same prompt MUST NOT be automatically sent again;
- reconnect attempts first recover the active response or restored Session state;
- unresolved ambiguity becomes a user-visible `prompt_delivery_unknown`;
- a user retry is a new prompt turn with a new command ID.

Adapters MAY provide stronger deduplication via opaque `_meta`, but core correctness MUST NOT depend
on it.

## Crash matrix

### Control plane crashes before dispatch

Command remains accepted; dispatcher safely sends it.

### Control plane crashes after prompt acceptance

On restart it reconnects when possible and continues journaling. It does not blindly resend.

### Loge controller crashes during provision

Reconciliation reads Kubernetes labels/status and completes or fails the same materialization.

### Pod dies without a fresh capture

Restore the latest anchored snapshot and hand off the Workstream range after its watermark. Events
already journaled remain product history.

### Capture commits but Anchor update crashes

The snapshot is unreferenced but discoverable. Reconciliation may attach it only after verifying
Session, Agent and watermark; otherwise retention cleanup removes it.

### Anchor commits but Pod deletion crashes

The Pod remains live. Deletion is retried; the durable snapshot is already safe.

### Projection crashes

Journal ingestion continues if capacity policy allows. The projector resumes from its checkpoint or
rebuilds. Clients may see a declared feed delay, never fabricated completeness.

### Broker is unavailable

No new Loge is materialized. Existing grants follow their expiry; the system does not bypass policy
or inject provider secrets directly.

### Broker creates a OneCLI Agent then crashes

Reconciliation finds the deterministic Session mapping, forces selective mode and either completes
the exact policy digest or revokes/deletes the orphan. It never creates a second OneCLI Agent for the
Session.

### OneCLI policy publication is unknown

The grant remains inactive. Reconciliation reads the effective published rule order and only
activates when all explicit allows and the final `block *` match the expected digest.

### Broker access relay is unavailable

The Loge has no provider path. It does not receive the upstream OneCLI bearer and cannot connect
directly to OneCLI or providers.

### OneCLI gateway is unavailable

Active Agent calls fail with a typed runtime/provider-path failure. No custom gateway, direct
credential injection or provider fallback is attempted.

### OneCLI CA or encryption state is incompatible

Readiness fails closed. Operators restore the compatible OneCLI database, `/app/data` and external
encryption key or execute an explicit CA rotation; existing Loges are not silently reconfigured.

## Timeouts

Timeouts are typed by phase:

- `grant_timeout`;
- `onecli_policy_timeout`;
- `relay_activation_timeout`;
- `loge_provision_timeout`;
- `acp_connect_timeout`;
- `acp_initialize_timeout`;
- `session_new_timeout`;
- `session_resume_timeout`;
- `prompt_timeout`;
- `custody_capture_timeout`;
- `loge_delete_timeout`.

A timeout does not imply the remote side did nothing; its retry classification controls next steps.

## Reconciliation loops

Reconcilers MUST be:

- level-based, not dependent on missed in-memory events;
- bounded and backoff-aware;
- idempotent;
- observable;
- able to stop on permanent typed failure.

No reconciler may create a new Session as an invisible fallback.

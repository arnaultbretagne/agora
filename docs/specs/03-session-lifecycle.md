# Session lifecycle

## Durable phases

```text
requested
    │
    ▼
provisioning ───────► failed
    │
    ▼
ready ◄────────────► busy
  │  ▲                │
  │  └──── resume ────┘
  ▼
suspending ─────────► suspended
  │                    │
  │ failure            └── materialize + ACP resume ──► ready
  ▼
failed

ready | busy | suspended ── close ──► closing ──► closed
```

`phase` describes durable product/protocol progress, not raw Kubernetes status.

## New Session

1. Agora resolves `agent_id` to the controller-authoritative current runtime-definition version.
2. In one transaction, Agora creates the Session in `requested`, freezes Agent version,
   workspace/equipment intent and makes it current when requested.
3. Policy resolves capability intent and atomically binds its policy version, capability digest and
   independent capability facts.
4. Broker issues the execution grant only after the dedicated selective OneCLI Agent and complete
   allow-then-block policy are ready.
5. Phase advances to `provisioning`.
6. The control plane materializes the Session Runtime without custody; the controller binds the
   grant to its workload identity and credential-free relay path.
7. It opens an ACP connection and calls `initialize`.
8. It persists the negotiated protocol version and capabilities.
9. It calls `session/new` with the Session workspace and allowed MCP servers.
10. It binds the returned `acp_session_id` exactly once.
11. Phase advances to `ready`.

Any failure before ACP binding completes at step 10 leaves an unbound failed Session. Its Agora ID
MUST NOT be reused, and Broker/controller reconciliation MUST revoke any partial OneCLI/relay
authority.

## Prompt turn

1. Validate the Session is current and category cardinality allows the prompt.
2. Rematerialize/resume first if suspended.
3. Persist the outbound `session/prompt` envelope with its idempotency key and `purpose`.
4. Dispatch the exact envelope.
5. Mark the Session `busy`.
6. Persist all callbacks, requests and `session/update` notifications.
7. Persist `PromptResponse`, including stop reason.
8. Return the Session to `ready`, unless closing or failed.

Only one prompt turn may be in flight per Session in v1.

## Suspend

Suspension is a product operation, not merely Pod deletion:

1. Stop accepting new prompt turns.
2. If busy, either await completion or cancel according to the caller's explicit policy.
3. Select the current committed Workstream watermark.
4. Ask the Session Runtime controller to capture a custody snapshot while leaving the Pod alive.
5. Verify snapshot metadata and atomically commit the corresponding Agent anchor.
6. Call ACP `session/close` when supported and appropriate.
7. Dematerialize the Session Runtime.
8. Set phase to `suspended`.

If capture fails, the anchor MUST NOT advance and the controller MUST NOT intentionally delete a
healthy Pod. An operator may explicitly force-close a broken Session, resulting in `failed` or
`closed` without a newer resume point.

## Resume

1. Read the anchor and referenced custody snapshot.
2. Obtain a new execution grant with the Session's persisted capability facts.
3. Rotate/rebind the same Session's dedicated OneCLI Agent authority and complete route policy.
4. Rematerialize the same Session's runtime using that snapshot.
5. Connect and initialize ACP.
6. Verify the Agent advertises `sessionCapabilities.resume`.
7. Call `session/resume` with the persisted `acp_session_id`, workspace and allowed MCP servers.
8. Do not ingest historical content as new Workstream content.
9. If the Workstream advanced after the snapshot watermark, perform a handoff for the delta.
10. Set phase to `ready`.

`session/load` is not the normal resume path because it replays history already persisted by Agora.

## Resume failure

A failed native resume is terminal for that Session unless the error is classified as transient
before the ACP method is accepted.

For a permanent failure:

1. retain the failed Session and its custody for diagnosis/retention;
2. mark it `failed` with a typed reason;
3. create a new Session;
4. seed the new Session from the Workstream using the handoff policy;
5. never bind the new ACP context to the old Agora Session ID.

## Agent switch

Only one Session is current. Switching:

1. suspends the current Session durably;
2. selects an existing resumable Session for the target Agent or creates a new one;
3. activates it transactionally;
4. resumes/restores it when possible;
5. sends only the missing Workstream range as a handoff.

Switching Agent never mutates `agent_id` on an existing Session.

## Close

Close means no future prompt will be accepted for that Session. It:

- cancels active work;
- asks ACP to close when supported;
- captures custody only if retention policy requests a final snapshot;
- dematerializes the Session Runtime;
- revokes the execution grant, relay mapping and OneCLI Agent authority;
- records a terminal reason.

Closed and failed Sessions remain part of Workstream history.

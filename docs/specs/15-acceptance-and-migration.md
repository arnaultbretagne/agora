# Acceptance and migration

## Baseline acceptance

The architecture is implementation-complete only when the following black-box scenarios pass.

### Invocation

- Create an invocation with one prompt.
- Observe messages, thoughts, plan and tool-call updates in order.
- Attempt a second user prompt and receive `invocation_already_prompted`.
- Rebuild projections and obtain the same visible result.

### Discussion

- Create a discussion and complete several prompt turns in one Session.
- Change ACP mode/config through standard operations.
- Suspend and resume without duplicate history.
- Load an item page, reconnect the feed from its returned position, force a reset and refetch without
  loss or duplication.

### One Session, one Session Runtime

- Concurrent materialize requests produce one Pod.
- No independent `runtime_id` or Session Runtime entity exists.
- A Pod or workload identity cannot be attached to another Session.
- Controller restart reconstructs the same state from Kubernetes.
- A rematerialized Session may have a new Pod UID while retaining only the same Session identity.

### Custody

- Capture a native state, commit Anchor, delete Pod, restore, and resume.
- Corrupt bytes and prove restore fails before Agent readiness.
- Deny custody payload reads to Web/control-plane database roles.
- Prove credential paths are absent from snapshots.

### Cross-Agent handoff

- Run Agent A through Workstream sequence C.
- Suspend A and commit its Anchor.
- Run Agent B from C through D.
- Resume A and transmit exactly `(C,D]`.
- Display one Handoff card without duplicating source items.
- Crash before A's next capture and prove the same delta can be applied from its old durable Anchor.

### Failure

- Lose each component at every boundary described in `13-failure-and-idempotency.md`.
- Prove no invisible fresh Session, duplicate prompt, lost journal event, premature Anchor or leaked
  execution grant.

### Security

- Reject arbitrary image/command/env through the Session Runtime API.
- Reject browser-supplied raw capabilities.
- Enforce owner/editor/viewer membership and reject removal of the last owner.
- Deny cross-Session custody and ACP bridge use.
- Prove Broker descriptors contain no token and a grant cannot bind to a second Session workload
  identity.
- Run real Claude Max and ChatGPT/Codex through ACP, the workload relay and the adopted OneCLI
  gateway.
- Prove each Session owns a distinct selective OneCLI Agent and no default/`all` Agent serves a
  Session Runtime.
- Prove the Agent Pod cannot read/replay the OneCLI control key, upstream Agent bearer or provider
  credential.
- Prove explicit allows followed by `block *` deny both unlisted ordinary and recognized LLM hosts.
- Prove direct provider, Internet and OneCLI gateway/control access from the Agent Pod is denied.
- Seed signed query/token canaries and prove Broker/OneCLI stdout and audit remain content/token
  free.
- Prove OneCLI restart/restore preserves credential decryption and CA continuity.
- Prove no custom/parallel credential gateway or provider-secret adapter exists.
- Revoke Broker access after dematerialization.
- Prove Session Runtime Pods cannot reach product Postgres or Kubernetes API.

## Contract gates

Every implementation phase runs:

- OpenAPI request/response conformance;
- JSON Schema fixtures;
- SQL migration and constraint tests on real Postgres;
- ACP v1 compatibility fixtures from the pinned SDK;
- projection rebuild equivalence;
- fault-injection tests;
- authorization tests with actual database roles.

## Repository migration

The old application tree is intentionally removed. Production migration is a replacement, not an
in-place module refactor.

Historical source code remains recoverable through Git history and the independent
`agent-runtime` repository until decommissioning is complete.

## Existing product data

The baseline MUST NOT fabricate ACP envelopes for legacy messages. Before production cutover, the
operator chooses one explicit policy:

1. start a fresh product database and retain a read-only export of legacy data; or
2. add a separately specified legacy read model/import format through a new ADR.

No coding agent may improvise a lossy mapping from old Conversations/Runs into ACP Sessions.

Custody from the old Claude-specific manager is not automatically compatible. Compatibility is
proven by the Claude Agent plan or old runtime state is archived.

## Delivery stages

1. Contracts and repository checks.
2. Domain and Postgres store.
3. Single-Agent invocation vertical slice.
4. Discussion and Web projection.
5. Custody suspend/resume.
6. Cross-Agent handoff.
7. OneCLI-backed Broker/grants, opaque relay and hardened Session Runtimes.
8. Claude and Codex acceptance.
9. Shadow deployment.
10. Explicit data policy and production cutover.
11. Decommission old Agora and `agent-runtime`.

Each stage has an independent rollback. No stage writes both old and new product models as equal
sources of truth.

## Go-live criteria

- all baseline scenarios pass in a production-like cluster;
- backup/restore is proven independently for Agora product/custody and the compatible OneCLI
  database + `/app/data` + external encryption-key recovery set;
- security review closes all critical/high findings;
- SLOs and alerts exist;
- adapter auth/custody gates pass for both selected Agents;
- operator runbooks cover stuck Session Runtimes, custody failure, Broker/relay/OneCLI outage,
  provider-auth renewal, CA rotation and rollback;
- no deprecated concept remains in current code or contracts.

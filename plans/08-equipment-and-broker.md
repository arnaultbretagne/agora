# P08 — OneCLI-backed capability Broker

- **Status:** pending; OneCLI adoption spike complete
- **Dependencies:** P01, P04
- **Primary paths:** `apps/broker`, `packages/equipment-policy`, `contracts/openapi`

## Required reading

- `apps/broker/ONECLI-SPIKE.md`
- `docs/specs/08-session-runtime-control.md`
- `docs/specs/10-equipment-and-broker.md`
- `docs/specs/11-security.md`
- `docs/specs/12-observability.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0010, 0011, 0014

## Completed adoption gate

The spike fixed the implementation direction:

- [x] self-hosted OneCLI `1.43.3` ran the operator's real Claude Max credential;
- [x] self-hosted OneCLI ran the operator's real ChatGPT/Codex OAuth state;
- [x] provider credentials stayed out of the client process/filesystem;
- [x] selective OneCLI Agent credential isolation and immediate rotation worked;
- [x] explicit allow rules followed by `block *` enforced a real allow-list;
- [x] restart recovered encrypted credentials with the external key;
- [x] failed gates and production blockers were recorded with redacted evidence.

Evidence: [`apps/broker/ONECLI-SPIKE.md`](../apps/broker/ONECLI-SPIKE.md).

## Locked implementation boundary

OneCLI is the sole MITM, provider-secret store and credential injector.

Agora implements only:

- equipment intent and capability policy;
- OneCLI control-plane lifecycle;
- execution-grant/workload binding;
- an opaque access relay that authenticates the Session Runtime workload and supplies upstream
  proxy auth;
- safe deployment, policy and audit integration.

The relay MUST NOT terminate provider TLS, inspect provider payloads, inject credentials or contain
provider-specific behavior. The old gateway/provider adapters are not candidates for reuse.

The runtime mapping is fixed:

```text
one Agora Session -> its SessionRuntime -> one selective OneCLI Agent
```

The OneCLI Agent may be retained for suspension/resume of that same Session, with its token rotated
or access disabled while inactive. It is deleted at terminal Session/Workstream cleanup and is never
reassigned.

## Deliverables

- Equipment catalogue projection and request validation.
- Deterministic policy resolver to independent capability facts and digest.
- Broker control API conforming to `broker-control.yaml`.
- Pinned `@onecli-sh/sdk` control adapter using `getContainerConfig`.
- Idempotent dedicated OneCLI Agent create/selective/configure/rotate/delete lifecycle.
- Deterministic route-policy compiler with explicit allows and final `block *`.
- Session-bound execution-grant repository outside `product.*`.
- Workload-authenticated, non-MITM access relay to OneCLI's gateway.
- Safe runtime bundle containing only relay endpoint, CA trust and non-secret auth stubs.
- Query-free OneCLI gateway logs with a regression test.
- Broker/OneCLI security audit containing safe IDs and decisions, never content/tokens.
- Disposable self-hosted OneCLI integration environment with pinned image digest.

## Tasks

- [ ] Reject raw provider scopes, endpoints, secret values and arbitrary OneCLI rules from Browser
  or product APIs.
- [ ] Define policy versioning and deterministic capability digest.
- [ ] Persist only normalized capability facts against the Session.
- [ ] Keep OneCLI identifiers and operational policy rows out of product schemas/history.
- [ ] Authenticate the OneCLI control API only from the Broker control adapter.
- [ ] Create exactly one uniquely identified OneCLI Agent for each Session and force selective mode.
- [ ] Compile the pinned Agent route set plus approved capability routes into first-match policy.
- [ ] Publish explicit allows followed by a final explicit `block *`; never rely on Default Block.
- [ ] Diff/publish policy idempotently and fail closed on partial publication/cache invalidation.
- [ ] Call `getContainerConfig`; reject unavailable/incomplete responses instead of launching.
- [ ] Verify returned CA/stub material against P04's operator-managed runtime bundle and fail closed
  on drift; do not add it to the activation response.
- [ ] Strip the upstream `aoc_` bearer from all Pod-facing configuration.
- [ ] Keep the upstream bearer encrypted in Broker-private operational state and expose it only to
  the access relay.
- [ ] Bind `grant + session_id + agent_id + workload_identity` exactly once.
- [ ] Authenticate workload identity outside the Agent container and reject replay from another
  workload.
- [ ] Relay CONNECT traffic opaquely to OneCLI without provider TLS termination or body access.
- [ ] Enforce expiry/revocation at the relay and rotate/delete OneCLI authority idempotently.
- [ ] Renew only an unchanged capability digest; rotate upstream authority behind the same binding.
- [ ] Reconcile dedicated Agent without a materialized runtime, materialized runtime without an
  active grant and stale-relay-mapping states.
- [ ] Provide the controller a credential-free, operator-managed CA/stub/runtime bundle.
- [ ] Patch/upstream OneCLI logging to remove `path_and_query` before stdout.
- [ ] Disable OneCLI manual approval for content-bearing LLM/tool routes.
- [ ] Narrow OpenAI/ChatGPT hosts to the audited route set required by the pinned Codex image.
- [ ] Emit safe issue/activate/deny/use-class/renew/revoke audit events.
- [ ] Add restart smoke coverage for PostgreSQL, `/app/data` and external encryption-key continuity.
- [ ] Remove all profile, `runId`, former gateway and provider-adapter port candidates.

## Required tests

- Unknown/contradictory equipment intent is denied before OneCLI mutation.
- Request combinations resolve to independent facts, not named profiles.
- Concurrent equivalent issue creates one grant and one OneCLI Agent.
- Session A and B receive distinct selective OneCLI Agents and policy sets.
- Session A cannot use Session B's relay binding or upstream OneCLI authority.
- The Agent process, environment, filesystem, ACP envelopes and custody fixtures contain no OneCLI
  control key, upstream bearer or provider credential.
- Exact required host succeeds; an unlisted uncredentialed host and an unlisted LLM host both fail.
- Reordering/removing the terminal `block *` fails validation/publication.
- Direct Agent Pod egress to provider, OneCLI gateway and OneCLI control API is denied.
- Revocation immediately blocks the relay and rotates/deletes upstream authority.
- Renewal with a changed capability digest is rejected.
- Broker/relay restart preserves correct state or invalidates it fail-closed.
- OneCLI API outage and SDK `false` result prevent Session Runtime readiness.
- OneCLI CA/stub drift from the controller's pinned runtime bundle prevents activation.
- Policy publish/cache-invalidation ambiguity prevents activation.
- Gateway stdout, request audit and Broker logs contain no query string, prompt/tool content or
  token under seeded leak canaries.
- OneCLI Pod replacement with persistent state preserves credential decryption and CA continuity.
- Cleanup after every crash boundary cannot leave usable orphan authority.

## Non-goals

- No custom MITM, CA issuer, provider-secret store or credential injector.
- No parallel Claude/OpenAI/GitHub/Vault credential adapters in Agora.
- No production use of `onecli run` or SDK `applyContainerConfig`.
- No ACP adapter/custody implementation; P09/P10 validate those on this fixed path.
- No Browser access to OneCLI.
- No production HA/capacity/cutover work beyond integration fixtures; P11 owns it.

## Exit criteria

- A fake Agent Pod uses only its bound relay and OneCLI Agent to reach explicitly granted routes.
- No provider or OneCLI control/upstream credential enters the Session Runtime Pod.
- OneCLI is observably the only provider TLS/credential-injection hop.
- Every known spike blocker has an implemented regression test or an explicit P09/P10/P11 gate.
- P09/P10 can run their pinned harness through OneCLI without learning gateway control material.

## Evidence

To be completed by the implementing agent. The adoption evidence is already recorded in
[`apps/broker/ONECLI-SPIKE.md`](../apps/broker/ONECLI-SPIKE.md).

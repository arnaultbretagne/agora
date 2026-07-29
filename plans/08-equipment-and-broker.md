# P08 — Capability grants and Broker port

- **Status:** pending; blocked until ADR 0010 and ADR 0014 are accepted
- **Dependencies:** P01
- **Primary paths:** `apps/broker`, `packages/equipment-policy`, `contracts/openapi`

## Required reading

- `docs/specs/10-equipment-and-broker.md`
- `docs/specs/11-security.md`
- ADR 0010, 0011, 0014

## Mandatory adopt-before-build spike

Evaluate a self-hosted OneCLI deployment before porting or writing gateway/MITM code. Treat the ACP
adapter and credential gateway as independent axes.

- [ ] `onecli run -- claude` works with the operator's actual Claude Max/long-lived subscription
  authentication in a fresh isolated Loge.
- [ ] `onecli run -- codex` works with the operator's actual ChatGPT/Codex subscription
  authentication.
- [ ] The selected Claude/Codex ACP adapters can launch their underlying harness through the
  gateway without losing ACP new/resume/update behavior.
- [ ] Raw stored/provider credentials are inaccessible to the Agent process, filesystem, ACP
  envelopes and custody capture.
- [ ] Session A cannot use Session B's gateway authority or provider connections.
- [ ] Grant activation, expiry, renewal and immediate revocation can be mapped without a fixed
  combination profile.
- [ ] Required MCP/provider routes are allow-listed; arbitrary gateway use cannot bypass capability
  facts.
- [ ] Logs/audit expose decisions and safe IDs but no prompt/tool content or tokens.
- [ ] Pod replacement and subscription renewal have an explicit non-interactive operating path.
- [ ] Self-hosting, version pinning, backup and failure behavior meet production requirements.

Write `apps/broker/ONECLI-SPIKE.md` with versions, topology, commands, redacted evidence, failed
gates and the precise adopt/wrap/build recommendation. No custom gateway port begins before this
report is reviewed.

## Reuse audit

Inspect old `agent-runtime/src/broker` behavior:

- likely reuse: provider token issuers, provider adapters, credential helper behavior, revocation
  tests, secret stripping;
- rewrite: profile catalogue, profile claims, `runId`, admin request, authorization lookup,
  profile-projected UI model.

Port security invariants before convenience behavior. Record source commit/path for each port.
Only behaviors missing from the accepted OneCLI recommendation are candidates for reuse.

## Deliverables

- Equipment catalogue projection and request validation.
- Policy resolver to independent capability facts.
- Broker control API conforming to `broker-control.yaml`.
- Session-bound execution-grant lifecycle.
- Broker-private grant/activation repository with restart-safe or fail-closed semantics.
- Capability-based data-plane authorization.
- Safe MCP server descriptors.
- Ported Claude/GitHub/Vault adapters behind grant claims.

## Tasks

- [ ] Define policy versioning and deterministic capability digest.
- [ ] Reject raw capability/provider scope input from Browser/control API.
- [ ] Persist returned capability facts through Session creation.
- [ ] Issue, renew-equivalent and revoke grants idempotently.
- [ ] Bind a transient grant reference once to the controller-created Loge workload identity.
- [ ] Persist/reconcile issuance, activation, expiry and revocation outside the product schemas.
- [ ] Ensure renewal cannot change capability digest.
- [ ] Authorize every adapter route by capability fact and constraints.
- [ ] Strip grant material before provider adapter.
- [ ] Keep real downstream credentials inside isolated adapters.
- [ ] Remove all profile names and `runId` claims.
- [ ] Produce safe ACP MCP descriptors with no provider secret.
- [ ] Prove ACP MCP descriptors contain no token and Broker authenticates outside the descriptor.
- [ ] Port audit events without request content/tokens.

## Required tests

- Arbitrary/unknown resource intent is denied.
- Request combinations do not require named combination profiles.
- Loge cannot add capability to a grant.
- Grant for Session A is denied for B.
- A grant reference cannot be activated for two workload identities.
- Renewal with changed digest is denied.
- Revocation immediately blocks data plane.
- Broker restart preserves correct grant state or invalidates it fail-closed.
- Provider token never reaches Loge-facing response/log.
- No activation or workload credential reaches an ACP envelope/product journal row.
- Existing GitHub/Vault security invariants remain green.

## Non-goals

- No production Agent auth decision in this plan.
- No user-defined policy language.
- No mutable equipment on an existing Session.

## Exit criteria

- Fake Loge accesses only explicitly granted adapters.
- Old profile-centric modules have no ported equivalent.
- P09/P10 can request Agent invocation and tools without receiving provider secrets.

## Evidence

To be completed by the implementing agent.

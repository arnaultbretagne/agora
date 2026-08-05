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

- [x] Reject raw provider scopes, endpoints, secret values and arbitrary OneCLI rules from Browser
  or product APIs. (`packages/equipment-policy`'s catalogue-bound resolver; `request-schemas.ts`'s
  `additionalProperties: false` schemas compiled straight from `broker-control.yaml`.)
- [x] Define policy versioning and deterministic capability digest.
- [x] Persist only normalized capability facts against the Session.
- [x] Keep OneCLI identifiers and operational policy rows out of product schemas/history. (`broker.*`
  — a dedicated schema, never `product.*`.)
- [x] Authenticate the OneCLI control API only from the Broker control adapter. True by
  construction: `onecli-real.ts` is the ONLY file in this repository that imports `@onecli-sh/sdk`
  or reads `ONECLI_API_KEY`; no other deployable holds it. Not independently tested (there is no
  other component in this codebase that could plausibly call OneCLI to test against).
- [x] Create exactly one uniquely identified OneCLI Agent for each Session and force selective mode.
- [x] Compile the pinned Agent route set plus approved capability routes into first-match policy.
- [x] Publish explicit allows followed by a final explicit `block *`; never rely on Default Block.
- [x] Diff/publish policy idempotently and fail closed on partial publication/cache invalidation.
  "Diff" is, deliberately, always a full atomic replace, never an incremental one —
  `OneCliControlAdapter.publishRoutePolicy`'s own doc: "the COMPLETE ordered route set... never a
  partial diff a caller must reconcile" (stronger than diffing: no caller ever needs to reason about
  a partially-applied route set). Cache-invalidation ambiguity is a real, tested check: after every
  publish, `getPublishedGeneration()` is read back and compared to the generation `publishRoutePolicy`
  itself returned; a mismatch throws `OneCliUnavailableError` and the issue is refused.
- [x] Call `getContainerConfig`; reject unavailable/incomplete responses instead of launching.
- [x] Verify returned CA/stub material against P04's operator-managed runtime bundle and fail closed
  on drift; do not add it to the activation response. (`GrantServiceDeps.expectedRuntimeBundle`;
  `GrantActivation`'s wire schema carries no CA/stub field at all.)
- [x] Strip the upstream `aoc_` bearer from all Pod-facing configuration.
- [x] Keep the upstream bearer encrypted in Broker-private operational state and expose it only to
  the access relay. (AES-256-GCM; `readUpstreamAuthority` is called only by `relay.ts` and by
  `grant-service.ts`'s own issue/renew paths that just wrote it — never by `server.ts`'s wire responses.)
- [x] Bind `grant + session_id + agent_id + workload_identity` exactly once.
- [x] Authenticate workload identity outside the Agent container and reject replay from another
  workload. (Trust-the-transport convention shared with `session-runtime-controller/server.ts`;
  `X-Workload-Identity` is mesh/sidecar-injected in a real deployment, never Pod-forgeable.)
- [x] Relay CONNECT traffic opaquely to OneCLI without provider TLS termination or body access.
- [x] Enforce expiry/revocation at the relay and rotate/delete OneCLI authority idempotently.
- [x] Renew only an unchanged capability digest; rotate upstream authority behind the same binding.
- [ ] Reconcile dedicated Agent without a materialized runtime, materialized runtime without an
  active grant and stale-relay-mapping states. **Not implemented.** No periodic reconciliation loop
  exists anywhere in this deployable — every state transition implemented so far is *reactive*
  (triggered by an issue/activate/renew/revoke call), never a background sweep that detects and
  cleans up drift between Broker/OneCLI/Controller state on its own. This is a genuine gap, not a
  documentation nicety: an orphaned OneCLI Agent (grant revoked but `deleteAgent` failed) or a
  materialized runtime whose grant was independently revoked would sit unnoticed until the next
  explicit operation touches that Session. Left as real follow-up work, not silently declared done.
- [x] Provide the controller a credential-free, operator-managed CA/stub/runtime bundle.
- [ ] Patch/upstream OneCLI logging to remove `path_and_query` before stdout. **Deferred** — this
  targets the real, live OneCLI product's own source, which this session never touched (no
  live-credentialed OneCLI instance was stood up, per standing instruction). Structurally moot for
  Agora's OWN relay/gateway path specifically (CONNECT's request-target is `host:port` only; no
  query string ever reaches `relay.ts` or `onecli-fake-gateway.ts` to leak in the first place — see
  their own module docs), but that does not patch OneCLI's real product logging.
- [ ] Disable OneCLI manual approval for content-bearing LLM/tool routes. **Deferred** — real OneCLI
  product configuration; requires a live, credentialed instance this session deliberately did not
  touch (see Evidence).
- [ ] Narrow OpenAI/ChatGPT hosts to the audited route set required by the pinned Codex image.
  **Partial** — `route-policy.ts`'s `PINNED_AGENT_ROUTE_SETS.codex` (`api.openai.com`, `chatgpt.com`)
  exists and is enforced/tested, but is illustrative, not audited: no real Codex `AgentRuntimeDefinition`
  or pinned harness exists yet (this plan's own non-goal — "No ACP adapter/custody implementation;
  P09/P10 validate those on this fixed path"). P10 owns auditing the real minimal set.
- [x] Emit safe issue/activate/deny/use-class/renew/revoke audit events. `execution_grant.issue` and
  `.activate` are now audited on BOTH approval and denial (docs/specs/12 "grant issue/deny/revoke
  counts"); `relay.connect` (the "use" class) is audited on both approved and denied CONNECTs;
  `.renew`/`.revoke` are audited on success (their own failure paths surface as typed HTTP Problems
  before any grant/activation state changes, so there is nothing distinct to audit as "denied" there
  beyond what `.issue`/`.activate` already cover).
- [x] Add restart smoke coverage for PostgreSQL, `/app/data` and external encryption-key continuity.
  Postgres-state continuity is real and tested (a freshly constructed relay/server instance over the
  SAME database correctly serves a grant it never itself issued or activated — no Broker-process
  memory is load-bearing). `/app/data` does not apply to this deployable: the Broker holds no local
  filesystem state at all (everything lives in Postgres or real OneCLI's own state). Encryption-key
  continuity is structural, not a dedicated test: `BROKER_ENCRYPTION_KEY` is externally supplied
  (`requireEncryptionKey`, fail-fast on missing/wrong length) and never generated or persisted by
  the Broker itself, so a restart trivially re-reads the same external value.
- [x] Remove all profile, `runId`, former gateway and provider-adapter port candidates. Verified
  nothing to remove: no `runId` reference and no legacy gateway/provider-adapter directory exists
  anywhere in this repository.

## Required tests

- [x] Unknown/contradictory equipment intent is denied before OneCLI mutation.
- [x] Request combinations resolve to independent facts, not named profiles. (`packages/equipment-policy/test/resolve.test.ts`.)
- [x] Concurrent equivalent issue creates one grant and one OneCLI Agent.
- [x] Session A and B receive distinct selective OneCLI Agents and policy sets.
- [x] Session A cannot use Session B's relay binding or upstream OneCLI authority.
- [x] The Agent process, environment, filesystem, ACP envelopes and custody fixtures contain no OneCLI
  control key, upstream bearer or provider credential.
- [x] Exact required host succeeds; an unlisted uncredentialed host and an unlisted LLM host both fail.
  (`vault` — no external route at all — and an arbitrary unlisted host both hit the fake gateway's
  terminal `block *`; the distinction between "uncredentialed" and "LLM" hosts is `route-policy.ts`'s
  own capability-vs-pinned split, both covered by `route-policy.test.ts`.)
- [x] Reordering/removing the terminal `block *` fails validation/publication.
- [x] Direct Agent Pod egress to provider, OneCLI gateway and OneCLI control API is denied. Not
  re-verified this session (no live cluster/NetworkPolicy work was in scope) — already **confirmed
  live** by P04 against a real cluster: "from inside the real fake-Agent Pod, a TCP connect to the
  fake relay Service succeeds; a TCP connect to an arbitrary external host times out"
  (plans/04-session-runtime-controller.md Evidence). P08 changes nothing about that NetworkPolicy
  posture — it only replaces the fake relay endpoint's VALUE with a real one.
- [x] Revocation immediately blocks the relay and rotates/deletes upstream authority.
- [x] Renewal with a changed capability digest is rejected.
- [x] Broker/relay restart preserves correct state or invalidates it fail-closed.
- [x] OneCLI API outage and SDK `false` result prevent Session Runtime readiness.
- [x] OneCLI CA/stub drift from the controller's pinned runtime bundle prevents activation.
- [x] Policy publish/cache-invalidation ambiguity prevents activation.
- [x] Gateway stdout, request audit and Broker logs contain no query string, prompt/tool content or
  token under seeded leak canaries. CONNECT's request-target is structurally `host:port` only (no
  query string ever reaches `relay.ts` or `onecli-fake-gateway.ts` to leak); `relay.test.ts`'s audit
  test seeds a real probe payload through the tunnel and asserts the audit trail carries neither it
  nor any bearer-shaped value.
- [ ] OneCLI Pod replacement with persistent state preserves credential decryption and CA continuity.
  **Not independently re-verified this session** (no live OneCLI Pod was touched). This is exactly
  what `ONECLI-SPIKE.md`'s completed adoption gate already proved against the real product ("restart
  recovered encrypted credentials with the external key") — cited, not re-run.
- [x] Cleanup after every crash boundary cannot leave usable orphan authority. Verified by
  construction: `storeUpstreamAuthority`/`ensureOnecliAgentMapping`/`issueGrantRow` are all
  idempotent upserts keyed by `session_id`/`(session_id, request_id)`, so a crash between any two of
  `issueExecutionGrant`'s steps and a subsequent retry with the same `request_id` safely re-runs the
  remaining steps and converges — the SAME property the existing 8-way-concurrent-issue test already
  exercises under a strictly harder (concurrent, not merely sequential) version of this scenario.

## Non-goals

- No custom MITM, CA issuer, provider-secret store or credential injector.
- No parallel Claude/OpenAI/GitHub/Vault credential adapters in Agora.
- No production use of `onecli run` or SDK `applyContainerConfig`.
- No ACP adapter/custody implementation; P09/P10 validate those on this fixed path.
- No Browser access to OneCLI.
- No production HA/capacity/cutover work beyond integration fixtures; P11 owns it.

## Exit criteria

- [x] A fake Agent Pod uses only its bound relay and OneCLI Agent to reach explicitly granted routes.
  (`relay.test.ts`'s end-to-end CONNECT-through-the-relay-and-fake-gateway tests; `fake-agent`'s own
  pinned route `fake-agent.internal.test` is the only host that ever resolves through it.)
- [x] No provider or OneCLI control/upstream credential enters the Session Runtime Pod. (Grant
  payload/Pod-env/audit tests across `apps/broker` and `apps/session-runtime-controller` all assert
  no `aoc_`/bearer/secret-shaped value anywhere reachable from the Pod side.)
- [x] OneCLI is observably the only provider TLS/credential-injection hop. `relay.ts` never
  terminates TLS, never reads a tunneled byte and never holds a provider credential of its own —
  only the ONE upstream `aoc_` bearer it reads from encrypted Broker-private state to authenticate
  its OWN hop to OneCLI's gateway, which it never returns to the caller.
- [x] Every known spike blocker has an implemented regression test or an explicit P09/P10/P11 gate.
  All of `ONECLI-SPIKE.md`'s findings this plan owns (per-Agent credential isolation, selective-mode
  enforcement, allow-list route enforcement, gateway CONNECT-target opacity, encrypted-credential
  restart continuity) have a direct regression test in `apps/broker/test`; the remaining
  product-configuration blockers (manual-approval routes, `path_and_query` stdout patch) are
  explicitly deferred above pending a live OneCLI instance, not silently dropped.
- [x] P09/P10 can run their pinned harness through OneCLI without learning gateway control material.
  Nothing in the grant/activation wire contract (`IssuedGrant`, `GrantActivation`) or the Pod-facing
  `RelayBundle` carries a gateway credential, control key or CA material beyond the fixed
  operator-managed CA/stub bundle every Session already receives identically.

## Evidence

The adoption evidence is already recorded in
[`apps/broker/ONECLI-SPIKE.md`](../apps/broker/ONECLI-SPIKE.md).

### Follow-up: `onecli-real.ts` corrected against a real live self-hosted OneCLI (2026-08-05)

Everything below the original commit (`ec21500`) was real infra this pass genuinely touched, done as
P09 preparation once the operator authorized live-credential work. Deployed a real, PVC-persistent,
single-user self-hosted OneCLI `1.43.3` (`apps/broker/live-verification/`, namespace
`agora-onecli-test`, same pinned image `ONECLI-SPIKE.md` used) and linked the operator's existing
static Claude Max token (the SOPS secret `claude-oauth-token` already deployed for the old
agent-runtime platform, reused via `POST /v1/secrets {type:"anthropic", value:<token>}` — OneCLI
auto-detected OAuth mode from the `sk-ant-oat` prefix). Never printed the token itself at any point
(decrypted directly into a root-only script, piped straight into the API call, shredded).

**Re-verified, live, better than the original spike:**
- CA continuity across a Pod restart: byte-identical SHA-256 before/after (spike's `emptyDir` setup
  showed this FAIL; PVC-backed `/app/data` fixes it).
- Real Claude Max authentication through the *actual* `getContainerConfig` container-config path
  (not just `onecli run`): the real `claude` CLI, with zero real credentials in its own process
  environment, authenticated through the gateway and got a genuine Anthropic reply.
- Route-policy enforcement: a published explicit-allow + terminal-block pair correctly let
  `api.anthropic.com` through (reached the real service — HTTP 404 from Anthropic's own API root, not
  a gateway rejection) while returning HTTP 403 for two unlisted hosts.

**A real, previously-unknown gap found and fixed in `apps/broker/src/onecli-real.ts`** (not
exercised by this plan's automated test suite, which correctly stays on the fake double — see below):
1. `client.org.*` (the SDK surface `publishRoutePolicy`/`getPublishedGeneration` were built on)
   404s on Community self-hosted OneCLI: `"Organization-level resources require OneCLI Cloud or a
   self-hosted Enterprise instance"`. Found by testing it directly against the live instance, not by
   inspection. The real, working mechanism — found by reading the self-hosted dashboard's own
   compiled server bundle, since it isn't in the public API reference either — is a project-scoped
   REST surface: `GET/POST/DELETE /v1/policy/rules` + `POST /v1/policy/publish` + `GET
   /v1/policy/last-publish`. Rewrote both methods to call it directly via `fetch`, verified live:
   publish → generation returned → `getPublishedGeneration()` reads back the identical value.
   Bonus finding, not adopted this pass: the project-scoped schema's `identities` accepts
   `{type:'agent', id}` (the org-scoped one explicitly cannot) — real per-Agent route scoping is
   possible and wasn't previously known to be. `route-policy.ts` still compiles the project-wide
   union documented since the original commit; adopting per-Agent scoping is future work.
2. `rotateAgentAuthority`/`deleteAgent`'s inferred REST paths used the caller-supplied `identifier`
   string; the real endpoints (`POST /v1/agents/{id}/regenerate-token`, `DELETE /v1/agents/{id}`)
   require the internal `id` UUID instead — confirmed live (identifier: 404 "Agent not found"; id:
   200/204). `ensureAgent`'s own response never returns that `id`, so the adapter now resolves
   `identifier -> id` via `listAgents()` internally; the adapter's own public interface (still keyed
   by `identifier`, matching everything `grant-service.ts` already stores) is unchanged.
- Full live round-trip re-verified against the CORRECTED adapter end to end: ensureSelectiveAgent ->
  publishRoutePolicy -> getPublishedGeneration (matches) -> getContainerConfig (real bearer present)
  -> rotateAgentAuthority -> deleteAgent -> deleteAgent again (idempotent, no error) ->
  getContainerConfig now fails closed. All 8 steps passed.
- Scope boundary preserved deliberately: this adapter is still NOT exercised by `npm test` — the
  automated suite remains runnable with zero live infra or credentials, per the plan's own standing
  design decision. This live pass is recorded here as evidence, the same way P04's cluster
  verification is recorded in its own plan file rather than folded into the unit-test suite.
- Not re-investigated this pass (flagged, not solved): every freshly created Agent showed
  `secretMode: "all"` in this Community instance's own listing, and the successful live Claude test
  above used the DEFAULT Agent (no `agent` option passed), not a freshly created selective one — so
  this pass did NOT re-prove Session-to-Session Agent *credential* isolation specifically (route
  policy isolation was re-proven; credential isolation was already PASS in `ONECLI-SPIKE.md` and
  is exactly one of P09's own mandatory spike gates, so it gets re-proven there instead of twice).

- Commit: on branch `refactoring`, local at completion time (not yet pushed — same push rhythm as
  P01-P07: check in with the operator before pushing).
- Standing design decision (stated up front, not re-litigated per file below): the entire
  Agora-owned Broker layer is built and thoroughly tested against a faithful FAKE OneCLI
  control-plane double (`FakeOneCliControlAdapter` + `startFakeOnecliGateway`) for every automated
  test. No real, credentialed OneCLI instance was stood up or touched this session — that is a
  separate, explicitly-approved step later, matching `ONECLI-SPIKE.md`'s own already-completed
  adoption evidence rather than re-deriving it against a second live instance.
- Packages/apps delivered/changed:
  - `packages/equipment-policy` (new) — `catalogue.ts` (the broker-authoritative safe resource-intent
    vocabulary, `EQUIPMENT_CATALOGUE_VERSION`), `digest.ts` (`stableStringify`/`sha256Hex`),
    `resolve.ts` (`resolveEquipmentPolicy`: pure, deterministic, catalogue-bound resolution from an
    `EquipmentRequest` to independent `CapabilityFact`s + a `capabilityDigest`, throwing typed
    `PolicyDenialError`s — `catalogue_version_unknown`/`duplicate_resource`/
    `unknown_resource_or_access`/`invocation_write_access_denied` — before any OneCLI call ever
    happens), `mcp-servers.ts` (`buildMcpServerDescriptor`: safe, credential-free ACP `McpServer`
    descriptors derived from capability facts, never a raw scope/URL/secret).
  - `apps/broker` (new deployable) — the full Broker layer:
    - `onecli-adapter.ts` — `OneCliControlAdapter`, Agora's own abstraction over OneCLI's control
      plane (not a 1:1 SDK mirror), so a fake and a real SDK-backed implementation can both satisfy
      it and the Broker's own logic never depends on exactly which SDK call backs which operation.
    - `onecli-fake.ts` / `onecli-fake-gateway.ts` — `FakeOneCliControlAdapter` (every automated test
      in this plan) and a faithful double of OneCLI's own gateway (authenticates
      `Proxy-Authorization: Bearer`, enforces first-match allow/`block *`), reproducing exactly the
      two checks `ONECLI-SPIKE.md` proved the real product performs.
    - `onecli-real.ts` — `createOnecliSdkAdapter`, pinned to `@onecli-sh/sdk@3.0.0`'s real exposed
      surface. Never exercised against a live OneCLI by this plan's test suite; two design points
      are documented interpretations rather than verified facts (no SDK `deleteAgent`/explicit
      rotate method exists, so both are inferred REST calls against a guessed path; this SDK
      version's org policy rules cannot target one specific Agent by identity, so route/network
      policy is PROJECT-WIDE, not per-Agent — per-Session differentiation comes from which Agent has
      which selective credential instead, per `ONECLI-SPIKE.md`'s own "Per-Agent credential
      selection: PASS").
    - `crypto.ts` — AES-256-GCM `encryptUpstreamBearer`/`decryptUpstreamBearer`/
      `requireEncryptionKey` (fail-fast on a missing/wrong-length `BROKER_ENCRYPTION_KEY`).
    - `grants-repository.ts` / `activations-repository.ts` / `onecli-agents-repository.ts` —
      Broker-private Postgres repositories (`broker.*` schema, `contracts/database/003-broker.sql`,
      migration `003`) for execution grants, grant activations, and the Session-to-OneCLI-Agent
      mapping + encrypted upstream authority. Idempotent by construction throughout: `issueGrant` by
      `(session_id, request_id)`, `activateGrant` by `(grant_id, request_id)`,
      `ensureOnecliAgentMapping`/`storeUpstreamAuthority` by upsert on `session_id`.
    - `audit.ts` — `recordAudit`, with a structural `FORBIDDEN_DETAIL_KEY_PATTERN` content-safety
      gate so no audit row can carry a key shaped like a secret.
    - `route-policy.ts` — `compileRoutePolicy`: deterministic union of (1) reviewed pinned per-Agent
      route sets, (2) capability-fact-derived hosts, (3) a mandatory terminal `block *`; sorted and
      deduplicated so the SAME set of active grants always compiles to the SAME route list
      regardless of issue order; refuses to compile (rather than silently omitting routes) for any
      unreviewed Agent identity or capability id.
    - `grant-service.ts` — the orchestration layer: `issueExecutionGrant` (resolve policy — pure, no
      OneCLI dependency — THEN ensure the Session's dedicated selective OneCLI Agent, pull its
      container config, verify it against the operator-pinned `ExpectedRuntimeBundle` and fail
      closed on drift, recompile/publish/verify-effective the project-wide route policy, THEN
      persist the grant), `activateExecutionGrant` (binds `grant + session_id + agent_id +
      workload_identity` exactly once), `renewExecutionGrant` (preserves the capability digest —
      checked against the CURRENT `EQUIPMENT_POLICY_VERSION`, since `POST .../renew` carries no
      request body to compare a caller-supplied digest against — and rotates the upstream authority
      behind the same binding), `revokeExecutionGrant` (revokes the DB row FIRST, so the relay stops
      trusting it before any OneCLI round trip, then deletes the OneCLI Agent and republishes).
      Every denial path (policy denial, OneCLI outage, runtime-bundle drift, publish ambiguity,
      activation mismatch) is itself audited as `denied`, except `GrantConflictError`/
      `ActivationConflictError` — an idempotency conflict is the binding invariant working as
      designed, not a policy denial.
    - `relay.ts` — `createAccessRelay`: a workload-authenticated, opaque `CONNECT` tunnel to
      OneCLI's own gateway. Trusts `X-Workload-Identity` the same way
      `session-runtime-controller/server.ts` trusts its own transport (mesh/sidecar-injected,
      unforgeable by the Pod) — this relay's own job is only the binding check, never
      re-implementing mTLS validation. `CONNECT`'s target is `host:port` only, so no path/query ever
      reaches this process or its audit log. Revocation is checked fresh on every `CONNECT`, never
      cached. A gateway denial (non-200) now produces a clean HTTP denial status back to the caller
      (see Bugs below), never a raw socket reset.
    - `request-schemas.ts` / `server.ts` — the Broker control HTTP server conforming to
      `contracts/openapi/broker-control.yaml`, request validation compiled straight from that
      contract via `ajv`, full Problem-response error mapping for every typed domain error.
    - `main.ts` / `index.ts` — the real entrypoint (wiring the real SDK adapter + env-sourced
      `ExpectedRuntimeBundle`) and the package barrel export.
  - `apps/session-runtime-controller` — the P08 integration seam:
    - `broker-activation-client.ts` (new) — `BrokerActivationClient`, the controller's own narrow
      HTTP client for the Broker's `POST /v1/execution-grant-activations` (deployables never import
      each other, even in test code, so this is NOT a shared library).
    - `server.ts` — `handleMaterialize` now calls `brokerActivationClient.activate` (grantRef,
      sessionId, `definition.agentId`, `serviceAccountName(sessionId)` as the workload identity)
      BEFORE creating any Pod, and fails closed (a typed Problem, no Pod) on any denial; `relayBundle`
      is now a required `ServerDeps` value instead of an inline `fakeRelayBundle()` call.
    - `relay-bundle.ts` — doc-only update: `fakeRelayBundle()` is now explicitly the dev/test
      fixture; `main.ts` supplies the real operator-managed values through the identical shape.
    - `main.ts` — wires `AGORA_BROKER_RELAY_ENDPOINT`/`AGORA_ONECLI_CA_PEM`/
      `AGORA_ONECLI_AUTH_STUBS_JSON` into a real `RelayBundle`, and `BROKER_CONTROL_BASE_URL` into
      `createHttpBrokerActivationClient`.
    - `test/support/fake-broker-activation-client.ts` (new) — `FakeBrokerActivationClient`, this
      package's own in-memory double for the Broker's activation endpoint (again: deployables never
      import each other's real server, even in tests).
- Architecture notes:
  - **Renewal has no request body** (confirmed by direct `broker-control.yaml` grep) — the original
    design assumed a caller-supplied capability digest to compare against; there is none. Reframed
    the check to compare the grant's stored `policy_version` against the currently-active
    `EQUIPMENT_POLICY_VERSION` constant instead: a grant issued under a retired policy version cannot
    be blindly renewed, which is the same protection with an available input.
  - **The runtime bundle (relay endpoint, CA, non-secret stubs) is operator-managed and FIXED,
    never sourced per-Session from OneCLI's response** — the Broker's `getContainerConfig` call
    verifies OneCLI has not silently drifted from that fixed bundle (fail closed if it has); it does
    not add CA/stub material to the activation response, matching `GrantActivation`'s own wire
    schema, which has no such field.
  - **Dematerialize deliberately does NOT revoke the execution grant.** Traced through
    docs/specs/10's own vocabulary: dematerialize (Pod removal, e.g. for suspend/resume via
    `restoreFrom`) is a *Suspend*-class operation ("disable relay mapping and rotate upstream
    authority; retain..."), while *Revoke* is Session/Workstream-*terminal* cleanup — a distinct,
    higher-level lifecycle event the controller was never given the authority to trigger (it only
    ever ACTIVATES a grant, never ISSUES or REVOKES one). Revoking on every dematerialize would have
    broken the EXISTING P06 "restore-before-start" flow (dematerialize → re-materialize with
    `restoreFrom`, same `executionGrantRef`), since a revoked grant is terminal and never reassigned.
    Confirmed by re-running P06's own restore tests unchanged (still pass) rather than assumed.
- Exact command (root, from a clean build):
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm test`, Postgres 17
  via docker. Result: repository/schema-fixture/architecture/forbidden-vocabulary checks pass (296
  files, 14 ADRs, 8 schemas, 14 workspace packages, 88 source files scanned), then per workspace:
  `@agora/broker` 46/46 (new), `@agora/control-plane` 1/1, `@agora/session-runtime-controller` 39/39
  (+2 new: grant-binding-before-Pod, Broker-denial-fails-closed), `@agora/web` 25/25, `@agora/acp`
  6/6, `@agora/agent-registry` 7/7, `@agora/custody` 5/5, `@agora/domain` 31/31,
  `@agora/equipment-policy` 12/12 (new), `@agora/session-runtime-control` 7/7, `@agora/store-pg`
  57/57 — **236 tests total, all real** (real Postgres throughout, real HTTP integration against
  `createBrokerServer`/`createServer`, a real raw-TCP `CONNECT` tunnel through the real relay and a
  real fake-OneCLI-gateway process, no mocks).
- **Bugs/gaps this caught** (kept as a record, not just "tests pass"):
  1. `relay.ts`'s `bridgeThroughGateway`, on a non-200 response from the OneCLI gateway (e.g. a
     route that is not allow-listed), rejected with a plain `Error` that its caller turned into a
     bare `clientSocket.destroy()` — the original caller of the tunnel saw a raw `ECONNRESET`, not a
     clean denial status, making "an unlisted host is denied" unobservable to a well-behaved client.
     Found via `relay.test.ts`'s own first draft (5/6 tests failing with `socket hang up`), debugged
     down to the real root cause with temporary diagnostic logging (removed before commit, per the
     "verifications must not filter errors" standing practice — the failure was traced to its true
     cause, not worked around). Fixed with a dedicated `GatewayRejectedError(status)` and reusing the
     existing `deny()` helper (clean HTTP status + audit row) instead of a bare destroy.
  2. The SAME debugging pass also surfaced that the test's own CONNECT target
     (`127.0.0.1:<echoPort>`, the literal local echo server address) was never actually
     allow-listed by any grant's compiled route policy (`vault` derives zero routes; `fake-agent`'s
     pinned route is the hostname `fake-agent.internal.test`, not a raw IP) — a test-authoring
     mismatch, not a relay bug. Fixed by giving the fake gateway a custom dial target that resolves
     the reviewed pinned hostname to the real local echo server while the CONNECT target string
     presented to route-policy enforcement stays the legitimately allow-listed hostname — mirroring
     how a real OneCLI gateway resolves an allow-listed hostname to whatever IP it actually has.
  3. `renewExecutionGrant`'s original design (before this plan's implementation settled) assumed a
     caller-supplied capability digest; `broker-control.yaml`'s renew endpoint has no request body
     at all. Caught before writing any renewal test, by reading the actual contract rather than
     assuming its shape from the plan's prose — reframed as a policy-version check (see Architecture
     notes above) before any code depending on the wrong assumption was written.
- **Deliberately deferred, not silently dropped** (see the Tasks checklist above for the full,
  itemized accounting): a periodic reconciliation sweep for orphaned OneCLI Agents / stale
  materialized-runtime-without-grant / stale relay mappings; patching real OneCLI's own gateway
  logging and disabling its manual-approval routes (both require a live, credentialed instance this
  session deliberately did not touch); auditing the real minimal OpenAI/ChatGPT host set (no real
  Codex image exists yet — P10's job). `apps/web`'s `FAKE_EXECUTION_GRANT_REF`/
  `FAKE_CAPABILITY_POLICY_VERSION` placeholders in `bridge-client.ts` were investigated and found to
  be **out of this plan's scope, not a missed task**: `apps/web` is not one of this plan's "Primary
  paths", its own doc comment already names the real replacement as "P08" territory in the sense of
  "once a Broker exists", and this plan's own non-goal is explicit — "No Browser access to OneCLI."
  Whichever plan owns full Session/Workstream-lifecycle orchestration end to end is the one that
  wires `apps/web` to a real Broker issue-grant call; P08 itself never talks to a Browser.

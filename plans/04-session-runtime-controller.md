# P04 — Session Runtime controller, trusted Agent images and credential-free runtime seam

- **Status:** complete
- **Dependencies:** P01
- **Primary paths:** `apps/session-runtime-controller`, `packages/session-runtime-control`, `packages/agent-registry`

## Required reading

- `docs/specs/08-session-runtime-control.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- ADR 0001, 0005, 0006, 0010, 0011, 0014

## Reuse audit

Inspect the old `agent-runtime` repository but port behavior selectively:

- candidate reuse: Kubernetes client primitives, Pod security settings, tested shutdown logic;
- do not port: group, runLocations, shared substrate, raw spawn args/env, transcript endpoints,
  profiles, equipment-based runtime replacement.

Record provenance for every reused module.

## Deliverables

- Internal server conforming to `session-runtime-control.yaml`.
- Registry loader/validator using `agent-runtime.schema.json`.
- Controller-authoritative safe Agent/version selection projection.
- Deterministic PodSpec builder.
- Fixed credential-free runtime bundle seam for OneCLI CA/stubs and Broker relay endpoint.
- Kubernetes reconciliation keyed by Session ID.
- At-most-one-Pod enforcement.
- Authenticated ACP bridge endpoint lifecycle.
- Fake Agent runtime image/definition for tests.

## Tasks

- [x] Validate all requests before Kubernetes access.
- [x] Resolve only enabled, exact registry definitions.
- [x] Expose public metadata/exact selected version without image, command or custody paths.
- [x] Build Pods from immutable templates and safe references.
- [x] Create one Session-specific workload identity and bind the grant before Pod readiness.
  The per-Session ServiceAccount (workload identity) was already real — created before the Pod,
  bound as `serviceAccountName` on it. **Closed by P08**: `handleMaterialize` now calls the real
  Broker's `POST /v1/execution-grant-activations` (via `broker-activation-client.ts`) with
  `executionGrantRef`/`sessionId`/`agentId`/`serviceAccountName(sessionId)` before ever creating the
  Pod, and fails closed (no Pod) on any denial — see plans/08-equipment-and-broker.md Evidence.
- [x] Route Agent egress only to the workload-authenticated Broker relay; prohibit direct OneCLI
  gateway/control API and Internet access. Verified live (see Evidence) via an operator-applied
  `NetworkPolicy` selecting `agora.dev/app: session-runtime` Pods — same "operator-managed, not
  controller-created" posture as the OneCLI CA/stubs ConfigMaps below; the controller itself never
  creates or edits NetworkPolicy objects.
- [x] Mount only the operator-managed OneCLI CA and non-secret harness auth stubs; never accept them
  from the materialize request.
- [ ] Verify the pinned image already contains the declared harness and ACP adapter versions.
  **Deferred** — not implemented. No code path inspects the pinned image (registry-validation time
  or Pod-startup time) to confirm it actually contains the `stableAcpVersions`/harness version its
  `AgentRuntimeDefinition` declares; readiness today is purely the kubelet's `/healthz` probe. A
  real check needs either image-manifest inspection at registry-load time or an ACP-level
  `initialize` version cross-check before trusting a Session Runtime — neither exists yet. Left for
  whichever plan first onboards a real Agent image (P09/P10), where a wrong-version image is an
  actual risk instead of a hypothetical one.
- [x] Add required labels and prohibit user-provided Kubernetes fragments.
- [x] Reconcile state from Kubernetes after controller restart.
- [x] Make materialize/delete idempotent.
- [x] Detect and fail closed on duplicate Pods.
- [x] Keep status reads credential-free and mint connections through the dedicated endpoint.
- [x] Bind bridge credential to one Session, request ID, single use and short expiry.
- [ ] Revoke bridge/grant during dematerialization. **Partial**: bridge credential revocation is
  real (`BridgeCredentialIssuer.revokeSession`, called unconditionally on `DELETE`, verified to
  actually invalidate an already-minted still-unexpired credential — see Evidence bug #2). Grant
  revocation is not implemented: there is no real grant to revoke yet (same P08 boundary as above).
- [ ] Publish safe status and telemetry. **Partial**: safe (credential-free) status reads are real
  (`GET /v1/sessions/{id}/runtime`). Telemetry is not built — `packages/observability` is still
  empty scaffolding with no source of its own; wiring metrics/structured audit events here would
  have nothing real to integrate with yet.

## Required tests

- Arbitrary image/command/env fields are schema-rejected.
- Concurrent `PUT` creates one Pod.
- Restart with an existing Pod reconstructs the same Session Runtime state by `session_id`.
- Duplicate-Pod injection triggers fail-closed reconciliation.
- Pod has no API token and uses required security context.
- Pod environment/files contain no OneCLI organization key, upstream `aoc_` bearer or provider
  credential.
- NetworkPolicy denies direct provider and OneCLI gateway access while the fake relay remains
  reachable.
- Session A cannot connect using Session B bridge credential.
- `DELETE` for a non-materialized Session Runtime succeeds.

## Non-goals

- No real Claude/Codex integration.
- No custody capture until P06.
- No live OneCLI or capability-policy implementation; use a fake activation/relay contract for P08.
- No runtime `npm install`/binary download.

## Exit criteria

- A fake Agent reaches ACP readiness inside a materialized Session Runtime in a test namespace.
- Controller has no in-memory-only authority.
- P08 can replace the fake activation/relay without changing Session Runtime lifecycle or accepting
  secret environment values.
- P06 can add custody without changing the public lifecycle model.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed — same push rhythm as
  P01 `f4ff2cc`/P02 `ac76611`/P03 `f5b9f4f`).
- Packages/apps delivered:
  - `packages/agent-registry` — `types.ts` (mirrors `contracts/schemas/agent-runtime.schema.json`),
    `validate.ts` (ajv, loaded from the real schema file), `registry.ts`
    (`resolveLaunchableDefinition`/`selectLaunchableAgents`/`AgentNotLaunchableError`),
    `fake-definition.ts` (`FAKE_AGENT_DEFINITION`, real pushed `imageDigest`).
  - `apps/session-runtime-controller` — `k8s-client.ts` (raw `node:https` client, reused/extended
    from `/srv/agent-runtime/src/k8s.ts`), `labels.ts`, `relay-bundle.ts` (fake, swappable),
    `pod-spec.ts` (deterministic builder), `bridge-credentials.ts` (`BridgeCredentialIssuer`),
    `reconciler.ts` (`materializeSessionRuntime`/`reconcileSessionRuntime`/
    `dematerializeSessionRuntime`), `request-schemas.ts` (ajv compiled straight from the
    dereferenced OpenAPI contract, not a hand-copy), `server.ts` (the internal HTTP surface),
    `main.ts` (process entrypoint), `fake-agent-server.ts` (the fake Agent's own container
    entrypoint — wraps `@agora/acp`'s `createFakeAgent()` behind a `ws`-based ACP bridge listener +
    `/healthz`), plus `fake-agent-image/Dockerfile` and `live-verification/*.yaml` (namespace/RBAC/
    ConfigMaps/fake relay/NetworkPolicy used to verify this plan against a real cluster).
- Architecture notes:
  - The controller trusts only its own composed inputs to build a Pod: `buildPodSpec`'s signature
    has no image/command/env parameter at all, so "arbitrary image/command/env is schema-rejected"
    is proven structurally, not just by a runtime check.
  - `reconcileSessionRuntime` derives all state from Kubernetes labels/Pod status alone — no
    in-memory map is authoritative, which is what makes restart-reconstruction and idempotent
    materialize/delete correct by construction rather than by careful bookkeeping.
  - Bridge credentials are HMAC-signed (tamper-evident) but verification also checks a live-nonce
    map, not just the signature — required so `revokeSession` can actually invalidate an
    already-issued, still-unexpired credential (see bug #2 below).
  - `/sessions/{id}/runtime/custody-snapshots` is intentionally unbound in `server.ts` (404, not a
    faked 2xx) — `plans/06-custody-and-resume.md` owns "Controller capture endpoint"; this plan's
    own non-goal is explicit ("No custody capture until P06").
- Exact command (root, fully clean checkout — `rm -rf packages/*/dist apps/*/dist` first):
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm test`, Postgres
  17-alpine via docker matching CI. Result: repository/schema/architecture/forbidden-vocabulary
  checks pass, then per workspace: `@agora/control-plane` 1/1, `@agora/session-runtime-controller`
  31/31 (new this plan), `@agora/acp` 6/6, `@agora/agent-registry` 7/7 (new), `@agora/custody` 5/5,
  `@agora/domain` 31/31, `@agora/session-runtime-control` 7/7, `@agora/store-pg` 37/37 — all real,
  no mocks beyond the in-memory `KubernetesPods` double used for fast unit tests (itself faithful
  enough to be corrected by live-cluster testing — see below).
- **Live-cluster verification** (Arnault-approved isolated test namespace `agora-p04-test` on the
  real k0s cluster; manifests in `apps/session-runtime-controller/live-verification/`, RBAC-scoped
  ServiceAccount token, `K8sClient` pointed at `localhost:6443` from the node host):
  - Exit criterion proven directly: materialized a real Session Runtime (`gVisor`/`sandboxed`
    RuntimeClass, image `ghcr.io/arnaultbretagne/agora-fake-agent@sha256:23bb5e63a9…`), it reached
    `ready`, and a full ACP handshake (`initialize` → `session/new` → `session/prompt`, with the
    streamed `session/update` notification) succeeded over the real WebSocket bridge to the real
    Pod IP.
  - Confirmed live: automountServiceAccountToken=false, security context (`runAsNonRoot`,
    `runAsUser: 1000`, `seccompProfile: RuntimeDefault`), `runtimeClassName: sandboxed`.
  - Confirmed live: concurrent `PUT` against the real API creates exactly one Pod (real 409
    race, not simulated).
  - Confirmed live: restart-equivalent reconciliation reproduces identical status from labels
    alone.
  - Confirmed live: injecting a second real Pod with the same `session-id` label triggers
    `state: failed` (`duplicate_pod`) and the deterministic survivor policy actually deletes the
    younger duplicate on the real cluster (confirmed after allowing real pod-termination time).
  - Confirmed live: `DELETE` on a non-materialized session returns 204; dematerializing a real
    session removes its Pod and ServiceAccount.
  - Confirmed live: NetworkPolicy required test — from inside the real fake-Agent Pod, a TCP
    connect to the fake relay Service succeeds; a TCP connect to an arbitrary external host
    (`1.1.1.1:443`, standing in for "provider/OneCLI gateway") times out.
  - Confirmed live: `env` inside the running container carries no `aoc_`-shaped value and never the
    raw `executionGrantRef`.
- **Bugs/gaps this caught** (kept as a record, not just "tests pass"):
  1. `materializeSessionRuntime`'s freshly-created (202) path returned a hardcoded
     `{ state: 'provisioning' }` with no `agentId`/`runtimeDefinitionVersion` — only the
     already-exists (200) path, which re-derives from Pod labels via `reconcileSessionRuntime`,
     had them. Caught by the HTTP integration test (`server.test.ts`), not the lower-level
     reconciler unit tests, which never asserted those fields on the 202 path. Fixed by populating
     both directly from `input.definition` at creation time.
  2. `BridgeCredentialIssuer.revokeSession` only removed entries from the mint-idempotency map, so
     a *new* mint after revocation produced a different credential — but `verify()` was a pure
     self-contained HMAC check that never consulted that map, so an **already-issued,
     still-unexpired** credential kept verifying successfully after "revocation". This is exactly
     the required behavior ("Revoke bridge/grant during dematerialization") silently not holding.
     Caught by the full-lifecycle HTTP test, which mints a connection, dematerializes, and then
     re-checks `verify()` on the same credential — the unit-level tests written first never
     exercised verify-after-revoke. Fixed by adding a second index (by nonce) that both `verify`
     and `revokeSession` consult, so revocation actually invalidates live credentials, not just
     future ones; added a direct unit regression test for it.
  3. `FAKE_AGENT_DEFINITION.acpCommand` named `/app/fake-agent-server.js`, a path that never
     existed in the actual built image (the Dockerfile copies the whole monorepo to `/repo` and
     builds in place). Invisible to every unit test (they never execute the image), only surfaced
     once a real Pod actually ran the pinned image on the live cluster and crashed with
     `MODULE_NOT_FOUND`. Fixed by correcting `acpCommand` to the real path.
  4. `ghcr.io/arnaultbretagne/agora-fake-agent` is a **private** package, and GitHub's REST/GraphQL
     package APIs do not support visibility changes for personal (non-org) packages (confirmed:
     REST `PATCH` 404s, GraphQL returns no package node) — only the web UI can flip it, which
     wasn't done. Real impact: the live Pod could not pull the image until an `imagePullSecret` was
     wired up. Since `buildPodSpec`/`materializeSessionRuntime` had no pull-secret concept at all,
     added an optional, operator-configured `imagePullSecretName` (never caller-supplied — bound to
     the per-Session ServiceAccount, matching how a real private Agent registry would need to
     work anyway) rather than special-casing this one image.
  5. The repo's `scripts/check-repository.mjs` parses every `.yaml`/`.yml` file as single-document
     YAML; the live-verification manifests were first written as multi-document files (`---`
     separated) and failed `npm run check`. Split into one resource per file
     (`live-verification/01-namespace.yaml` … `10-network-policy.yaml`), which also reads more like
     the rest of the repo's per-resource convention.
  6. `K8sClient` hardcoded `kubernetes.default.svc:443` (correct for in-cluster production) with no
     way to point it anywhere else, which made live verification from outside the cluster
     impossible. Added an optional `host`/`port` override alongside the existing `token`/`ca`
     overrides — same "override for tests/verification, production always uses the in-cluster
     default" pattern already established for those two fields.
- Deferred/known gaps, tracked above in Tasks rather than hidden: grant binding/revocation (P08),
  pinned-image harness/ACP-version verification (no owner yet — first real risk at P09/P10),
  telemetry (`packages/observability` has no source yet), `agora-fake-agent` package visibility
  (cosmetic — an `imagePullSecret` makes it a non-blocker either way).

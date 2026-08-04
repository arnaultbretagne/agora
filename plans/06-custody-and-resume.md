# P06 — Opaque custody, suspension and ACP resume

- **Status:** complete
- **Dependencies:** P02, P03, P04
- **Primary paths:** `packages/custody`, `apps/session-runtime-controller`, `apps/control-plane`, fake Agent

## Required reading

- `docs/specs/03-session-lifecycle.md`
- `docs/specs/07-custody.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0005, 0007, 0009

## Deliverables

- Custody-driver interface and deterministic fake driver.
- Controller capture endpoint and restore-before-start flow.
- Restricted Postgres payload repository.
- Product suspension orchestration with capture/Anchor/delete ordering.
- Rematerialization plus ACP `session/resume`.
- Snapshot retention/reconciliation job.

## Tasks

- [x] Implement streaming capture with size/time limits and SHA-256.
- [x] Commit immutable snapshot generation atomically.
- [x] Return the same snapshot for a repeated Session/capture-request ID.
- [x] Implement format/version compatibility validation.
- [x] Restore before Agent readiness and reject collisions/checksum mismatch.
- [x] Keep capture and Pod deletion separate.
- [x] Commit Anchor only after successful snapshot.
- [x] Resume with ACP `session/resume`, not `session/load`.
- [x] **Partial** Tag any explicit load replay and prevent duplicate projection meaning — the fake
  driver never uses `session/load` (only `session/resume`, which by design never replays), so there
  is no explicit-load-replay path to tag in this plan; real Agents that DO replay via `session/load`
  are P09/P10 territory.
- [x] **Partial** Implement permanent resume failure -> failed old Session + explicit new-Session
  command — `resumeSessionRuntime` fails the old Session closed (typed `resume_failed`/etc., never a
  silent retry or fallback); "explicit new-Session command" reuses P05's already-general
  `openAdditionalSession`/`POST .../sessions` (no new mechanism needed) — seeding that new Session
  from product history via handoff is explicitly P07's territory (non-goal here: "no cross-Agent
  delta yet").
- [x] Implement retention without deleting anchored snapshots.
- [x] **Partial** Add custody payload read audit and secret-path exclusions — secret-path exclusion
  is structural (the fake driver's native format cannot contain env/grant/relay/OneCLI material by
  construction, proven by test) and payload reads are function-call-scoped (`restoreSnapshot`,
  called from exactly one route); a real audit LOG (who read which snapshot, when) is deliberately
  deferred — no logging infra exists yet in this codebase and half-building one seemed worse than
  naming the gap.
- [x] Exclude OneCLI auth stubs, proxy configuration, upstream Agent bearer and provider-auth paths
  from every custody driver.
- [x] Obtain and activate a current execution grant before restore; never revive authority from the
  snapshot — resume always requests a fresh `FAKE_EXECUTION_GRANT_REF` at materialize time (the same
  fixed placeholder P05 already uses for first provisioning); custody's payload never contains grant
  material at all (proven by test), so there is nothing to "revive" even in principle. Real
  Broker-issued grants are P08 territory.

## Required tests

- [x] Suspend/capture/delete/restore/resume same ACP context.
- [x] Capture failure leaves Pod alive and Anchor unchanged.
- [x] A capture retry cannot allocate two generations for one request ID.
- [x] Crash after snapshot before Anchor leaves safe unreferenced snapshot.
- [x] Crash after Anchor before delete is reconciled.
- [x] Corrupt checksum/format mismatch prevents ready.
- [x] Control-plane DB role cannot read payload (pre-existing P02 test, still exercised).
- [x] No credential fixture appears in captured bytes.
- [x] `session/load` replay cannot duplicate Workstream items (proven via the actual `session/resume`
  path, which by design never replays — see Tasks note above).
- [x] Pod replacement rotates/rebinds runtime authority while resuming the same ACP Session and
  custody — proven at the integration level AND live against the real k0s cluster (real Pod
  delete + new Pod, new UID, new IP). See Evidence.

## Non-goals

- No real Claude/Codex native format.
- No cross-Agent delta yet.
- No object storage.
- No persistence of OneCLI runtime configuration in custody.

## Exit criteria

- [x] Fake Agent survives physical Pod replacement as the same Session — proven both at the
  integration level and live against the real k0s cluster (real `DELETE`+`PUT`, a genuinely new Pod
  UID/IP, `session/resume` succeeding, `promptsSeen` continuing from 1 to 2 instead of resetting).
  See Evidence.
- [x] All capture/delete crash boundaries are fault-injection tested.
- [x] P07 can rely on a truthful durable Anchor.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed — same push rhythm as
  P01-P05).
- Packages/apps delivered/changed:
  - `packages/acp` — `fake-agent.ts`: `FakeAgentNativeState` (`{acpSessionId, promptsSeen,
    lastMessages}`, the fake driver's entire opaque native format, chosen freely since no real
    Claude/Codex format exists to match); `nativeState` is now a caller-owned mutable cell (not
    internal closure state) so a custody driver can read it for capture and seed it for restore
    without this module knowing anything about bytes/checksums/transport; added
    `onRequest(session.resume, ...)` (validates the resumed `sessionId` matches the restored state,
    `RequestError.resourceNotFound` otherwise); default `agentCapabilities` now advertises
    `sessionCapabilities.resume`. `coordinator.ts`: extracted `buildClientApp`/`failClosedTransition`
    (shared between `bootstrapSession` and the new `resumeAcpSession`, which never re-runs
    `session/new` or rebinds `acp_session_id` — write-once from P03 is respected, resume only
    verifies `sessionCapabilities.resume` then calls `session/resume` with the SAME Agora-known ACP
    Session id).
  - `apps/session-runtime-controller` — new `fake-agent-server.ts` API: exported
    `startFakeAgentServer(options)` (was a bare script; now testable, still keeps its `isMain`-guarded
    entrypoint for the real container image, `fake-agent-image/Dockerfile` unchanged) with
    restore-before-listen (a failed restore rejects the promise before the process ever opens
    `/healthz` or the WS ACP listener — combined with `restartPolicy: Never`, this lands a real Pod in
    `Failed` phase with ZERO new reconciler code, since `deriveState` already maps that to
    `state: 'failed'`) and a new `GET /custody` (returns the current native state as bytes +
    `x-agora-format-id/-format-version/-sha256` headers); `encodeFakeNativeState`/
    `decodeFakeNativeState`, `FAKE_NATIVE_FORMAT_ID`/`FAKE_NATIVE_FORMAT_VERSION` constants. New
    `restore-credentials.ts` (`CustodyStreamIssuer`) — genuinely one-time (unlike
    `BridgeCredentialIssuer`, which is short-TTL but replayable within that window): `consume()`
    deletes the nonce on its FIRST successful presentation, so a restore credential can never be
    replayed even inside its TTL. New `custody.ts` — `captureCustody` (idempotency pre-check against
    `(session_id, capture_request_id)` BEFORE ever touching the Pod, so a retry never re-fetches
    bytes; generation allocated via `pg_advisory_xact_lock(hashtext(sessionId))` since
    `agora_custody_runtime` has no UPDATE grant on `product.sessions` and so cannot `SELECT ... FOR
    UPDATE` that row; streaming fetch capped at 30s/64MiB per docs/specs/07's "configured maximum
    size and timeout"), `checkRestoreSource` (ownership + invalidation + format check BEFORE a Pod is
    ever created). `server.ts` — new `ServerDeps.custodyPool`/`restoreIssuer`/
    `custodyControllerBaseUrl`; `POST .../custody-snapshots` (was a deliberate 404 in P04) and the new
    `GET .../custody-restore-stream` (Pod-initiated pull, one-time-credentialed, streams straight from
    `restoreSnapshot`); `handleMaterialize` now validates+mints a restore credential BEFORE creating
    any Pod when `restoreFrom` is set. `pod-spec.ts`/`reconciler.ts` — `restoreFrom` threaded through
    to two new env vars (`AGORA_CUSTODY_RESTORE_URL`/`_CREDENTIAL`) on the `agent` container; no
    initContainer/shared-volume plumbing needed since restore is Pod-self-pull, not
    controller-push. `main.ts` — the controller's first-ever Postgres connection
    (`agora_custody_runtime` role via `CUSTODY_DATABASE_URL`) plus `CUSTODY_CONTROLLER_BASE_URL`.
  - `packages/store-pg` — new `retention.ts`: `sweepCustodyRetention(pool, now, graceMs)` (thin wrapper
    around P02's pre-existing `listRetentionCandidates`, actually issuing the `DELETE`), plus an
    `isMain`-guarded CLI entrypoint (`npm run custody-retention-sweep`, mirrors `migrate.ts`'s own
    pattern) — deliberately NOT wired into `apps/web`'s always-on process: `listRetentionCandidates`'s
    own pre-existing comment already says this join (`product.agent_anchors` + `custody.snapshots`
    metadata) needs an elevated/operator connection no standard app role has, matching docs/specs/07
    "operators: audited break-glass access only." (A DB-grant migration to let `apps/web`'s own role
    do this was drafted, then deliberately reverted once this was noticed — see Bugs below.)
  - `apps/web` — `orchestration.ts`: `suspendSession` now cancels live work, reads the Workstream's
    `last_event_seq` as the capture watermark, derives a deterministic `captureRequestId` from
    `(sessionId, Idempotency-Key)` (`SUSPEND_CAPTURE_NAMESPACE`, exported for tests), captures via the
    real controller client, commits the Anchor (`upsertAnchor`), THEN dematerializes — in that exact
    order. New `resumeSessionRuntime`: reads the Anchor, rematerializes with `restoreFrom`, opens a
    fresh ACP connection, calls `resumeAcpSession`. `activateSession`'s `suspended` branch now fires
    this for real (async, fire-and-forget, matching `provisionSessionAndPrompt`'s established
    pattern) instead of always returning `resume_failed`.
  - `contracts/database` — **no new migration**: `002-access.sql`'s `agora_custody_meta`/
    `agora_custody_runtime` roles already had exactly the grants this plan needed (confirmed by
    reading, not assumed).
- Architecture notes:
  - **Byte transport, chosen deliberately simple**: capture is controller-initiated (`GET
    http://{podIp}:{port}/custody`, direct reach — the SAME pattern `handleOpenAcpConnection`
    already uses); restore is Pod-initiated (the Pod pulls from a one-time-credentialed controller
    endpoint using env vars set at materialize time). No initContainer, no shared PVC, no new K8s
    volume — restore-before-readiness falls out for free from the Pod's OWN process never opening
    its HTTP/WS listener until the pull+verify succeeds.
  - **Format/adapter are hardcoded constants**, not threaded through `AgentRuntimeDefinition`
    (the registry). docs/specs/07 "Compatibility" describes per-Agent readable/writable format
    declarations, which matters once a SECOND format exists (P09/P10); extending the registry schema
    for a still-hypothetical second format was judged over-engineering for what this plan needs.
  - **The fake native format is genuinely opaque to core code**: `promptsSeen`/`lastMessages` are
    the ONLY thing captured, proven never to contain the execution grant, Broker relay endpoint or
    OneCLI material by a direct test that greps the raw captured payload bytes.
- Exact command (root, fully clean checkout — `rm -rf packages/*/dist apps/*/dist` first):
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm test`, Postgres
  17-alpine via docker matching CI. Result: repository/schema/architecture (`architecture boundaries
  hold, 14 workspace packages scanned` — up from 13, the controller's two new dependencies)/
  forbidden-vocabulary checks pass, then per workspace: `@agora/control-plane` 1/1,
  `@agora/session-runtime-controller` 37/37 (+6 new this plan), `@agora/web` 21/21 (+5 net new:
  2 crash-boundary + 1 anchor-commit + 1 resume-continuity, replacing the old
  always-fails-closed test), `@agora/acp` 6/6, `@agora/agent-registry` 7/7, `@agora/custody` 5/5,
  `@agora/domain` 31/31, `@agora/session-runtime-control` 7/7, `@agora/store-pg` 51/51 (+2 new
  retention tests) — **166 tests total, all real, no mocks beyond the in-memory `KubernetesPods`
  double** (itself exercised against a REAL `fake-agent-server` process over real HTTP for every
  custody test, not a stub).
- **Bugs/gaps this caught** (kept as a record, not just "tests pass"):
  1. First controller-level capture test hit `insert or update on table "snapshots" violates
     foreign key constraint "snapshots_session_id_fkey"` — `custody.snapshots.session_id` correctly
     references `product.sessions(id)`, but the controller's OWN test suite had never created a real
     product Session (the controller doesn't own that schema). Fixed by seeding a real
     Workstream+Session via `createWorkstreamWithFirstSession` before every capture test.
  2. `assert.equal(capture1.status, 201, await capture1.text())` followed later by `await
     capture1.json()` — reading the same `Response` body twice throws `Body is unusable`. Fixed by
     reading the body once and reusing it for both the message and the assertion (the same class of
     bug documented in P05's evidence — still recurring).
  3. Two restore tests materialized a brand-new `resumeSessionId` for "the replacement Pod" instead
     of re-materializing the SAME `sessionId` — `checkRestoreSource`'s ownership check (correctly)
     rejected it as a foreign snapshot. This was a test-design mistake, not a code bug: ADR 0005 is
     explicit that a Pod replacement never changes Session identity, and the OWN "restoreFrom naming
     an unknown/foreign snapshot never creates a Pod" test proves the SAME rejection is exactly the
     required cross-Session protection. Fixed by DELETE-then-PUT on the SAME sessionId, matching how
     `resumeSessionRuntime` actually drives it.
  4. `assert.equal(k8s.pods.size, 0)` in a later test — `k8s` is one `FakeK8s` instance shared across
     the WHOLE file (an established, pre-existing pattern), so pods from EARLIER tests were still
     present. Fixed by scoping the assertion to `k8s.listPods('agora.dev/session-id=' + sessionId)`.
  5. The FIRST `suspendSession` test at the `apps/web` orchestration level failed closed
     (`'failed'`, not `'suspended'`) — `upsertAnchor`'s `custody_snapshot_id` FK requires a REAL row
     in `custody.snapshots`, but `fake-controller.ts`'s custody-snapshots handler only tracked
     snapshots in an in-process JS `Map`, never in the actual test Postgres database `suspendSession`
     commits the Anchor against. Fixed by threading an optional `pool` into `startFakeController`
     and writing a real row via `@agora/custody`'s own `captureSnapshot` on first capture (still
     backed by the same in-memory per-Session `nativeState` map for WS continuity across a
     close-then-reopen, since the bridge URL now carries `?session=<id>` so the fake WS listener can
     find the right per-Session state cell — it did not need one before this plan, one shared
     stateless fake Agent instance per connection was enough).
  6. Guessed `agentCapabilities.session.resume` at first (matching this plan's own English
     description); the SDK's actual field is `agentCapabilities.sessionCapabilities.resume` — a
     `tsc` compile error, not a runtime bug, caught immediately on the first build.
  7. A DB-grant migration (`GRANT DELETE ON custody.snapshots TO agora_custody_meta`) was drafted so
     the retention job could run from `apps/web`'s normal role, then DELETED before ever running a
     test — `listRetentionCandidates`'s own pre-existing doc comment (written in P02, re-read
     carefully before acting) already says this exact cross-schema join is reserved for an elevated
     operator context, not either standard app role. Caught by reading existing code before writing
     new code, not by a failing test — worth recording since the wrong version would have shipped
     silently otherwise.
  8. `apps/web`'s pre-existing "full golden path" test failed ONCE in the full-suite run (a
     `turns.some(t => t.status === 'completed')` check that polls `items` but reads `turns` only
     once, no retry) — re-ran in isolation immediately after and it passed cleanly. Confirmed as
     pre-existing timing flakiness in a test this plan did not touch, not a regression; noted rather
     than silently re-run until green.
- **What is proven and what is not**:
  - Proven, against real Postgres and real HTTP/WS servers (not mocks): streaming capture with
    SHA-256 + size/time limits; atomic immutable snapshot commit; capture idempotency (same request
    id never allocates a second generation, and never re-touches the Pod on retry); capture failure
    leaves the Pod alive and writes nothing; restore-before-readiness with a genuinely one-time
    credential (a second presentation of the same credential always fails, even inside its TTL);
    checksum-mismatch and unknown-format rejection, both preventing the fake Agent process from ever
    opening for readiness; suspend's capture-then-Anchor-then-dematerialize ordering; BOTH
    crash-boundary scenarios (capture-then-crash-before-Anchor, Anchor-then-crash-before-dematerialize)
    recovered by a same-Idempotency-Key retry that reuses the SAME snapshot/generation; resume
    reusing the exact same `acp_session_id` (never rebinding it) and producing zero duplicate
    Workstream items across a real suspend→resume→prompt cycle; retention deleting only
    older/un-anchored/non-newest snapshots past a grace period, never an anchored or newest one, and
    idempotent on a second sweep; the `agora_product`/`agora_custody_meta` DB-role boundary (P02's
    pre-existing tests, still exercised here since new code now depends on that boundary holding).
- **Registry-consumption fix, caught before going live, not by a failing test**: `custody.ts`
  originally hardcoded its own `formatId`/`formatVersion`/`adapterVersion`/`maxBytes` instead of
  reading `AgentRuntimeDefinition.custody` (`packages/agent-registry/src/fake-definition.ts`),
  which P01/P04 had already fully declared (`writeFormat`, `readFormats`, `driverId`, `maxBytes`,
  `restoreCollision`) for exactly this purpose. Found by re-reading the registry entry before
  starting live verification, not by a test failure. Fixed: capture now reads
  `definition.custody.writeFormat`/`.driverId`/`.maxBytes`; the controller now also validates
  `restoreFrom`'s format against `definition.custody.readFormats` BEFORE creating a Pod
  (docs/specs/07 step 3 — previously this was Pod-side only), 422 `custody_format_incompatible`
  otherwise. `fake-agent-server.ts`'s format constant corrected from an invented `agora-fake-native`
  to match the registry's actual `fake-agent-null`. Commit `3adc361`.
- **Live-cluster verification — RUN, exit criterion closed for real** (2026-08-04, k0s cluster,
  isolated namespace `agora-p04-test` reused from P04 and torn down again afterward per its own
  README's convention; RBAC-scoped ServiceAccount token, gVisor `sandboxed` RuntimeClass, real
  `imagePullSecret`):
  - Rebuilt and pushed BOTH images with the current code: `ghcr.io/arnaultbretagne/agora-fake-agent`
    (re-pinned in `fake-definition.ts`, commit `0ff8f4d` — the previously-pinned digest predated the
    custody protocol entirely) and a new `ghcr.io/arnaultbretagne/agora-session-runtime-controller`
    (new `controller-image/Dockerfile` — this plan needed the controller reachable at a real Service
    DNS name for the Pod's restore callback, unlike P04's verification, which drove the controller's
    functions directly from the node host).
  - A throwaway `postgres:17-alpine` Pod+Service in the SAME namespace stood in for
    `agora_custody_runtime` (migrated with the real schema; connected as the Postgres superuser — this
    verification is about the Kubernetes/materialize side, not re-proving the SQL role boundary
    P02's tests already cover).
  - The controller ran as an actual Pod (ServiceAccount `session-runtime-controller`, already
    RBAC-bound by P04's manifests) with `CUSTODY_CONTROLLER_BASE_URL` pointed at its own real
    Service DNS name — exactly the production shape the code comments describe, not a host-process
    stand-in.
  - **Exit criterion driven end-to-end over real HTTP + a real ACP WebSocket**: materialize (real
    Pod, `podUid bf2408f2…`) → `initialize`→`session/new`→`session/prompt` (real ACP handshake,
    genuine non-empty native state) → capture (`201`, real `custody.snapshots` row) → dematerialize
    (real Pod delete) → re-materialize the SAME sessionId with `restoreFrom` (a genuinely NEW Pod)
    → `initialize`→`session/resume` (not `session/new`) → `session/prompt` again.
  - **A real bug this caught, not visible at the integration-test level**: the FIRST live attempt
    landed the replacement Pod in `state: 'failed'` — `fake-agent-server: restore failed, exiting:
    fetch failed`. Root cause: P04's own `session-runtime-egress` NetworkPolicy (correctly)
    restricts session Pods to ONLY the fake relay and kube-dns — the Pod's restore-stream callback to
    the controller's Service was a THIRD, un-allow-listed destination, silently dropped. This is
    exactly the class of bug integration tests (no real NetworkPolicy enforcement) cannot catch.
    Fixed by adding an explicit egress rule for the controller's own Pods
    (`apps/session-runtime-controller/live-verification/10-network-policy.yaml`) — a deliberate,
    documented addition (the restore URL is controller-minted, same trust level as the relay
    endpoint, never an attacker-reachable destination), not a loosening for convenience. Re-ran after
    the fix: **PASS** — new Pod UID `4d514fd0…` (from `bf2408f2…`, via a `failed` `d7559f2f…` in
    between, now gone entirely, not just relabeled — confirmed via `kubectl get pods`), `session/resume`
    returned `{}` (success), and the reply notification read **`"hello from the fake Agent (prompt
    #2)"`** — continuing the counter from the ONE prompt made before capture, not reset to 1. That
    single number is the whole exit criterion: the fake Agent's native state genuinely crossed a real
    Kubernetes Pod replacement.
  - Manifests added to `apps/session-runtime-controller/live-verification/`: `10-network-policy.yaml`
    (updated), `11-postgres.yaml`, `12-postgres-service.yaml`, `13-controller.yaml`,
    `14-controller-service.yaml`. Namespace torn down after verification
    (`kubectl delete namespace agora-p04-test`), matching the README's own stated convention — it had
    been left running since P04 and was cleaned up as part of this pass.

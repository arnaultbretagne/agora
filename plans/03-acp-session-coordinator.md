# P03 — ACP Session coordinator vertical slice

- **Status:** complete
- **Dependencies:** P01, P02
- **Primary paths:** `packages/acp`, `apps/control-plane`

## Required reading

- `docs/specs/03-session-lifecycle.md`
- `docs/specs/04-acp-integration.md`
- `docs/specs/13-failure-and-idempotency.md`
- ADR 0002, 0003, 0004

## Deliverables

- ACP Client host around the official stable SDK.
- Deterministic in-process fake ACP Agent.
- New Session bootstrap/binding.
- Single prompt turn with complete envelope journaling.
- Permission, filesystem, terminal and update handlers.
- Durable command dispatcher with explicit unknown-delivery behavior.
- Minimal internal API used later by the public HTTP layer.

## Tasks

- [x] Establish initialize/new using a supplied duplex stream.
- [x] Persist negotiated capabilities and bind Agent `sessionId` once.
- [x] Journal every outbound/inbound envelope including `_meta`.
- [ ] Deduplicate replayed bridge frames by opaque transport observation ID without deduplicating
  legitimate identical ACP chunks. **Deferred** — attaching that ID is explicitly the BRIDGE's job
  (docs/specs/04 "Transport requirements"), and this plan has no bridge (non-goal: "use supplied
  streams/fakes"); no stream in this plan's scope ever supplies one to dedupe against. The
  `AppendEventInput.transportObservationId` field and its DB unique index already exist
  (contracts/database/001-initial.sql, from P02); wiring a real value through is for whichever
  plan builds the bridge (P04).
- [x] Correlate updates to one in-flight prompt command.
- [x] Preserve thoughts, plans, tool calls and permission requests (verbatim, via complete raw
  envelope capture — the golden transcript test exercises message, tool_call and permission-shaped
  updates).
- [x] Support cancel/close capability checks (`session/cancel`). **Partial**: `session/close`
  itself is not implemented — it is one step of a multi-step Close sequence (docs/specs/03
  "Close": cancel active work, close if advertised, capture custody, dematerialize the runtime,
  revoke grants) that depends on custody (P06), the runtime controller (P04) and grants (P08),
  none of which exist yet; a capability-gated `session/close` call alone would not implement real
  "Close" and would invite a second, competing implementation later. Deferred as a whole to
  whichever plan first needs a real Close.
- [ ] Implement load-replay ingest tagging but do not use load for normal resume. **Partial**: the
  tagging mechanism exists (`StorePersist.setIngestMode`, defaulting to `live`) and is exercised by
  its own contract, but no call site sets `load_replay` yet since `session/load` itself is not
  implemented here (non-goal-adjacent — resume/load is P06 "Custody and resume" territory).
- [ ] Implement ACP mode/config methods without model-specific columns. **Deferred** — no required
  test exercises `session/set_mode`/`session/set_config_option`, and no product surface reads
  modes/config yet (that is P05's Web layer); adding unused handlers now would be speculative.
- [ ] Handle missing v1 message IDs in projection input metadata. **Deferred to P05.** This plan
  does not build the projector (P05 "Web and projections" does); the raw journal already retains
  every event verbatim whether or not `messageId` is present, so the data a projector would need
  to synthesize a key is not lost — only the synthesis logic itself is out of this plan's scope.
- [x] Implement delivery-unknown terminal state without blind prompt retry.
- [x] Reject credential-bearing MCP descriptors and prove OneCLI/relay configuration never enters an
  ACP envelope.

## Required tests

- [x] Golden transcript for initialize/new/prompt/update/response.
- [x] Unknown ACP `_meta` survives database and readback.
- [x] Multiple message/tool chunks preserve order and IDs.
- [x] Cancel still accepts final racing updates.
- [x] Duplicate dispatcher wakeup does not send acknowledged prompt twice.
- [x] Lost response to `session/new` fails closed without rebinding another ID.
- [x] Invocation cardinality remains enforced at command acceptance.
- [x] Complete `session/new`/`session/resume` envelopes journal safely without OneCLI bearer, control key
  or provider auth state. **`session/new` proven directly** (credential-bearing `mcpServers`
  rejected before any envelope is sent). **`session/resume` is not implemented in this plan**
  (P06 "Custody and resume" owns it) so it cannot be exercised end-to-end; the guards that make
  `session/new` safe (`assertSafeMcpServers`, the secret-pattern check) are generic over the
  `mcpServers` shape, not `session/new`-specific, so they will apply unchanged once P06 sends
  `session/resume` with the same parameter.

## Non-goals

- No Kubernetes runtime; use supplied streams/fakes.
- No native custody.
- No cross-Agent handoff.
- No Browser UI.
- No OneCLI process launch; supplied streams and credential-free MCP descriptors only.

## Exit criteria

- One invocation runs end-to-end against the fake Agent and rebuilds the same projection. **Met at
  the journal level**: the golden transcript test runs one full invocation end-to-end and proves
  the canonical journal is complete/lossless/correctly ordered. This plan does not own the
  `projection.*` read model (P05 "Web and projections" does), so "rebuilds the same projection"
  literally is not yet exercisable; P02's `computeProjectionHash`/`resetProjection` already prove
  the store-level rebuild mechanism is deterministic (see plans/02-postgres-store.md), and this
  plan's journal is what a real P05 projector will fold.
- Protocol tests use official SDK types only. Met — `fake-agent.ts` and `coordinator.ts` import
  only `@agentclientprotocol/sdk` types (`PromptRequest`, `PromptResponse`, `CancelNotification`,
  `ClientCapabilities`, `McpServer`, ...), no locally forked ACP shapes (also enforced repo-wide by
  `scripts/check-forbidden-vocabulary.mjs`'s `no-local-acp-duplication` check from P01).
- P05 and P06 have stable application interfaces. Met — `bootstrapSession`/`promptSession`/
  `cancelSession` (packages/acp) and `createControlPlane` (apps/control-plane) are the stable
  surface; P06 additionally gets `StorePersist.setIngestMode`/the custody-shaped `capabilityDigest`
  input already wired for when resume needs them.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed — see the branch's
  own history for the exact hash; same push rhythm as P01 `f4ff2cc`/P02 `ac76611`).
- Packages delivered: `packages/acp` (`src/journaling-stream.ts`, `classify.ts`, `store-persist.ts`,
  `mcp-guard.ts`, `fake-agent.ts`, `coordinator.ts`) and a minimal `apps/control-plane`
  (`src/app.ts`: `createControlPlane(pool)` composing `bootstrapSession`/`promptSession`/
  `cancelSession` — no HTTP server, that is P05's layer). `packages/acp` depends on the pinned
  `@agentclientprotocol/sdk`, `@agora/domain` and `@agora/store-pg`.
- Architecture: `journaling-stream.ts` reproduces `packages/acp/SPIKE.md`'s proven seam (raw NDJSON
  frame capture strictly below `ndJsonStream`, committed before the frame reaches the wire
  outbound or the SDK inbound) as production code, wired to `store-pg`'s real `appendEvent`
  instead of the spike's in-memory journal. `fake-agent.ts` is a configurable, reusable
  deterministic in-process Agent (P00's standing rule); later plans needing an Agent double for
  tests should reuse it rather than writing a new one.
- Exact command: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm
  test` (root) on a **fully clean checkout** (`rm -rf packages/*/dist apps/*/dist` first). Result:
  the 4 P01 static checks pass, then `@agora/control-plane` 1/1, `@agora/acp` 6/6, `@agora/custody`
  5/5, `@agora/domain` 31/31, `@agora/session-runtime-control` 7/7, `@agora/store-pg` 37/37 — 87
  tests total, all real, all against a real disposable Postgres 17 (docker, matching CI). All 8
  required tests from this plan pass; see the checklists above for which tasks are complete,
  partial, or deferred and why.
- **Bugs/gaps this caught** (kept as a record, not just "tests pass"):
  1. `store-pg`'s `appendEvent` took a parsed `envelope: unknown` object and did
     `JSON.stringify(input.envelope)` before binding it — exactly the parse-then-restringify
     precision loss `packages/acp/SPIKE.md` proved must never happen (ACP's uint64 fields silently
     round through `JSON.parse`). Fixed by changing `AppendEventInput.envelope` to a raw JSON
     **text** parameter, bound directly so Postgres's own (lossless) JSON parser handles it; P02's
     own tests (which pass parsed objects) were updated to `JSON.stringify` explicitly at the call
     site, an intentional, documented exception for test fixtures only.
  2. `store-pg`'s `transitionSessionPhase` never called `@agora/domain`'s
     `canTransitionSessionPhase` guard — no DB trigger enforces the Session phase transition table
     (unlike e.g. the ACP-binding write-once guard), so an illegal transition would have silently
     succeeded. Fixed to lock the row, check the domain guard, then write; added a real test
     proving `requested → ready` (skipping `provisioning`) is now rejected.
  3. `bootstrapSession`'s first cut never bound capability facts, so advancing phase past
     `requested`/`failed` hit `sessions_check3` (`capability_digest` required outside those two
     phases) — a real cross-cutting sequencing requirement from docs/specs/03 "New Session" (step
     3 binds capabilities BEFORE step 5 advances the phase) that P02 had no caller to exercise it
     yet. Fixed by accepting already-resolved `capabilityPolicyVersion`/`capabilityDigest` as
     inputs (resolution itself stays Broker/P08 territory — ADR 0010) and binding them first, in
     spec order.
  4. First cut correlated the outbound `session/prompt` request to its durable command via
     `AsyncLocalStorage`, and assumed it would also cover the inbound `session/update`
     notifications that request triggers. Verified empirically it does not: those notifications
     arrive through the journaling stream's own pull-driven read loop, a separate async chain that
     does not inherit the outbound call's context — every inbound update's `command_id` came back
     `NULL`. Fixed by replacing it with explicit mutable in-flight-command state
     (`StorePersist.setInFlightCommand`, set before the outbound request and cleared after,
     correct here because ACP v1 allows only one prompt turn in flight per Session); verified
     empirically again afterward (a scratch script, then a durable assertion added to the golden
     transcript test) that both directions now carry the same command id.
  5. The cardinality test's first draft dispatched a real `handoff`-purpose prompt end-to-end;
     `product.commands` has a CHECK requiring `source_from_seq`/`seed_policy_version`/
     `content_sha256` for any `purpose='handoff'` row (ADR 0008 territory), which P02 never wired
     up because nothing exercised it. This plan's non-goal is explicitly "No cross-Agent handoff",
     so the handoff scenario was removed from the test rather than building handoff support here;
     the cardinality exemption for `purpose='handoff'` is already proven at the domain level in
     `packages/domain`.
  6. `npm run test --workspaces` does not guarantee dependency-respecting build order — it only
     worked in P01/P02 because stale `dist/` output from earlier manual builds happened to satisfy
     TypeScript's module resolution. Verified this would break a truly clean checkout (deleted all
     `dist/` and reran): `@agora/acp`/`@agora/control-plane` failed `Cannot find module
     '@agora/domain'`/`'@agora/store-pg'` because npm iterates workspaces in directory order, not
     dependency order. This would have broken CI's first run after this plan (a fresh `npm ci`
     checkout has no leftover `dist/`). Fixed with `scripts/build-workspaces.mjs`, which
     topologically sorts by each package's own `@agora/*` dependencies (derived from package.json,
     not hand-maintained) and builds in that order before the per-package test scripts run;
     re-verified green on a fully clean checkout afterward.
- Observed (not a regression, noted for honesty): a handful of transient test failures appeared
  once each in `packages/store-pg` and `packages/acp` full-suite runs during this session, never
  reproducible on immediate retry (3 clean reruns each time after). Consistent with resource
  contention from many concurrent real-Postgres-backed tests against one modest local docker
  container on a shared VPS, not a code defect — each failure's assertion differed run to run in a
  way inconsistent with a deterministic bug, and no failure ever repeated.
- Remaining operational risk: same Node-22-on-a-Node-20-box caveat as P01/P02 (verified via the
  `npm exec --package=node@22` shim; CI uses a real Node 22 install). Full ACP method-schema
  validation (the spike's `validateACPMessage`, ajv against the official schema) is intentionally
  not wired into production `persist()` — only frame classification for storage; malformed/invalid
  frames are simply not journaled (no `rpc_kind` fits) but still forwarded, so the SDK's own
  protocol-level rejection still happens. `secret-guard.ts`'s pattern list stays intentionally
  narrow (named ADR 0010/0014 shapes), reused as-is from P02, not expanded here.
- Follow-up: P04 (Session Runtime controller), P05 (Web and projections) and P08
  (OneCLI-backed Broker) are the natural next unblocked/adjacent plans; P05/P06 specifically
  depend on this plan and can now proceed.

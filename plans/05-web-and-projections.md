# P05 — Web feed and complete Workstream representation

- **Status:** complete
- **Dependencies:** P02, P03
- **Primary paths:** `apps/web`, `apps/control-plane`, `packages/store-pg`

## Required reading

- `docs/specs/05-journal-and-projections.md`
- `docs/specs/12-observability.md`
- `docs/specs/14-product-api-and-feed.md`
- ADR 0004, 0012

## Decision gate

Select the Web framework/toolchain in a small implementation note before coding. The choice must not
change API/feed/domain contracts and must support streaming updates, accessible disclosure controls
and deterministic state tests.

## Deliverables

- Product HTTP API conforming to `product-api.yaml`.
- Deterministic projector for every stable ACP v1 update.
- Resumable SSE feed with gap/reset behavior.
- Web UI for Workstreams, Sessions and full Agent activity.
- Projection rebuild command and equivalence report.

## Tasks

- [x] Implement authorized Workstream list/detail/metadata endpoints.
- [x] Implement owner-only membership endpoints and last-owner protection.
- [ ] Implement item pagination/refetch and authorized command-status/discovery endpoints, deriving
  Agent discovery from the controller and equipment discovery from the Broker. **Partial**: item
  pagination/refetch and command status are real; Agent discovery is real (proxies the controller's
  own `GET /v1/agents`). Equipment discovery is not — no Broker exists yet (P08), so
  `GET /v1/equipment-catalogue` returns a fixed, honestly-empty catalogue (`fake-no-broker-v1`,
  zero resources) rather than anything Broker-derived.
- [x] Implement Session create/activate/prompt/suspend/cancel/close command endpoints. Narrowed the
  same way `apps/session-runtime-controller`'s orchestration is narrowed (documented inline in
  `orchestration.ts`): activate/suspend/close use the real P04 controller for materialize/
  dematerialize, but there is no real custody (P06) or grant/relay revocation (P08) to drive —
  suspending a Session today has no resume point, and `activateSession` fails a suspended Session
  closed with a typed `resume_failed` reason rather than pretending resume works.
- [x] Consume journal notifications with a canonical-head sweep and publish monotonic feed
  positions transactionally with item/checkpoint updates.
- [ ] Project messages/thoughts/tool calls/plans/permissions into their typed satellite tables;
  fold the prompt response's stop reason and cumulative usage snapshot into turns; keep
  usage/elicitation/terminal/session_info/handoff/unknown as contractual generic items. **Partial**:
  message/thought/tool_call/plan/permission all have real typed satellite projection (tested);
  usage/session_info have real generic (`current_value`) projection. `elicitation`/`terminal`/
  `handoff` do not have a dedicated ACP-update mapping — no ACP method for them is wired anywhere in
  this repo yet (the pinned SDK's elicitation shape is itself unsettled, and no plan has built real
  terminals or handoff), so an occurrence would fall into the generic `unknown` bucket rather than
  being tagged with its own `kind`. Still fully inspectable (nothing is silently dropped), just not
  labeled as its specific kind — left for whichever plan first makes one of these real (P06 custody/
  resume touches handoff; P07 owns handoff properly).
- [x] Serve the turns page endpoint and publish turn state changes as command status feed events.
- [x] Render all item classes; collapse verbose classes without discarding them.
- [ ] Show Agent/Session boundaries and Handoff placeholders. **Partial**: Session boundaries are
  real (the detail page lists every Session with its Agent and phase). No dedicated Handoff
  placeholder card exists — the generic renderer would display a `handoff`-kind item if one ever
  existed, but none can yet (P07 non-goal here too: "No handoff algorithm yet").
- [x] Distinguish durable Session phase from optional `liveSessionRuntime` state composed from the
  controller.
- [x] Implement reconnect after position and full reset on gap.
- [x] Add accessible keyboard/screen-reader interactions.
- [x] Add safe error rendering with no internal detail leak.
- [x] Project Broker/OneCLI-derived denial and degraded states only through typed Agora failures;
  never expose OneCLI identifiers, routes or request logs. Trivially true today — no Broker/OneCLI
  integration exists yet (P08) to produce such states — but the vocabulary already used
  (`agent_unavailable`, `runtime_unavailable`, `resume_failed`, …) matches docs/specs/14's safe
  typed-failure list, so nothing needs to change once P08 lands real denials through it.

## Required tests

- Chunk/upsert sequences produce deterministic UI items.
- Turn rows converge to the exact PromptResponse stop reason and final usage facts.
- Tool-call updates remain visible before/after cancel.
- Thoughts and permission decisions are inspectable.
- Unknown ACP update gets a generic inspectable card.
- Feed disconnect/reconnect applies each position once.
- Truncated/gapped feed triggers refetch/reset.
- Projection truncate/rebuild yields identical item hashes.
- Unauthorized Workstream/Session/feed access is denied.
- Viewer mutations and editor membership/deletion attempts are denied.
- Browser responses/feed contain no grant reference, relay credential, OneCLI Agent ID or upstream
  error body.

## Non-goals

- No custody UI payload access.
- No direct ACP or Session Runtime connection from Browser.
- No handoff algorithm yet.
- No model-specific rendering required beyond safe generic metadata.
- No OneCLI UI embedding or direct Browser access to its API.

## Exit criteria

- Fake-Agent discussion is fully usable in Browser.
- Every canonical event class has a projection strategy.
- UI never depends on old Conversation/Run semantics.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed — same push rhythm as
  P01-P04).
- Packages/apps delivered:
  - `packages/store-pg` additions — `projector.ts` (`projectWorkstream`/`sweepProjector`, plus the
    `readWorkstreamItem`/`readWorkstreamTurn` shared readers), `reads.ts` (all product-API read
    functions: `listWorkstreamsForPrincipal`, `getWorkstreamDetail`, `getSession`, `getCommand`,
    `listWorkstreamMembershipsWire`, `listWorkstreamItemsPage`, `listWorkstreamTurnsPage`), plus new
    write functions on `workstreams.ts` (`patchWorkstreamMetadata`, `markWorkstreamDeleting`,
    `openAdditionalSession`, `putWorkstreamMembership`).
  - `packages/domain` — `uuid.ts`'s `nameBasedUuid` promoted from an internal-only helper to a
    public export (needed by the projector's deterministic item IDs and by `apps/web`'s
    deterministic Workstream-creation ID; see bug #2 below).
  - `apps/web` (new) — `bridge-client.ts` (WS ACP bridge connector + fake capability/grant
    placeholders), `connections.ts` (`SessionConnectionRegistry`, in-memory live ACP connections),
    `orchestration.ts` (`provisionSessionAndPrompt`/`activateSession`/`suspendSession`/
    `cancelSessionCommand`/`closeSession` — the real materialize→ACP-bootstrap→prompt chain),
    `request-schemas.ts` (ajv compiled from the real `product-api.yaml`), `server.ts` (the full
    HTTP API + resumable SSE feed), `projector-loop.ts` (the actual "consume journal notifications"
    driver — see bug #4), `main.ts`; `src/client/` (native TS+DOM, separately compiled — `api.ts`,
    `render.ts`, `app.ts`) plus `public/index.html`/`styles.css`.
- Architecture notes:
  - `apps/web` never imports `apps/session-runtime-controller` (a deployable importing another
    deployable is forbidden by `scripts/check-architecture.mjs`) — it only depends on the
    lightweight `@agora/session-runtime-control` HTTP client package. Tests stand in for the real
    controller with `test/support/fake-controller.ts`, a from-scratch HTTP+WebSocket server
    implementing the exact same wire contract (verified against the real client package's types),
    never the controller's own source.
  - The client is native TypeScript compiled straight to browser ES modules by a *second*,
    DOM-target `tsconfig.json` (`src/client/tsconfig.json`, excluded from the server's Node-target
    build) — no bundler, matching `DECISION.md`. One correction to that note mid-plan: the feed is
    read via `fetch()` + a hand-rolled reconnect loop, not `EventSource` — `EventSource` cannot send
    custom headers, so it cannot carry the `Authorization: Bearer <principal>` fake-auth scheme.
  - `sweepProjector`/`startProjectorSweepLoop` is the actual "consume journal notifications"
    process: it polls `product.journal_outbox` for unpublished rows, runs `projectWorkstream` per
    Workstream, then marks the now-covered rows published — correctness never depends on this
    running promptly (`projectWorkstream` always re-derives from its own checkpoint), only
    liveness does.
  - Item IDs are deterministic (`nameBasedUuid` from `(sessionId, itemKind, entityKey)`), not
    random — required for "rebuild yields identical item hashes" to mean anything, since
    `computeProjectionHash` (P02) hashes each item's own `id`.
- Exact command (root, fully clean checkout — `rm -rf packages/*/dist apps/*/dist` first):
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm test`, Postgres
  17-alpine via docker matching CI. Result: 155 tests across 9 packages, all real, all pass —
  `@agora/control-plane` 1/1, `@agora/session-runtime-controller` 31/31, `@agora/web` 18/18 (new
  this plan: 7 orchestration + 11 HTTP/feed), `@agora/acp` 6/6, `@agora/agent-registry` 7/7,
  `@agora/custody` 5/5, `@agora/domain` 31/31, `@agora/session-runtime-control` 7/7, `@agora/store-pg`
  49/49 (new this plan: 6 projector + 6 reads). All 11 required tests from this plan pass; see the
  Tasks checklist above for exactly which pieces are complete, partial, or deferred and why.
- **Real browser verification** (exit criterion — "Fake-Agent discussion is fully usable in
  Browser"): installed Playwright + Chromium in this session and drove the actual served UI end to
  end against a real Postgres and the same `fake-controller.ts` harness (real HTTP, real WebSocket
  ACP handshake to `@agora/acp`'s `createFakeAgent()`). Confirmed live in a real browser, not
  simulated: workstream list renders; setting a principal, opening "New Workstream", picking the
  one enabled Agent, submitting a prompt; redirect to the new Workstream's detail page; the Agent's
  streamed reply appears through the hand-rolled SSE reconnect loop and reaches `status: complete`;
  the turn badge reaches `completed (end_turn)`; the feed status shows `Live`; an unauthenticated
  request renders an accessible `role="alert"` error box; keyboard Tab from a fresh load lands on
  the skip link first. This is the strongest exit-criterion proof this plan produces; a REST-level
  fake-controller (not the real `apps/session-runtime-controller` process) stands in for the
  controller, per the architecture boundary above — P04 already separately proved that controller
  live against the real k0s cluster, so re-proving it here would be redundant, not more rigorous.
- **Bugs/gaps this caught** (kept as a record, not just "tests pass"):
  1. The request-schema loader's contract path (`request-schemas.ts`) needed 4 `../` from
     `dist/src/`, not 3 — the exact same path-depth mistake made and fixed independently at least
     six times across P02-P04 (store-pg's migrate.ts, custody/acp test support, P04's own
     request-schemas.ts, …). Caught immediately by the first HTTP test run (`ENOENT` naming the
     wrong resolved path), not by inspection.
  2. `POST /v1/workstreams` created its durable `CreateWorkstream` command with a **random**
     `workstreamId` before the Workstream row existed — violating `commands.workstream_id`'s
     foreign key, since a command can only reference a Workstream that's already there. Fixed by
     deriving the Workstream id deterministically from `(principal, Idempotency-Key)` (same
     `nameBasedUuid` construction as Command ids) and creating the Workstream first; this also made
     the endpoint genuinely idempotent on sequential retries (a real requirement of `Idempotency-
     Key`, not just header presence-validation) rather than creating a duplicate Workstream per
     retry. A simultaneous double-submit race is knowingly not closed (documented inline) —
     retrofitting `ON CONFLICT` into a multi-table atomic create was judged disproportionate here.
  3. Fixing bug #2 surfaced a second one: firing the async provisioning chain unconditionally on
     every `POST /v1/workstreams` call — including a now-idempotent retry — would re-run
     `bootstrapSession` against an already ACP-bound Session, hitting its write-once `acp_session_id`
     guard and incorrectly transitioning an already-`ready` Session to `failed`. Fixed by only
     firing provisioning when the Workstream was actually newly created.
  4. The projector function itself (`projectWorkstream`) was built and unit-tested first, but
     nothing ever called it automatically — the golden-path HTTP test waited 10s for items that
     never appeared, because journal_outbox rows were never being consumed. This is exactly
     docs/specs/05's "consume journal notifications" driver, and it was simply missing; fixed by
     adding `sweepProjector` (store-pg) + `startProjectorSweepLoop` (apps/web), wired into both
     `main.ts` and every test's setup.
  5. `EventSource` was the plan's original choice for the feed (per `DECISION.md`) but cannot send
     the `Authorization` header this server's fake-auth shim requires — a hard platform limitation
     discovered while writing the client, not a preference change. Fixed by reading the same SSE
     wire format over `fetch()` with a hand-rolled reconnect loop instead (documented as a
     correction in `DECISION.md`, not silently swapped).
  6. `getWorkstreamDetail`/`listWorkstreamsForPrincipal` read `w.current_session_id` as if
     `product.workstreams` had that column — it doesn't; "current session" is tracked on
     `product.sessions.is_current` (P02's schema). Fixed both queries to derive it via a
     `LEFT JOIN ... AND s.is_current`. Caught immediately by the first reads.test.ts run
     (`column "current_session_id" does not exist"`), not by inspection.
  7. `activateSession`'s HTTP handler re-resolved the Agent's *current* registry
     `runtimeDefinitionVersion` on every activation instead of reusing the Session's own frozen one
     — violating "Agent version is frozen at Session creation" (docs/specs/02): if the registry had
     since moved on, re-activating an existing Session would materialize a different Pod than the
     one it was actually bound to. Fixed to always use `Session.runtimeDefinitionVersion` for
     activate, never a fresh registry lookup.
  8. `apps/web`'s own test harness (`fake-controller.ts`) never implemented `GET /v1/agents`,
     so `listLaunchableAgents()` received an empty 404 body and `.json()` threw `Unexpected end of
     JSON input` — a gap in test infrastructure, not production code, but still caught only by
     actually running the HTTP tests, not by review.
  9. A test-only bug: `assert.equal(res.status, 202, await res.text())` evaluates its third
     (message) argument unconditionally, consuming the Response body even when the assertion
     passes — so the next `res.json()` call threw "Body is unusable". Fixed to read the body once.
  10. The SSE feed test's `reader.cancel()` did not reliably tear down the underlying `fetch()`
      connection, leaving `server.close()` hanging forever in `after()`. Fixed by using a real
      `AbortController` per connection instead, plus `server.closeAllConnections()` and a short
      settle delay in `after()` for the fire-and-forget provisioning chains `POST /v1/workstreams`
      intentionally never awaits.
- Deferred/known gaps, tracked above in Tasks rather than hidden: equipment catalogue (no Broker,
  P08), `elicitation`/`terminal`/`handoff` item kinds fold into `unknown` rather than being tagged
  (no ACP wiring for any of them exists yet), Handoff placeholder card (P07), ACP mode/config/
  permission-decision/elicitation-response endpoints (unbound — same P03 precedent), a simultaneous
  (not sequential) double-submit race on `POST /v1/workstreams` idempotency.

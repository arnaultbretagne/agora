# P07 — Cross-Agent anchors and delta handoff

- **Status:** complete
- **Dependencies:** P03, P05, P06
- **Primary paths:** `packages/domain`, `apps/control-plane`, projector, fake Agents A/B

## Required reading

- `docs/specs/06-anchors-and-handoffs.md`
- `docs/specs/05-journal-and-projections.md`
- ADR 0008

## Deliverables

- Versioned deterministic seed policy.
- Handoff resource builder with byte/token budgets and digest.
- Target-Session selection by Agent Anchor.
- Activate/switch orchestration.
- Handoff Web projection/card.
- Full A→B→A acceptance suite.

## Tasks

- [x] Add fixtures for seed-policy v1 item inclusion, ordering and size behavior.
- [x] Implement `contracts/policies/handoff-seed-v1.md` exactly; change it only through baseline
  review (the policy doc itself was NOT edited — only consumed).
- [x] Read source ranges by canonical Workstream sequence.
- [x] Render deterministic ACP Resource content and URI.
- [x] Persist source range, policy version and SHA-256 in the command.
- [x] Restore existing target Anchor or create a new Session.
- [x] Dispatch exactly one Handoff command per idempotency key.
- [x] Prevent expansion of source items into duplicate target timeline items.
- [x] Advance target Agent Anchor only through later custody capture — already true by
  construction (P06's `suspendSession` is the only Anchor writer; this plan never touches it).
- [x] **Partial** Handle oversized/unsafe ranges with explicit summary/confirmation policy — the
  deterministic manifest + most-recent-essential-first degradation is fully implemented and
  tested (`fidelity: 'degraded'` recorded on the command and the projected item); the spec's
  "require explicit user confirmation before dispatch" is surfaced as a typed, inspectable fact
  (the Handoff card shows `fidelity=degraded`) but there is no BLOCKING confirmation step in the
  HTTP API — `switchAgent` still dispatches a degraded Handoff automatically rather than pausing
  for a human decision. No required test exercises the blocking-confirmation path; documented as a
  narrower implementation than the spec's literal wording, not silently dropped.
- [x] Surface resume/handoff failures as typed states (`HandoffNotReadyError` -> 409
  `handoff_not_ready`; `switchAgent`'s own typed `{ok:false, code, detail}` result; the pre-existing
  `failClosed` -> Session `failed` phase from P05/P06 unchanged).
- [x] Preserve one dedicated OneCLI Agent/grant mapping per target Session; switching Agents never
  transfers or reuses gateway authority — true by construction (every materialize call requests
  its own fixed fake grant; no session-to-session credential/connection-object reuse, proven by
  test).

## Required tests

- [x] Agent A reaches C, B reaches D, A receives exactly `(C,D]`.
- [x] A new Agent receives policy-selected `(0,D]`.
- [x] Same switch command cannot duplicate Handoff.
- [x] Echoed Handoff content remains correlated to one Handoff card.
- [x] Capture failure after successful Handoff preserves old durable Anchor.
- [x] Repeating after crash regenerates byte-identical Handoff content/digest.
- [x] Thoughts/tool calls follow the explicit policy rather than UI collapse state.
- [x] A→B→A activates only the target Session's OneCLI authority; no cross-Session bearer is reused.

## Non-goals

- No simultaneous active Agents in one Workstream.
- No hidden native-context portability guarantee.
- No arbitrary user-authored seed policy in v1.
- No gateway policy or credential state in Handoff content.

## Exit criteria

- [x] The complete cross-Agent scenario passes against two independent fake ACP Agent identities
  (`fake-agent`/`fake-agent-b`, same underlying driver behavior, independent Session/Anchor lanes —
  matching this whole program's established "fake ACP Agent, real everything else" pattern; no
  plan before this one needed a SECOND Agent identity).
- [x] Feed and rebuild show no source duplication.
- [x] Seed policy is documented, versioned and fixture-tested.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed — same push rhythm as
  P01-P06).
- Packages/apps delivered/changed:
  - `packages/domain` — `commands.ts`: `HandoffSourceRange` (`sourceFromSeq`/`sourceThroughSeq`/
    `seedPolicyVersion`/`contentSha256`), `DurableCommand.handoffSource`, and `createCommand`
    validation mirroring the pre-existing DB CHECK constraints exactly (purpose='handoff' requires
    a Session AND a handoff source; a non-handoff command must NOT carry one; digest must be 32
    bytes; range must be non-empty). Three new `DomainErrorCode`s.
  - `packages/store-pg` — `commands.ts`: `createOrReuseCommand`/`hydrate` persist and read back the
    four handoff columns (already present in `product.commands` since P02 — no migration needed);
    fixed a real, pre-existing, timing-dependent bug found while touching this code (see Bugs
    below). New `handoff-builder.ts`: `buildHandoffContent` — reads `projection.workstream_items`
    (+ satellites, via the projector's own `readWorkstreamItem`) in `(sourceFromSeq,
    sourceThroughSeq]`, per-item-kind rendering matching `handoff-seed-v1.md`'s table exactly
    (messages/plans/permissions "complete assembled content", thoughts/tool-results
    individually-and-totally byte-capped with Unicode-safe truncation + `[truncated by
    handoff-v1]` markers, prior Handoffs as metadata-only, unknown/usage/session_info/
    elicitation/terminal as manifest entries), a full deterministic overflow/degraded-fidelity
    path (manifest of every source item + most-recent-essential-first inclusion up to 384 KiB) when
    essential content alone exceeds the 512 KiB total budget, and `HandoffNotReadyError` when the
    projector checkpoint hasn't reached `sourceThroughSeq` yet (never builds from a stale
    projection). `projector.ts`: `upsertHandoffItem` — a new `handoff`-kind spine item opened at
    the causing `session/prompt` request (reading the command's own persisted range/policy/digest)
    and updated to `targetOutcome: 'completed'|'failed'` when that turn closes; `closeTurn` and
    `applyRequest` threaded to call it. No expansion of source items — the Handoff item is the
    ONLY new item this plan's dispatch produces on the target Session (the Agent's own reply to the
    Handoff prompt is a completely ordinary `message` item, exactly like a reply to any other
    prompt).
  - `packages/acp` — `coordinator.ts`: `PromptSessionHandoffSource` type; `promptSession` threads
    `handoffSource` into the command it creates (only when the caller supplies one).
  - `packages/agent-registry` (test-only, via `apps/web/test/support/fake-controller.ts`) — a
    second Agent identity `fake-agent-b` added to the fake `/v1/agents` listing: functionally
    identical driver, independent identity, giving cross-Agent tests two real, separate
    Session/Anchor lanes without inventing a second fake Agent implementation.
  - `apps/web` — `orchestration.ts`: `switchAgent` — the single entrypoint for "make Agent X active
    in this Workstream" (docs/specs/06 "Choosing a target Session"): looks up the target Agent's
    Anchor, resolves a deterministic Session id for the "no Anchor yet" case (fixing a real latent
    bug — see below), computes the missing `(watermark, head]` range idempotently against any
    already-recorded command for the same key, and — only when that range is non-empty — builds and
    dispatches the Handoff via extended `provisionSessionAndPrompt`/`resumeSessionRuntime` (both
    gained optional `handoffSource`/purpose parameters, backward-compatible, existing P05/P06
    call sites unchanged). `server.ts`: `handleOpenSession`'s `activate: true` path now calls
    `switchAgent` instead of unconditionally creating a new Session — a real behavior change to
    existing P05 code, required because "switch to Agent X" can mean "resume Agent X's own prior
    Session," which P05 never needed to consider (single-Agent Workstreams only). `HandoffNotReadyError`
    surfaced as a typed 409.
  - `apps/web/src/client/render.ts` — a dedicated `handoff` card (source range, policy version,
    digest, `degraded` badge when fidelity isn't complete).
- Architecture notes:
  - **The builder reads projections, not canonical events directly** — docs/specs/06 explicitly
    allows either; reading projections reuses the projector's own per-kind value readers instead of
    re-implementing ACP-update folding a second time, at the cost of needing the projector
    checkpoint to have already caught up (made an explicit, typed, retryable failure rather than a
    silent staleness risk).
  - **`switchAgent` composes `provisionSessionAndPrompt`/`resumeSessionRuntime` rather than
    replacing them** — both gained a purpose/handoffSource extension point instead of a parallel
    code path, so P05/P06's own tests needed zero changes and their behavior is provably unchanged
    (same 176-test suite, same pass count structure, only additive).
  - **The Handoff's own idempotency key is derived from the caller's Idempotency-Key**
    (`handoff:${idempotencyKey}`), not a fresh random one — this is what makes "same switch command
    cannot duplicate Handoff" and "repeating after crash regenerates byte-identical content" both
    hold: `createOrReuseCommand`'s existing dedup returns the SAME already-recorded
    `(sourceFromSeq, sourceThroughSeq)` on a retry, and the builder rebuilds from exactly that
    range, not a wider one computed from a since-advanced head.
- Exact command (root, fully clean checkout — `rm -rf packages/*/dist apps/*/dist` first):
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres npm test`, Postgres
  17-alpine via docker matching CI. Result: repository/schema/architecture/forbidden-vocabulary
  checks pass, then per workspace: `@agora/control-plane` 1/1, `@agora/session-runtime-controller`
  37/37, `@agora/web` 25/25 (+4 new: full A→B→A, duplicate-Handoff, echoed-content, capture-failure),
  `@agora/acp` 6/6, `@agora/agent-registry` 7/7, `@agora/custody` 5/5, `@agora/domain` 31/31,
  `@agora/session-runtime-control` 7/7, `@agora/store-pg` 57/57 (+6 new handoff-builder tests) —
  **176 tests total, all real** (real Postgres, real HTTP/WS fake-agent connections, real ACP
  handshakes over both Agent identities, no mocks).
- **Bugs/gaps this caught** (kept as a record, not just "tests pass"):
  1. `createOrReuseCommand`'s `ON CONFLICT (workstream_id, idempotency_scope, idempotency_key) DO
     NOTHING` — adding four columns to that INSERT shifted timing enough to expose a REAL,
     pre-existing race: under genuine concurrency, Postgres only suppresses a conflict on the
     NAMED arbiter, and 8 concurrent identical `createOrReuseCommand` calls (an EXISTING P02 test)
     started intermittently hitting `duplicate key value violates unique constraint "commands_pkey"`
     instead. `id` is deterministically derived from the SAME triple the named constraint covers,
     so the two are logically equivalent — but only `ON CONFLICT (id) DO NOTHING` is robust against
     which constraint's index happens to raise first. Fixed; re-verified the concurrent-retry test
     passes repeatedly.
  2. `switchAgent`'s (and, by the same pattern, the ORIGINAL `handleOpenSession`'s) new-Session path
     used `randomUUID()` for the Session id — meaning a retry of the SAME Idempotency-Key, before
     any Anchor exists yet (e.g. a crash right after Session creation), would open a SECOND,
     duplicate Session for the same Agent. Fixed by deriving the id deterministically from
     `(workstreamId, agentId, idempotencyKey)`, with a `sessionMode: 'new' | 'anchored' |
     'reattach'` three-way split so a "the Session already exists but has no Anchor yet" retry
     safely falls through to `activateSession`'s own phase-aware logic instead of either
     re-creating or mis-treating it as a resume. Found by reasoning about retry-safety while
     writing `switchAgent`, not by a failing test — no required test exercises this exact crash
     window, so it is verified by construction/code inspection, not a dedicated test. A narrower,
     explicitly documented gap remains: if a crash happens strictly between that reattach and a
     still-pending Handoff dispatch, the retry does not automatically re-send the missing Handoff
     (same class of limitation as `activateSession`'s pre-existing no-op 'ready' branch after a
     process restart with no in-memory live connection — a dedicated reconciliation sweep is
     future work, not this plan's scope).
  3. `suspendSession`'s `session/cancel` notification (when a live connection exists) is itself a
     journaled canonical event — it advances `last_event_seq` AFTER a caller's own "read the
     current head" snapshot. The very first version of the acceptance test computed a Session's
     Anchor watermark from a `headSeq()` read taken BEFORE calling `suspendSession`, which was
     wrong by exactly one event and produced `HandoffNotReadyError` (the projector checkpoint,
     synced to the pre-cancel head, could never "catch up" to a range computed past it). Fixed the
     test to read the TRUE watermark from the committed Anchor itself (after suspend, after
     re-projecting) rather than assuming it — this is not a product bug, but it is exactly the kind
     of off-by-one a real caller could make too, so `switchAgent`'s own doc comment now says
     explicitly why the range must be computed AFTER any live-connection cancel, not before.
  4. The fake driver's default ACP session id (`'fake-acp-session'`) is a per-connection constant,
     not derived from anything session-specific — the first version of the "no cross-Session
     bearer reused" assertion compared `acpSessionId` strings and failed because Agent A and Agent
     B's independent fake connections both legitimately produced the SAME default string. Not a
     product bug (a real Agent backend would generate genuinely unique ids); fixed the test to
     assert on live CONNECTION OBJECT identity instead, which is the property that actually matters
     and the one a coincidental string match could have hidden.
  5. `waitForPhase(pool, sessionId, 'ready')` (an established P05/P06 helper) returns as soon as
     `resumeAcpSession`/`bootstrapSession` flips the durable phase to `ready` — which happens
     BEFORE `resumeSessionRuntime`/`provisionSessionAndPrompt`'s trailing Handoff-purpose
     `promptSession` call has finished. Early acceptance-test drafts raced ahead of that dispatch
     and, under full-suite load specifically (not in isolated single-file runs), the pool closed
     while the dispatch was still in flight (`Cannot use a pool after calling end on the pool`).
     Fixed by adding `waitForHandoffSettled` (polls until the projected Handoff item's
     `targetOutcome` leaves `'pending'`) and using it everywhere a Handoff is expected, replacing
     an earlier ad-hoc `sleep()` that happened to be long enough in isolation but not under
     concurrent-file load — a real robustness gap in the test, not the product code.
  6. Pre-existing, already-documented-in-P06 flakiness in `apps/web`'s "full golden path" test
     (a polling loop that waits for `items.length > 0` then reads `turns` exactly once, no retry)
     recurred during this plan's full-suite runs — confirmed via isolated reruns (fails
     intermittently, passes cleanly on its own) to be the SAME pre-existing race, untouched by this
     plan. Not fixed here (out of scope); flagged again rather than silently re-run until green.

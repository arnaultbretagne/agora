# P05 — Web feed and complete Workstream representation

- **Status:** pending
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

- [ ] Implement authorized Workstream list/detail/metadata endpoints.
- [ ] Implement owner-only membership endpoints and last-owner protection.
- [ ] Implement item pagination/refetch and authorized command-status/discovery endpoints, deriving
  Agent discovery from the controller and equipment discovery from the Broker.
- [ ] Implement Session create/activate/prompt/suspend/cancel/close command endpoints.
- [ ] Consume journal notifications with a canonical-head sweep and publish monotonic feed
  positions transactionally with item/checkpoint updates.
- [ ] Project messages/thoughts/tool calls/plans/permissions into their typed satellite tables;
  fold the prompt response's stop reason and cumulative usage snapshot into turns; keep
  usage/elicitation/terminal/session_info/handoff/unknown as contractual generic items.
- [ ] Serve the turns page endpoint and publish turn state changes as command status feed events.
- [ ] Render all item classes; collapse verbose classes without discarding them.
- [ ] Show Agent/Session boundaries and Handoff placeholders.
- [ ] Distinguish durable Session phase from optional `liveSessionRuntime` state composed from the
  controller.
- [ ] Implement reconnect after position and full reset on gap.
- [ ] Add accessible keyboard/screen-reader interactions.
- [ ] Add safe error rendering with no internal detail leak.
- [ ] Project Broker/OneCLI-derived denial and degraded states only through typed Agora failures;
  never expose OneCLI identifiers, routes or request logs.

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

To be completed by the implementing agent.

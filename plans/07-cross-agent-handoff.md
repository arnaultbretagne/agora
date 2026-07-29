# P07 — Cross-Agent anchors and delta handoff

- **Status:** pending
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

- [ ] Add fixtures for seed-policy v1 item inclusion, ordering and size behavior.
- [ ] Implement `contracts/policies/handoff-seed-v1.md` exactly; change it only through baseline
  review.
- [ ] Read source ranges by canonical Workstream sequence.
- [ ] Render deterministic ACP Resource content and URI.
- [ ] Persist source range, policy version and SHA-256 in the command.
- [ ] Restore existing target Anchor or create a new Session.
- [ ] Dispatch exactly one Handoff command per idempotency key.
- [ ] Prevent expansion of source items into duplicate target timeline items.
- [ ] Advance target Agent Anchor only through later custody capture.
- [ ] Handle oversized/unsafe ranges with explicit summary/confirmation policy.
- [ ] Surface resume/handoff failures as typed states.

## Required tests

- Agent A reaches C, B reaches D, A receives exactly `(C,D]`.
- A new Agent receives policy-selected `(0,D]`.
- Same switch command cannot duplicate Handoff.
- Echoed Handoff content remains correlated to one Handoff card.
- Capture failure after successful Handoff preserves old durable Anchor.
- Repeating after crash regenerates byte-identical Handoff content/digest.
- Thoughts/tool calls follow the explicit policy rather than UI collapse state.

## Non-goals

- No simultaneous active Agents in one Workstream.
- No hidden native-context portability guarantee.
- No arbitrary user-authored seed policy in v1.

## Exit criteria

- The complete cross-Agent scenario passes against two independent fake ACP Agents.
- Feed and rebuild show no source duplication.
- Seed policy is documented, versioned and fixture-tested.

## Evidence

To be completed by the implementing agent.

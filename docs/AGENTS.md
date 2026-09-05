# Architecture and documentation instructions

This file governs architecture discussions and changes under `docs/`, and routes future
implementation work to the current design. Read the relevant current files before reasoning or
editing; conversation memory and historical code are not substitutes.

## Mandatory baseline

Before working on Intent, Observation, Session, Workstream or reconciliation, read in full:

1. [ADR 0002 — The four temporal concepts](adr/0002-workstream-session-model.md)
2. [ADR 0003 — Reconciliation over state](adr/0003-reconciliation-over-state.md)
3. [Reconciliation index](specs/reconciliation/README.md)
4. [Taxonomy and evaluation](specs/reconciliation/000_taxonomy.md)

Check the current files after further iteration, including before answering a design question.

## Topic routing

After the baseline, read the complete sources needed for the topic:

| Topic | Required sources |
|---|---|
| Intent, capabilities or compiler | [Intent](specs/reconciliation/001_intent.md), ADRs [0006](adr/0006-complete-harness-images.md) and [0010](adr/0010-capabilities-are-onecli-grants.md) |
| Current evidence or grants | [Observation](specs/reconciliation/002_observation.md), ADRs [0007](adr/0007-kubernetes-runtime.md) and [0009](adr/0009-onecli-grant-authority.md), plus the source-owner contract in [execution](specs/reconciliation/execution.md) or [continuity](specs/reconciliation/continuity.md) |
| Rule or action | Its rule file, linked Intent/Observation entries and [verbs](specs/reconciliation/003_verbs.md); rules alone select objectives |
| Session, ACP, images, isolation or extinction | [Execution](specs/reconciliation/execution.md) and the ADRs it cites |
| Save, Anchor, resume, workspace or Handoff | [Continuity](specs/reconciliation/continuity.md), ADR [0008](adr/0008-saves-anchors-and-refill.md) and [engine prompt recovery](specs/reconciliation/engine.md#prompt-delivery-and-context-creation) |
| Persistence, ownership, acquisition, retries or scheduling | [Engine](specs/reconciliation/engine.md), ADRs [0003](adr/0003-reconciliation-over-state.md) and [0005](adr/0005-postgresql-durable-store.md) |
| Validation or implementation acceptance | [Acceptance](specs/reconciliation/acceptance.md) and each affected behavior contract |

The [master plan](master-plan.md) sequences implementation slices and assigns open prerequisites;
it is non-normative and never a source of contracts.

Read linked definitions, not just search snippets. Repository/deployment structure is governed by
[ADR 0001](adr/0001-unified-repository.md); protocol history and projections by
[ADR 0004](adr/0004-acp-boundary-and-session-facts.md).

## Authority and design discipline

- Active accepted ADRs and `specs/reconciliation/` form the current baseline. Retired documents,
  schemas, plans and implementation in Git history are historical, not competing authority.
- Distinguish documented decisions, discussion not yet documented and unresolved questions. Do not
  fill missing contracts by inference or build further rules on an unnamed assumption.
- Repair a conflicting ADR/specification before implementing dependent behavior. An ADR explains a
  decision; implementation also needs a sufficiently specified normative behavior contract.
- Register every new Intent field, Observation value, result or verb in its taxonomy first.
- Keep exactly one `Rule | Conditions | Result` table per ordered rule, with stable identifiers,
  mutually exclusive/exhaustive conditions and the closed result grammar. Add no control-flow columns.
- An action response is neither Observation nor a rule result. Engine recovery selects no fallback
  business verb; subsequent fresh evidence and the ordered rules do.
- Session facts remain historical. Operational ownership/retirement records create no Runtime
  aggregate and do not prove current external state. Only the registered driver interprets Save bytes.
- Preserve OneCLI as the sole grant/credential authority and keep runtime, control and relay powers
  separate. No software presence, persona or skill grants authority.

## Explicit open work

Skills remain outside Intent and persona stays frozen at `default`. Wire/storage contracts, concrete
policy mappings, seed fidelity, custody/workspace mechanisms, freshness/deadline values and physical
fencing must be specified and demonstrated before the relevant implementation is accepted. Generic
ACP support, a URI occurrence, a recent cached response or a vanished Pod API object proves none of
these guarantees. See the [implementation prerequisites](specs/reconciliation/README.md#implementation-prerequisites).

Keep additions scoped to a real decision or behavior. Extend its owning contract instead of adding
parallel overview/specification trees. Preserve useful scenarios and rationale; retain obsolete
material through Git history rather than an in-tree archive.

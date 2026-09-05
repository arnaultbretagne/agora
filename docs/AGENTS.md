# Instructions for architecture and documentation agents

This file applies to architecture discussions and every change under `docs/`. It also routes
implementation agents to the current architectural sources. Its purpose is to keep work grounded
in the current repository without loading every document for every topic.

## Mandatory baseline

Before working on Intent, Observation, Session, Workstream or reconciliation, read these files in
full, in this order:

1. [ADR 0002 — Intent, Observation, Session and Workstream](adr/0002-workstream-session-model.md)
2. [ADR 0003 — Reconciliation over state](adr/0003-reconciliation-over-state.md)
3. [Reconciliation specification index](specs/reconciliation/README.md)
4. [Reconciliation taxonomy](specs/reconciliation/000_taxonomy.md)

Do this before answering a design question, not only before editing files. A previous read in an
earlier turn is not a substitute for checking the current files after further iteration.

## Progressive disclosure

After the baseline, read only the row required by the topic being discussed or changed.

| Topic | Required sources |
|---|---|
| Intent fields or cardinality | [Intent taxonomy](specs/reconciliation/001_intent.md), then ADR [0006](adr/0006-complete-harness-images.md) and [0010](adr/0010-capabilities-are-onecli-grants.md) when harness, persona, skills or capabilities are involved |
| Observation fields or source ownership | [Observation taxonomy](specs/reconciliation/002_observation.md), then the ADR for each authoritative source: [0007](adr/0007-kubernetes-runtime.md) for Kubernetes and [0009](adr/0009-onecli-grant-authority.md) for OneCLI/Broker |
| Action verbs | [Verb taxonomy](specs/reconciliation/003_verbs.md) and every rule that selects the verb |
| `POWER` | [`004_power.md`](specs/reconciliation/004_power.md) plus its linked Intent, Observation and verb entries |
| Harness images or Pod lifecycle | ADR [0006](adr/0006-complete-harness-images.md) and [0007](adr/0007-kubernetes-runtime.md), then [Harness conformance](specs/09-agent-registry.md) |
| ACP or Session facts | ADR [0004](adr/0004-acp-boundary-and-session-facts.md), [0002](adr/0002-workstream-session-model.md) and [0007](adr/0007-kubernetes-runtime.md), then [Session boundaries](specs/03-session-lifecycle.md) and [ACP integration](specs/04-acp-integration.md) |
| Saves, Anchors, restore, resume or refill | ADR [0008](adr/0008-saves-anchors-and-refill.md) |
| Capabilities, grants or OneCLI | ADR [0009](adr/0009-onecli-grant-authority.md) and [0010](adr/0010-capabilities-are-onecli-grants.md), [Capabilities and OneCLI](specs/10-equipment-and-broker.md), then the grant Observations, verbs and `CAPABILITIES` rule |
| PostgreSQL Intent history or workset | ADR [0003](adr/0003-reconciliation-over-state.md) and [0005](adr/0005-postgresql-durable-store.md) |

Follow links from a selected rule into the taxonomies instead of restating their definitions from
memory. Read complete selected files; grep snippets are discovery, not sufficient grounding.

## Authority and conflicts

The accepted ADRs under `docs/adr/` and the new reconciliation specification describe the current
remodeling decisions. The flat specifications under `docs/specs/00-*.md` through
`docs/specs/15-*.md` have not all been aligned yet.

- ADRs under `docs/adr/parked/` are historical and non-authoritative.
- Do not use a stale flat specification to reverse a remodeled decision.
- Do not use a pre-remodeling contract to reverse ADR 0002–0010 or the reconciliation specification.
- Do not implement against an ADR alone when its normative specification is missing or conflicts.
- Surface the conflict and update the relevant ADR/specification before implementation.
- Never merge old and new vocabulary into a compromise model.

## Design discipline

- State what the selected documents actually say before proposing the next decision.
- Label anything remembered from discussion but absent from the repository as undocumented.
- Do not introduce a field, Observation value, result or verb without first registering it in its
  taxonomy.
- Do not add columns or control flow to a rule table; use the exact format defined by
  `000_taxonomy.md`.
- Do not treat an action response as Observation or as a rule result.
- When a missing contract blocks the next rule, expose that dependency instead of silently filling
  it.

## Known unresolved gaps

These are warnings, not decisions to complete by inference:

- Intent currently registers power, harness, capabilities, model, effort and frozen persona.
  Skills remain outside this iteration; do not infer additional Intent fields.
- Exact attached/effective grants are specified in spec 10 and the reconciliation taxonomies.
  Other flat specifications still contain old lifecycle/authority contracts until explicitly aligned.
- Specs 03, 04 and 09 now define Session boundaries and integration conformance. Native
  continuity/shutdown and engine ownership/retry contracts still require alignment before implementation.
- ADR 0008 still makes healthy Pod deletion conditional on a successful Save or explicit forced
  loss, while the latest design discussion makes preservation best-effort and extinction mandatory.
  This conflict must be resolved before specifying `TURN_OFF`.

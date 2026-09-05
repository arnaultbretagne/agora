# Slice plans

One executable plan per slice of the [master plan](../master-plan.md). A plan is written for a
development agent: it says what to read first, what to build, in which order, how to prove it,
and when to stop and ask. Plans are non-normative; the specifications under
[`docs/specs/reconciliation/`](../specs/reconciliation/README.md) and the [ADRs](../adr/index.md)
govern, and a plan that disagrees with them is wrong.

| Slice | Plan | Depends on | Milestone |
|---|---|---|---|
| S0 | scaffold, done in PR #35 | — | — |
| S1 | [Domain core and pure rule engine](S01-domain-core.md) | S0 | M1 |
| S2 | [Intent authoring, workset and ticks](S02-intent-workset-ticks.md) | S1 | M1 |
| S3 | [Workstream journal, Sessions and projections framework](S03-journal-sessions-projections.md) | S2 | M2 |
| S4 | [ACP capture seam, bridge client, commands and feed](S04-acp-capture-commands-feed.md) | S3 | M2 |
| S5 | [Owner request protocol, epochs and attempt recovery](S05-owner-requests-epochs.md) | S2 | M2 |
| S6 | [Runtime control on Kubernetes](S06-runtime-control-kubernetes.md) | S3, S5 | M3 |
| S7 | [Broker, OneCLI and exact capabilities](S07-broker-onecli-capabilities.md) | S5, S6 | M3 |
| S8 | [First harness integration: claude-code](S08-harness-claude-code.md) | S4, S6, S7 | M3 |
| S9 | [Native continuity: Saves, Anchors, restore and refill](S09-continuity-saves-anchors-refill.md) | S8 | M4 |
| S10 | [Second harness, catalogue publication and A → B → A](S10-codex-and-revision-publication.md) | S9 | M5 |
| S11 | [Operations, retention and hardening](S11-operations-hardening.md) | S10 | M5 |
| S12 | [Web plumbing completion](S12-web-plumbing.md) | S4, S8, S9 | M5 |

## How to execute a plan

1. Read the repository [AGENTS.md](../../AGENTS.md) and [docs/AGENTS.md](../AGENTS.md), then
   every document the plan's *Read first* section lists, in full. Search snippets are not reading.
2. Do the *Before coding* steps. They repair or extend specifications and settle the open
   questions the plan names. If a question cannot be settled from the current documents, stop and
   raise it in the pull request; never fill a missing contract by inference.
3. Build in the order given. Each step names its acceptance; do not start the next step until the
   current one passes.
4. Copy an archived brick only where the plan's *Reuse* section allows it, with a provenance header:

   ```ts
   // Carried over from archive/pre-design-cleanup-2026-09-05:<path>; changes: <what and why>.
   ```

5. Run `npm test` (repository rules, build, tests) before every commit. Keep the vocabulary check
   green without widening its allowlist.
6. Finish with the *Report* section: what was verified, how, and what remains. A design scenario
   is not an executed test; say which scenarios actually ran.

## Conventions shared by every plan

- **Runtime.** Node ≥ 22, TypeScript 7, ESM, `node:test`, no framework. Real PostgreSQL for every
  persistence test, one disposable database per test (`packages/testkit`).
- **Schema.** `contracts/db/schema.sql` is applied from scratch by `npm run db:reset`. Each slice
  appends its section under a comment naming the slice and the authority boundary; no migrations.
- **Vocabulary.** The names in [`000_taxonomy`](../specs/reconciliation/000_taxonomy.md),
  [`001_intent`](../specs/reconciliation/001_intent.md), [`002_observation`](../specs/reconciliation/002_observation.md)
  and [`003_verbs`](../specs/reconciliation/003_verbs.md) are used verbatim in code, SQL, logs and
  tests. Rule identifiers (`POWER-001`, `CAPS-004`, …) appear literally.
- **Scenarios.** Acceptance scenario identifiers from [acceptance.md](../specs/reconciliation/acceptance.md)
  are used as test names so coverage can be grepped.
- **Secrets and logs.** Nothing that is a bearer, credential, prompt, tool content or Save byte
  reaches a log line, a projection or a fact outside the canonical ACP envelope.
- **Findings.** Where a plan cites [field findings](../field-findings.md), read that section before
  the step; it usually records a trap that already cost a day.

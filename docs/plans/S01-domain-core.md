# S1 — Domain core and pure rule engine

- **Status:** planned
- **Depends on:** S0
- **Produces:** `packages/domain`, `contracts/schemas/intent.schema.json`, `scripts/run-schema-fixtures.mjs`
- **Master plan:** [S1](../master-plan.md#s1--domain-core-and-pure-rule-engine)

## Goal

Make the three taxonomies and the seven ordered rule tables executable as pure TypeScript with no
I/O, and prove the partition property (mutually exclusive, exhaustive) for every table by
enumeration. Everything later depends on this package; nothing in it may depend on PostgreSQL,
Kubernetes, OneCLI or the ACP SDK.

## Read first

1. [ADR 0002](../adr/0002-workstream-session-model.md), [ADR 0003](../adr/0003-reconciliation-over-state.md), [ADR 0010](../adr/0010-capabilities-are-onecli-grants.md)
2. [000 taxonomy](../specs/reconciliation/000_taxonomy.md), [001 intent](../specs/reconciliation/001_intent.md), [002 observation](../specs/reconciliation/002_observation.md), [003 verbs](../specs/reconciliation/003_verbs.md)
3. Rules [004](../specs/reconciliation/004_power.md), [005](../specs/reconciliation/005_construction.md), [006](../specs/reconciliation/006_capabilities.md), [007](../specs/reconciliation/007_session.md), [008](../specs/reconciliation/008_config.md), [009](../specs/reconciliation/009_sync.md), [010](../specs/reconciliation/010_converge.md)
4. [engine: tick and acquisition](../specs/reconciliation/engine.md#tick-and-acquisition) (what evaluation must and must not do)
5. Field findings [§6 methodological lessons](../field-findings.md#6-methodological-lessons), [§7 reuse register](../field-findings.md#7-reuse-register) (schema fixtures)

## Before coding

- Confirm each rule table in the specs has exactly the columns `Rule | Conditions | Result` and
  that the result grammar is closed. If a table row is ambiguous for some input, that is a spec
  defect: propose the repair in the PR before encoding it.
- Decide nothing about wire or storage here. This package holds types and pure functions only.

## Deliverables

```text
packages/domain/
  package.json                 @agora/domain, no runtime dependencies
  tsconfig.json
  src/index.ts
  src/ids.ts                   branded ids: WorkstreamId, SessionId, HarnessId, CapabilityId, IntentSeq, WorkGeneration
  src/intent.ts                Intent type (power, harness, capabilities, model, effort, persona = 'default'); shape validation
  src/observation.ts           observation.* types incl. ∅/⊥ for construction and the two grant sets
  src/authorization.ts         exact grant comparison model: Authorization, inclusion under prerequisites, compare(D, A, E)
  src/verbs.ts                 closed verb catalogue
  src/results.ts               PASS | ACTION(verb) | HOLD | CONVERGED
  src/rules/power.ts           POWER-001..003
  src/rules/construction.ts    CONSTRUCT-001..003
  src/rules/capabilities.ts    CAPS-001, CAPS-002, CAPS-004, CAPS-003 (this order)
  src/rules/session.ts         SESSION-005, 001, 002, 003, 004 (this order)
  src/rules/config.ts          CONFIG-001..003
  src/rules/sync.ts            SYNC-001..002
  src/rules/converge.ts        CONVERGE-001
  src/rules/index.ts           ORDERED_RULES: the seven tables by file prefix
  src/evaluate.ts              evaluate(intent, reader): walks the tables, acquires lazily, returns the first non-PASS result
  test/*.test.ts
contracts/schemas/intent.schema.json
contracts/schemas/fixtures/intent/valid-*.json, invalid-*.json
scripts/run-schema-fixtures.mjs   wired into `npm run check`
```

## Work plan

### Step 1 — Types for the three taxonomies

Encode [001](../specs/reconciliation/001_intent.md) and [002](../specs/reconciliation/002_observation.md)
as closed types. Use the spec names verbatim: `intent.power` becomes `intent.power`, not `desiredPower`.

- `observation.construction` is a set whose members are image digests or the bottom marker `⊥`;
  the empty set is `∅`. Model it as `{ kind: 'empty' } | { kind: 'set', digests: ReadonlySet<string>, incoherent: boolean }`
  or equivalent that makes "exactly `{D}`" a total, testable predicate.
- `observation.session ∈ {pending, openable, live, unusable}`, `observation.anchor ∈ {compatible, none}`,
  `observation.sync ∈ {current, stale}`, `observation.model`/`observation.effort` are strings.
- Grant sets are `ReadonlySet<Authorization>` under a canonical key; see Step 3.
- There is **no** `unknown` value anywhere. Unavailable evidence is represented by the reader, not by
  the value (Step 5).

Acceptance: `tsc --noEmit` passes with the root strict options; a test asserts the value domains
(e.g. `SESSION_VALUES` has exactly four members).

### Step 2 — Intent shape and validation

`validateIntentShape(input, catalogue)` checks the complete shape against a `CatalogueView`
interface (harness ids, per-harness model ids, per-model effort levels, capability ids). It returns a
typed result, never throws for invalid input. Off Intents keep retained selections but validation of
model/effort against the catalogue applies to on Intents only
([001 §catalogue](../specs/reconciliation/001_intent.md), [engine: authoring](../specs/reconciliation/engine.md#intent-authoring-and-revision-selection)).
Persona must equal `'default'`. The catalogue itself is not in this package (S7); tests use a
hand-written `CatalogueView`.

Write `contracts/schemas/intent.schema.json` (JSON Schema 2020-12) for the same shape and fixtures:
at least `valid-on.json`, `valid-off-retains-selections.json`, `invalid-persona.json`,
`invalid-effort-type.json`. Carry `scripts/run-schema-fixtures.mjs` over from the archive (reuse
register), add `ajv`/`ajv-formats` as root dev dependencies, and add it to the root `check` script.

Acceptance: fixtures pass; a TypeScript test round-trips each valid fixture through
`validateIntentShape`.

### Step 3 — Exact grant comparison model

Encode [002 §exact grant comparison](../specs/reconciliation/002_observation.md#exact-grant-comparison)
and [ADR 0010](../adr/0010-capabilities-are-onecli-grants.md):

```ts
interface Authorization {
  readonly kind: 'secret' | 'connection'
  readonly credential: string                    // OneCLI credential/connection identity, non-secret
  readonly tools: ReadonlySet<string> | 'full'   // 'full' compares equal to nothing finite unless expanded (see spec)
  readonly approval: 'unconditional' | 'required'
  readonly restrictions: readonly Restriction[]  // unknown restrictions preserved, never dropped
  readonly opaque?: Readonly<Record<string, unknown>>  // unknown fields keep the entry distinguishable
}
```

Functions: `includes(a, b)` (inclusion under prerequisites: approval-required ⊆ unconditional for the
same tool; narrower restriction ⊆ broader when the pinned mapping proves it, else not provable),
`isSubset(X, D)`, `equals(X, D)`, `excess(X, D)` returning the removable entries with their identity.
Unknown fields or unprovable restrictions make equality false and classify the entry as excess.
`'full'` never equals a finite set unless an explicit `ToolCatalogue` is supplied to expand it.

Acceptance: tests for each bullet of the spec section, including `AUTH-001` (two-grant capability,
one remaining grant is excess), `AUTH-003` (masked attachment is still attached), `AUTH-007`
(approval mode change breaks equality).

### Step 4 — Rule tables as data

Each rule file exports `readonly RuleRow[]` with `{ id, when(input): boolean, result }` and the
input type it reads. Encode only the inputs the spec lists (POWER reads two fields; SESSION reads
no Intent field; CONVERGE reads nothing). Keep the spec's row order, including `CAPS-004` before
`CAPS-003` and `SESSION-005` first.

Acceptance, per table, by **enumeration**: for every combination of the finite value domains
(digests drawn from a small alphabet; grant sets from a small universe, compared through Step 3),
exactly one row's `when` is true. For CONSTRUCTION also enumerate `∅`, `{D}`, `{D'}`, `{D, ⊥}`,
`{⊥}`, `{D, D}` (duplicate ⇒ `⊥`). For CAPS derive the partition from the four predicates. Add
one test asserting the exact ordered id list per table so a reordering is visible.

### Step 5 — Evaluation with lazy acquisition

```ts
type Acquired<T> = { ok: true; value: T } | { ok: false; reason: 'unavailable' | 'inconsistent' }
interface ObservationReader { power(): Acquired<...>; construction(): ...; grantsAttached(): ...; /* … */ }
type Evaluation =
  | { kind: 'result'; rule: RuleId; result: Result }
  | { kind: 'acquisition_incomplete'; rule: RuleId; field: ObservationField; reason: string }
```

`evaluate(intent, reader, resolve)` walks `ORDERED_RULES` from POWER, calls the reader only for the
fields the reached rule needs, and stops at the first non-`PASS` result. `resolve` supplies the
trusted resolution a rule needs without observing (harness → digest `D`; capabilities → compiled
set `D`), injected so this package stays free of catalogue code. An `acquisition_incomplete` is
**not** a result and never selects a verb ([000 §results](../specs/reconciliation/000_taxonomy.md#results)).
A rule set that ends after `PASS` without a terminal result throws: it is incomplete by construction.

Acceptance: `POWER-001` converges with only `power()` read (ACP readers throw if called); an off
Intent with an unavailable ACP field still reaches `TURN_OFF` when `power = on`; `CONFIG` is never
consulted while `SESSION` is `pending`; the evaluation records the rule id that fired.

### Step 6 — Guards

- A test greps `src/` for the forbidden identifiers (belt and braces beside `npm run check`).
- A test asserts that `packages/domain/package.json` has no `dependencies`.

## Reuse

Allowed: `scripts/run-schema-fixtures.mjs` (findings §7). Nothing from the archived
`packages/domain`: it models session phases and command states the design rejects.

## Definition of done

- [ ] All seven tables encoded with literal ids; enumeration tests prove exactly one match.
- [ ] Exact grant comparison covers every bullet of the spec section, with `AUTH-001/003/007` as unit tests.
- [ ] `evaluate` acquires lazily and never turns unavailable evidence into a value or a verb.
- [ ] `intent.schema.json` with valid and invalid fixtures; `run-schema-fixtures` in `npm run check`.
- [ ] No runtime dependency; `npm test` green; vocabulary allowlist unchanged.
- [ ] `docs/master-plan.md` S1 marked done with the PR number.

## Report

State which tables were enumerated over which domains, the count of combinations, and any place
where the spec text left a partition case ambiguous (with the proposed repair). No scenario from the
catalogue closes in S1; say so rather than claiming coverage.

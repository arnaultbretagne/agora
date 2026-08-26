# 000 — Reconciliation taxonomy

## Scope

Reconciliation compares one complete Intent with fresh current evidence and evaluates rules in
their declared order. It does not derive current reality from persisted lifecycle state or Session
facts.

Rules use three separate taxonomies:

- [`intent.*`](001_intent.md) for complete desired values;
- [`observation.*`](002_observation.md) for normalized fresh evidence;
- [verbs](003_verbs.md) for the closed set of actions a rule may select.

A rule may reference only names registered in those taxonomies.

## Tick

The reconciliation unit is the Workstream. An empty `NOTIFY` is one tick and causes workers to
reread the durable workset. The evaluation defined below applies independently to each claimed work
row: it reads that row's complete Intent and the Observations required by the rules.

## Rules

Rules are evaluated by ascending file prefix, beginning with `004_power.md` for every claimed work
row on every tick. Each file defines exactly one table with exactly these columns:

```text
Rule | Conditions | Result
```

For every valid input reaching a rule, its conditions MUST be mutually exclusive and exhaustive:
exactly one row matches. Rule identifiers are stable, indexed names used by specifications, code,
tests and logs.

Observation acquisition, claim validation, retries and backoff are engine control flow. They are
not rows, conditions or results in a rule table.

## Results

The result grammar is closed:

```text
PASS | ACTION(verb) | CONVERGED
```

- `PASS` evaluates the next ordered rule for the same work row during the same tick.
- `ACTION(verb)` executes that single action and ends evaluation of that work row for the current
  tick. When the action attempt completes, the reconciler emits the empty `NOTIFY` that triggers
  the next tick.
- `CONVERGED` ends evaluation of the complete Intent, conditionally finalizes the claimed work row
  and emits no successor tick.

Every new tick obtains fresh Observations and restarts each claimed work row at `004_power.md`. A
`PASS` does not consume a tick. For one work row, a rule set that reaches its end after `PASS`
without returning `ACTION(verb)` or `CONVERGED` is incomplete.

The next tick never trusts an action response as current state. It rebuilds Observation and
reevaluates from the first rule.

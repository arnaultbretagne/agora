# 000 — Reconciliation taxonomy

## Scope

Reconciliation compares one complete Intent with fresh current evidence and evaluates rules in
their declared order. It does not derive current reality from persisted lifecycle state or Session
facts.

The reconciliation unit is the Workstream. An empty `NOTIFY` is one tick and causes workers to
reread the durable workset. The evaluation defined below applies independently to each claimed work
row: it reads that row's complete Intent and the Observations required by the rules.

## Intent

`intent.*` contains desired values from the complete immutable Intent selected by `intent_seq`.
Intent is never interpreted as a patch and never proves that its requested state was realized.

The fields currently defined by this specification are:

| Field | Values | Meaning |
|---|---|---|
| `intent.power` | `on`, `off` | Whether a live execution footprint should exist. |

Later rule files extend this registry when their Intent fields are specified.

## Observation

`observation.*` contains normalized current evidence derived during the current tick from the
systems that own the observed resources. It is not read from a persisted Agora current-state row.

A normalized field may be produced only from the fresh and exhaustive source reads declared for
that field during the current tick. Retaining an Observation for diagnostics does not make it
valid for a later tick.

### `observation.power`

`observation.power` is a scalar with exactly two values: `on` or `off`. It is derived from these
authoritative inventories for the Workstream:

- every Kubernetes Pod, regardless of phase, readiness or termination state;
- every OneCLI Agent, including an Agent with no effective grant;
- every effective OneCLI grant;
- every Broker relay binding, including an inactive or unhealthy binding.

Each owner MUST expose stable Workstream attribution that makes its inventory exhaustive even when
another resource, such as the Pod, has already disappeared. Session facts MUST NOT be used as a
live inventory or as proof of absence.

Given the fresh inventories `pods`, `agents`, `grants` and `bindings`:

```text
observation.power = off
  iff pods = ∅ ∧ agents = ∅ ∧ grants = ∅ ∧ bindings = ∅

observation.power = on
  iff pods ≠ ∅ ∨ agents ≠ ∅ ∨ grants ≠ ∅ ∨ bindings ≠ ∅
```

A footprint containing Pending, Failed, Terminating, orphaned or duplicate resources is therefore
`on`. `on` means only that a live execution or authority footprint exists; it does not mean that
execution is ready, coherent or usable.

If any required inventory fails or cannot prove exhaustive coverage, `observation.power` is not
produced and `POWER` is not evaluated. `unknown` is not a third value; observation retry belongs to
the reconciliation engine rather than the rule table.

ACP connections, prompt admission, readiness, quiescence, Sessions, Session facts, Saves and
Anchors are not part of `observation.power`. Durable history and recovery material may remain when
`observation.power = off`.

Later rule files extend the Observation registry when they require other normalized evidence.

## Rules

Rules are evaluated by ascending file prefix, beginning with `001_power.md` for every claimed work
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

Every new tick obtains fresh Observations and restarts each claimed work row at `001_power.md`. A
`PASS` does not consume a tick. For one work row, a rule set that reaches its end after `PASS`
without returning `ACTION(verb)` or `CONVERGED` is incomplete.

Action verbs form a closed catalogue. Before implementation, every verb MUST define its owner,
inputs, idempotency contract and observable postcondition outside the rule table. A rule selects a
verb; it does not inline the verb's procedure.

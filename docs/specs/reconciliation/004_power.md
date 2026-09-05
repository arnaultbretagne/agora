# 004 — `POWER`

`POWER` is the first reconciliation rule. It determines whether the Workstream is already globally
converged because no execution should exist, must extinguish an existing footprint, or should hand
off to the construction rules to realize a live execution.

## Inputs

`POWER` reads only:

- [`intent.power`](001_intent.md);
- [`observation.power`](002_observation.md).

No other Intent field, Observation or historical fact may change the result of `POWER`.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `POWER-001` | `intent.power = off ∧ observation.power = off` | `CONVERGED` |
| `POWER-002` | `intent.power = off ∧ observation.power = on` | [`ACTION(TURN_OFF)`](003_verbs.md#turn_off) |
| `POWER-003` | `intent.power = on` | `PASS` |

The conditions are mutually exclusive and exhaustive: `intent.power = off` splits on
`observation.power`, and `intent.power = on` matches `POWER-003` whatever the current footprint.

`POWER-001` converges the complete Intent because every later execution setting is inapplicable
while power is `off`. `POWER-002` extinguishes an unwanted footprint; its successor tick reevaluates
`POWER` from fresh evidence and reaches `POWER-001` once the footprint is gone.

`POWER-003` only passes to the next rule. `POWER` owns nothing that builds a Pod — it does not read
`intent.harness` — so bringing a live execution up is not its decision. Whether a Pod must be
created, replaced or is already correct belongs to the construction rules, which own those fields.
The mere presence, or absence, of a footprint says nothing here about whether the rest of the Intent
is realized.

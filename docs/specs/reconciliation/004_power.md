# 004 — `POWER`

`POWER` is the first reconciliation rule. It determines whether evaluation may continue with an
existing execution footprint, must change that footprint, or is already globally converged because
no execution should exist.

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
| `POWER-003` | `intent.power = on ∧ observation.power = off` | [`ACTION(TURN_ON)`](003_verbs.md#turn_on) |
| `POWER-004` | `intent.power = on ∧ observation.power = on` | `PASS` |

`POWER-001` converges the complete Intent because every later execution setting is inapplicable
while power is `off`. `POWER-004` only passes to the next rule: the existence of some live footprint
says nothing about whether the rest of the Intent is realized.

After `POWER-003` executes `TURN_ON`, its successor tick reevaluates `POWER` from fresh evidence. If
both values are then `on`, `POWER-004` returns `PASS` and the next rule is evaluated during that
same tick.

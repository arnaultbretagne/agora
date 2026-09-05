# 009 — `CONFIG`

`CONFIG` is evaluated after [`CAPABILITIES`](008_capabilities.md) passes, on a live Session. It
reconciles the sticky session configuration the harness exposes as ACP configuration options —
today `model` and `effort` — toward the Intent. These options are set once per session and persist
until changed, so a session opened fresh after a Pod replacement starts at the harness's defaults
and is brought back to Intent here: the "re-apply on wake" of earlier designs, as a reconciled rule.

## Inputs

`CONFIG` reads only:

- [`intent.model`](001_intent.md) and [`intent.effort`](001_intent.md);
- [`observation.model`](002_observation.md) and [`observation.effort`](002_observation.md).

`intent.persona` is deliberately not read; its entry in `001` says why.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `CONFIG-001` | `observation.model ≠ intent.model` | [`ACTION(SET_MODEL)`](003_verbs.md#set_model) |
| `CONFIG-002` | `observation.model = intent.model ∧ observation.effort ≠ intent.effort` | [`ACTION(SET_EFFORT)`](003_verbs.md#set_effort) |
| `CONFIG-003` | `observation.model = intent.model ∧ observation.effort = intent.effort` | `PASS` |

The conditions partition the input: model wrong; model right but effort wrong; both right. Exactly
one matches.

Model before effort is a rule ordering, not a sequence hidden inside a verb. The valid effort levels
depend on the model, and the adapter rebuilds the `effort` option — clamping an unsupported level to
`default` — whenever the model changes. Setting both in one action would bury that dependency and
its re-validation inside the verb. Here `SET_EFFORT` fires only once `observation.model` is correct,
so the level it sets is validated against the model that will actually run, and a clamp caused by
`SET_MODEL` is simply observed and corrected on the next tick. Each verb does one thing with one
postcondition.

Both options are reconcilable because their readback is truthful: the pinned adapter recovers the
live model on session load before reporting it. Persona is excluded for the opposite reason — its
reported value is reseeded from the client on load — and stays frozen at `default` until a truthful
readback exists.

`CONFIG-003` passes to [`CONVERGE`](010_converge.md).

# 008 — `CONFIG`

`CONFIG` is evaluated after [`SESSION`](007_session.md) passes, on a live Session. It
reconciles the sticky session configuration the harness exposes as ACP configuration options —
today `model` and `effort` — toward the Intent. These options persist until changed. A fresh or
resumed context may begin with values that differ from Intent; this rule reads and reconciles the
actual values before any opening Handoff or user work.

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

Model before effort is a rule ordering, not a sequence hidden inside a verb. Valid effort levels
can depend on the model; changing model can reset the option or change its allowed values. The
integration must report that new option state. Here `SET_EFFORT` fires only once
`observation.model` is correct, so its target is validated against the model that will actually
run. Any reset caused by `SET_MODEL` is observed and corrected on the next tick. An unavailable
requested value is an incompatibility, never permission to accept a substituted default. Each
verb has one objective with one verified postcondition.

An enabled integration must demonstrate truthful model/effort readback under [ACP evidence](execution.md#acp-facts-and-current-evidence). Unsupported
or stale readback leaves admission closed; no default is fabricated. Persona stays frozen until its
application/readback contract exists. The transition barrier in [Session boundaries](execution.md#hot-session-boundaries) applies before changing an
already-working context, including between the model and effort actions.

`CONFIG-003` passes to [`SYNC`](009_sync.md), so a Handoff never starts on unverified defaults.

# 008 — `CAPABILITIES`

`CAPABILITIES` reconciles the OneCLI grants on the Workstream's Agent toward `intent.capabilities`.
It runs after the Agent exists — provisioned with the Pod by `BUILD` — and reconverges the grants
whenever they drift, including after a manual edit on OneCLI.

## Inputs

`CAPABILITIES` reads only:

- [`intent.capabilities`](001_intent.md);
- [`observation.capabilities`](002_observation.md).

Both are sets of capability ids over the same reviewed catalogue.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `CAPS-001` | `observation.capabilities ⊄ intent.capabilities` | [`ACTION(REVOKE)`](003_verbs.md#revoke) |
| `CAPS-002` | `observation.capabilities ⊆ intent.capabilities ∧ intent.capabilities ⊄ observation.capabilities` | [`ACTION(GRANT)`](003_verbs.md#grant) |
| `CAPS-003` | `observation.capabilities = intent.capabilities` | `PASS` |

The conditions partition the two set-differences: an extra grant exists (`CAPS-001`); no extra but a
missing one (`CAPS-002`); neither (`CAPS-003`). Exactly one matches.

`CAPS-001` takes priority over `CAPS-002`: unauthorized grants are detached before missing ones are
attached, so the Agent is never briefly over-authorized while converging. Each verb acts on the
whole current difference; the successor tick re-reads the effective grants and continues.

A grant edited directly on OneCLI does not hold: `observation.capabilities` reports the Agent as it
really is, and the next tick reconverges it to `intent.capabilities`. Durable removal of an access
is a change of Intent, not a dashboard edit.

`CAPS-003` passes to the next rule. It is deliberately not `CONVERGED`: the session-configuration
and content passes (model, effort, persona, skills) are not yet written, so the complete Intent is
not realized here. Reaching the end of the current set after `CAPS-003` is therefore an intentional,
temporary incompleteness ([`000`](000_taxonomy.md)) until the final rule — which converges the whole
Intent — exists.

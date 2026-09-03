# 006 — `SESSION`

`SESSION` is evaluated after [`CONSTRUCTION`](005_construction.md) passes, so the Workstream runs
the Pod built from the desired harness image. It brings that Pod to a usable ACP session, and waits
without acting while the transition it needs is owed by Kubernetes. It selects no persona, model or
capability; it only makes the harness reachable for the rules that follow.

## Inputs

`SESSION` reads only [`observation.session`](002_observation.md). It carries no Intent field:
whether a session should exist at all was already settled by `POWER` and `CONSTRUCTION`.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `SESSION-001` | `observation.session = pending` | `HOLD` |
| `SESSION-002` | `observation.session = openable` | [`ACTION(OPEN_SESSION)`](003_verbs.md#open_session) |
| `SESSION-003` | `observation.session = live` | `PASS` |

The three values of `observation.session` partition the input, so exactly one row matches.

`SESSION-001` is the one place a rule waits on Kubernetes. The Pod exists and runs the right image,
but its harness process is not yet reachable; no verb can speed a scheduler, so the rule `HOLD`s
rather than select a doomed action. The engine re-evaluates the work row when the Pod's readiness
watch fires, or when the backoff for `(workstream, intent_seq, SESSION)` elapses. Its wake source is
the Pod readiness watch.

`SESSION-002` establishes the session with `OPEN_SESSION`, which restores from the Anchor's Save and
refills when a compatible one exists, or starts fresh otherwise (ADR 0008). Being an `ACTION`, it
re-emits its own tick on completion, so the Running→session step waits on no backoff.

`SESSION-003` passes to the next rule: a live session is reachable, but says nothing about whether
persona, model, capabilities or skills are realized.

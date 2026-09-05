# 006 — `SESSION`

`SESSION` is evaluated after [`CONSTRUCTION`](005_construction.md) passes, so the Workstream runs
the Pod built from the desired harness image. It brings that Pod to a live ACP session — restoring
the harness's durable context when one exists, starting fresh when none does — and waits without
acting while the transition it needs is owed by Kubernetes. It delivers no Handoff and selects no
persona, model or capability; closing the context gap and attaching authority belong to the rules
that follow.

## Inputs

`SESSION` reads only:

- [`observation.session`](002_observation.md);
- [`observation.anchor`](002_observation.md).

It carries no Intent field: whether a session should exist was settled by `POWER` and
`CONSTRUCTION`, and which harness it belongs to is what the Pod already runs.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `SESSION-001` | `observation.session = pending` | `HOLD` |
| `SESSION-002` | `observation.session = openable ∧ observation.anchor = compatible` | [`ACTION(RESTORE)`](003_verbs.md#restore) |
| `SESSION-003` | `observation.session = openable ∧ observation.anchor = none` | [`ACTION(START)`](003_verbs.md#start) |
| `SESSION-004` | `observation.session = live` | `PASS` |

The conditions partition the input: `pending`; `openable`, split on the Anchor; `live`. Exactly one
matches, and `observation.anchor` is consulted only when a session can be opened.

`SESSION-001` is the one place a rule waits on Kubernetes. The Pod exists and runs the right image,
but its harness process is not yet reachable; no verb can speed a scheduler, so the rule `HOLD`s
rather than select a doomed action. The engine re-evaluates the work row when the Pod's readiness
watch fires, or when the backoff for `(workstream, intent_seq, SESSION)` elapses. Its wake source is
the Pod readiness watch.

`SESSION-002` and `SESSION-003` are the restore-versus-fresh decision, made here from observed
evidence rather than inside a verb. A compatible Anchor means the harness's own continuity exists
and is resumed without replay; none means a fresh context at watermark `0`. A harness change lands
on `SESSION-003` — its Anchor, if any, belongs to a different `harness_id` — which is how a swap
re-seeds from product history instead of restoring
([ADR 0008](../../adr/0008-saves-anchors-and-refill.md)). Both verbs re-emit their own tick on
completion, so this step waits on no backoff.

`SESSION-004` passes to [`SYNC`](007_sync.md): a live session is reachable, but its context may
still lack everything the Workstream recorded while this harness was not the current one.

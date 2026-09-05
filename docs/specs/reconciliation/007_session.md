# 007 — `SESSION`

`SESSION` is evaluated after [`CAPABILITIES`](006_capabilities.md) passes, so the Workstream runs
the Pod built from the desired harness image. It brings that Pod to a live ACP session — restoring
the harness's durable context when one exists, starting fresh when none does — and waits without
acting while the transition it needs is owed by an external owner. It delivers no Handoff and selects no
persona, model or capability. Required authority has already been verified; configuration and
context synchronization follow.

## Inputs

`SESSION` reads only:

- [`observation.session`](002_observation.md);
- [`observation.anchor`](002_observation.md).

It carries no Intent field: whether a session should exist was settled by `POWER` and
`CONSTRUCTION`, and which harness it belongs to is what the Pod already runs.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `SESSION-005` | `observation.session = unusable` | [`ACTION(TURN_OFF)`](003_verbs.md#turn_off) |
| `SESSION-001` | `observation.session = pending` | `HOLD` |
| `SESSION-002` | `observation.session = openable ∧ observation.anchor = compatible` | [`ACTION(RESTORE)`](003_verbs.md#restore) |
| `SESSION-003` | `observation.session = openable ∧ observation.anchor = none` | [`ACTION(START)`](003_verbs.md#start) |
| `SESSION-004` | `observation.session = live` | `PASS` |

The conditions partition the input: `unusable`; `pending`; `openable`, split on the Anchor; `live`.
Exactly one matches, and the Anchor is consulted only when a context can safely be opened.

`SESSION-005` selects cleanup of the unusable execution. The next tick, under a still-on Intent,
can rebuild. A permanently failed restore is recorded and its Save compatibility handled under
specs 06/07 before this cleanup; no fresh fallback occurs in the failed Session.

`SESSION-001` waits only while an owner can still progress. Pod/launcher changes and bounded backoff
wake the row; expiration of the startup deadline is reflected by fresh owner evidence as unusable.
An unknown delivery or unavailable owner is handled by acquisition/retry control, never treated as
proof that no context exists.

`SESSION-002` and `SESSION-003` select the observed target harness's own compatible Anchor or a fresh
context. Returning A → B → A can resume A's Anchor. A different harness does not by itself imply
that no Anchor exists. Both paths use the new Agora Session already created for this Pod.

`SESSION-004` passes to [`CONFIG`](008_config.md). Reachability alone permits no user work.

# 009 — `SYNC`

`SYNC` is evaluated after [`CONFIG`](008_config.md) passes with a live ACP context, verified
authority and the requested model/effort. It closes the
gap between what that session's native context incorporates and what the Workstream recorded up to
the session's activation, by delivering the opening Handoff
([spec 06](../06-anchors-and-handoffs.md)). It is the reconciled form of both resuming and
cross-seeding: the same rule, distinguished only by the watermark.

## Inputs

`SYNC` reads only [`observation.sync`](002_observation.md). It carries no Intent field: what the
context must contain is fixed by the Workstream's own record, not by a desired value.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `SYNC-001` | `observation.sync = stale` | [`ACTION(REFILL)`](003_verbs.md#refill) |
| `SYNC-002` | `observation.sync = current` | `PASS` |

The two values of `observation.sync` partition the input, so exactly one row matches.

`SYNC-001` delivers the opening Handoff for `(W, head]`: the whole product history when the session
was started at watermark `0` — a harness that never ran here, or whose Anchor was incompatible; the
cross-seed — and only the missing tail when it was restored at the Anchor watermark — the resume.
The rule does not distinguish the two; the watermark does.

`SYNC-002` passes to [`CONVERGE`](010_converge.md). `current` is observed from the harness's own transcript, never
inferred from a recorded acknowledgement: a session restored from a Save that predates its Handoff
reads `stale` and is refilled again. That readback is what makes `SYNC` a reconciled field rather
than a remembered one.

`SYNC` is not a standing drift reconciler. Under the mono-active Workstream — one current Session,
every prompt routed to it — no gap opens while a session is live; the only gap is the one at
activation, and `SYNC-001` fires until it is closed. Prompt admission waits for `SYNC-002`, so the
head `REFILL` pins is the head at activation. Should the Workstream ever admit several live
Sessions, this rule becomes a watermark-against-head comparison, and the transcript readback it
already relies on is what would keep that extension observable.

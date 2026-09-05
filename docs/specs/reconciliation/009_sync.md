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

`SYNC-001` commits or recovers the one opening Handoff for the descriptor's fixed `(W, H]`.
`W = 0` gives the cross-seed; a restored Save gives the missing tail. `H` was fixed before the new
Session's facts, never sampled at REFILL dispatch. The rule does not choose between these modes.

`SYNC-002` passes to [`CONVERGE`](010_converge.md). Current native evidence must prove the exact
input and completed incorporation/continuity under the driver contract. Neither a URI occurrence
nor a recorded acknowledgement is enough. An empty opening range requires no prompt.

A hot Session transition that keeps the verified native context preserves its opening descriptor;
it does not refill. Loss of process/context or verifiable lineage invalidates synchronization even
under mono-active routing. Ambiguous acceptance is acquisition/attempt recovery under spec 13 and
never automatically becomes `stale`. See [spec 06](../06-anchors-and-handoffs.md) for proof and policy
limits, and the REFILL verb for per-context command identity.

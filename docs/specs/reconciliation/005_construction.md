# 005 — `CONSTRUCTION`

`CONSTRUCTION` is evaluated after [`POWER`](004_power.md) passes with `intent.power = on`. It
ensures the Workstream runs exactly one Pod built from the desired harness image: it creates that
Pod when none exists, and removes a Pod running the wrong image so a later tick can rebuild it. It
judges only which harness image runs, not whether the Pod is ready or usable.

## Inputs

`CONSTRUCTION` reads only:

- [`intent.harness`](001_intent.md), resolved through the reviewed catalogue to one pinned image
  digest `D` ([ADR 0006](../../adr/0006-complete-harness-images.md));
- [`observation.construction`](002_observation.md).

`intent.harness` is the only Intent field that selects the Pod's image: persona, skills and
capabilities produce no image variant (ADR 0006), so they are never construction inputs and never
change this rule's result.

## Rules

Let `D` be the image digest `intent.harness` resolves to.

| Rule | Conditions | Result |
|---|---|---|
| `CONSTRUCT-001` | `observation.construction = ∅` | [`ACTION(BUILD)`](003_verbs.md#build) |
| `CONSTRUCT-002` | `observation.construction ≠ ∅ ∧ observation.construction ≠ {D}` | [`ACTION(TURN_OFF)`](003_verbs.md#turn_off) |
| `CONSTRUCT-003` | `observation.construction = {D}` | `PASS` |

The conditions are mutually exclusive and exhaustive over `observation.construction`: empty, a
non-empty set that is not exactly `{D}`, or exactly `{D}`. A set that is not exactly `{D}` covers a
wrong harness image, a stale digest under the same `harness_id`, and any duplicate or orphaned Pod;
all are torn down before a clean rebuild.

A stale Pod is not swapped in place. `CONSTRUCT-002` selects the same `TURN_OFF` as `POWER`: it
captures the Save under the running harness's Anchor and tears the footprint down. Because
`intent.power` is still `on`, the successor tick passes `POWER` and reaches `CONSTRUCT-001`, which
builds the Pod from the now-current `intent.harness`. Reusing `TURN_OFF` keeps the verb catalogue
small and keeps the swap consistent with the "an action returns nothing; the next tick decides"
law: `TURN_OFF` never knows whether it extinguishes for good or to make way for a rebuild.

Comparing against the pinned digest `D` means a re-pinned image under the same `harness_id` reads as
stale and is replaced. If a mere image upgrade should not disrupt a running Pod, `CONSTRUCT-002` can
compare `harness_id` instead and let the digest converge at the next teardown — a policy choice for
this rule, not a change to the Observation.

Whether a rebuilt Pod restores its predecessor's native context or starts fresh is not decided here.
It is settled when the Session is opened: a compatible Save exists only for the same `harness_id`,
so a same-harness rebuild restores and refills while a harness change re-seeds from product history
([ADR 0008](../../adr/0008-saves-anchors-and-refill.md)).

Readiness follows in the next rule. A Pod that runs `D` may still be `Pending`, or `Running` without
a live ACP session; `CONSTRUCT-003` only establishes that the right image is being run.

# 005 — `CONSTRUCTION`

`CONSTRUCTION` is evaluated after [`POWER`](004_power.md) passes with `intent.power = on`. It
ensures the Workstream runs exactly one coherent footprint envelope — a Pod built from the desired
harness image, with its OneCLI Agent and relay binding — creating it when none exists and removing
an incoherent or wrong-image footprint so a later tick can rebuild it. It judges the admitted image
and whether the envelope is whole and reusable; a healthy startup can pass without ACP readiness.

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
wrong harness image, a stale digest under the same `harness_id`, an incomplete envelope (`⊥`: a Pod
without its Agent or binding, or an Agent or binding without its Pod) and any duplicate footprint;
all are torn down before a clean rebuild. The envelope is one construction unit: it is built whole
by `BUILD` and torn down whole by `TURN_OFF`, so a drifted part is repaired by rebuilding the unit,
never by re-attaching it in place.

A stale Pod is not swapped in place. `CONSTRUCT-002` selects the same `TURN_OFF` as `POWER`: it
attempts a bounded Save under the running harness's Anchor and tears the footprint down regardless
of capture outcome. Because `intent.power` is still `on`, the successor tick passes `POWER` and
reaches `CONSTRUCT-001`, which
builds the Pod from the now-current `intent.harness`. Reusing `TURN_OFF` keeps the verb catalogue
small and keeps the swap consistent with the "an action returns nothing; the next tick decides"
law: `TURN_OFF` never knows whether it extinguishes for good or to make way for a rebuild.

Comparing against the pinned digest `D` means a re-pinned image under the same `harness_id` reads as
stale and is replaced. Registry publication must explicitly re-enqueue affected Workstreams under
the shared revision contract in [revision publication](engine.md#intent-authoring-and-revision-selection); worker-local deployment versions cannot change the target.

Whether a rebuilt Pod restores or starts fresh is decided by `SESSION`, from the target harness's
own compatible Anchor. A → B → A can resume A; neither a harness change nor a same-harness image
upgrade proves compatibility or absence by itself (ADR 0008).

Authority reconciliation follows. A coherent Pod on `D` can still be Pending or await ACP launch.
Terminal/retired footprints instead include `⊥` and select cleanup here, before any later HOLD.
BUILD attempt recovery is operation-specific; after an attempt ends, an observed incomplete envelope
is torn down rather than repaired by an unregistered domain action.

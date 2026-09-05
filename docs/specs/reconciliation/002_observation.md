# 002 — Observation taxonomy

`observation.*` contains normalized current evidence derived during the current tick from the
systems that own the observed resources. It is not read from a persisted Agora current-state row.

A normalized field may be produced only from the fresh and exhaustive source reads declared for
that field during the current tick. Retaining an Observation for diagnostics does not make it valid
for a later tick.

## `observation.power`

`observation.power` is a scalar with exactly two values: `on` or `off`. It is derived from these
authoritative inventories for the Workstream:

- every Kubernetes Pod, regardless of phase, readiness or termination state;
- every OneCLI Agent, including an Agent with no effective grant;
- every effective OneCLI grant;
- every Broker relay binding, including an inactive or unhealthy binding.

Each owner MUST expose stable Workstream attribution that makes its inventory exhaustive even when
another resource, such as the Pod, has already disappeared. Session facts MUST NOT be used as a
live inventory or as proof of absence.

Given the fresh inventories `pods`, `agents`, `grants` and `bindings`:

```text
observation.power = off
  iff pods = ∅ ∧ agents = ∅ ∧ grants = ∅ ∧ bindings = ∅

observation.power = on
  iff pods ≠ ∅ ∨ agents ≠ ∅ ∨ grants ≠ ∅ ∨ bindings ≠ ∅
```

A footprint containing Pending, Failed, Terminating, orphaned or duplicate resources is therefore
`on`. `on` means only that a live execution or authority footprint exists; it does not mean that
execution is ready, coherent or usable.

If any required inventory fails or cannot prove exhaustive coverage, `observation.power` is not
produced and `POWER` is not evaluated. `unknown` is not a third value; observation retry belongs to
the reconciliation engine rather than the rule table.

ACP connections, prompt admission, readiness, quiescence, Sessions, Session facts, Saves and
Anchors are not part of `observation.power`. Durable history and recovery material may remain when
`observation.power = off`.

## `observation.construction`

`observation.construction` is the set of resolved container image digests the Workstream's Pods are
actually running, and is `∅` when the Workstream has no Pod. It is inferred from what Kubernetes
runs — never from an Agora-written annotation, an Intent value or a Session fact.

It is derived from one fresh read for the Workstream: every Kubernetes Pod, with the resolved image
reference (digest) of its harness container. Kubernetes runs exactly the referenced image, so this
is observed reality rather than a declared value: a Pod cannot report an image it is not running,
and no annotation the running image does not carry can be inferred.

The reviewed image catalogue pins each `harness_id` to one image digest
([ADR 0006](../../adr/0006-complete-harness-images.md)). Resolving `intent.harness` to its pinned
digest for comparison is the concern of the rule that reads this field, not of the Observation.
Because persona, skills and capabilities produce no image variant (ADR 0006), they never change
this value.

`observation.construction` reports only which images execute. Readiness, ACP connectivity and
Session state are not part of it.

## `observation.session`

`observation.session` is a scalar describing how far the Workstream's Pod has come toward a usable
ACP session, with exactly three values:

- `pending` — no Pod is `Running`, or its harness process is not yet reachable over ACP;
- `openable` — the Pod is `Running` and its ACP endpoint answers, but no live session exists;
- `live` — a live ACP session exists on the harness, able to accept prompts and configuration.

It is derived from two fresh reads for the Workstream: the Pod's Kubernetes phase, and the harness's
ACP session state observed through the Broker relay that owns the connection. It reports usability
only; which harness image runs is `observation.construction`, not this field. With no Pod at all it
is `pending`.

## `observation.anchor`

`observation.anchor` is a scalar with exactly two values, `compatible` or `none`, describing whether
durable continuation material exists for the harness the Workstream's Pod runs:

- `compatible` — the Anchor store holds an Anchor for `(workstream, harness_id)` whose Save is not
  invalidated and is resumable under the current reviewed harness definition: its recorded format
  id, format version and adapter version are ones that definition accepts
  ([spec 06, "Choosing a target Session"](../06-anchors-and-handoffs.md);
  [spec 07, "Compatibility"](../07-custody.md));
- `none` — no such Anchor, or its Save is invalidated or incompatible.

It is derived from a fresh read of the Anchor store and of the Save's non-opaque metadata — never
its payload ([ADR 0008](../../adr/0008-saves-anchors-and-refill.md); spec 07, "Opacity") — joined
with the reviewed harness definition. The `harness_id` is the one the live Pod runs, resolved from
`observation.construction`, so this field depends on no Intent value.

The Anchor store is an inventory of durable artifacts, not a current-state row about the runtime:
reading it observes what continuation material exists, not what the runtime claims to be. When
`compatible`, the Anchor's `synced_through_seq` is the watermark `W` a restored context
incorporates.

## `observation.sync`

`observation.sync` is a scalar with exactly two values, `current` or `stale`, describing whether the
live Session's native context holds the opening Handoff that closes the gap between its watermark
and the Workstream head at activation ([spec 06](../06-anchors-and-handoffs.md)). It is defined
when `observation.session = live`.

Let `W` be the watermark the live context incorporates by construction: the compatible Anchor's
`synced_through_seq` when the Session was restored, `0` when it was started fresh. An **opening
Handoff** is a durable Handoff command targeting the live Session with `source_from_seq = W`; its
`source_through_seq` is the head pinned when the command was committed.

```text
observation.sync = current
  iff some opening Handoff exists whose range (W, source_through_seq] is empty,
      or whose resource is present in the live native transcript

observation.sync = stale
  otherwise: no opening Handoff yet, or none whose non-empty range is present
```

Presence is a **readback of the harness's own transcript** — the same native context the custody
driver captures for a Save, read live — for the Handoff's stable resource URI
`agora://workstreams/{workstream_id}/handoffs/{command_id}`. Because a Handoff is a message in that
transcript, presence proves incorporation. An acknowledgement of delivery recorded by Agora does
not, and MUST NOT substitute for it: a Session restored from a Save captured before its Handoff
shows the URI absent and is `stale`, whatever Agora recorded for an earlier incarnation.

The Handoff command record supplies only the range a `REFILL` committed to; it is the definition of
the delivery, not evidence that it landed. Under the mono-active Workstream — one current Session,
every prompt routed to it — no gap can open while a Session is live, so `current` holds until the
Session is replaced.

## `observation.capabilities`

`observation.capabilities` is the set of capability ids currently effective as grants on the
Workstream's OneCLI Agent, possibly empty. It is derived from a fresh, exhaustive read of the
Agent's effective grants from OneCLI — the owning system
([ADR 0009](../../adr/0009-onecli-grant-authority.md)) — and never from an Intent value or a
persisted Agora row.

A capability is in the set only when every grant that realizes it is fully effective on the Agent; a
partially applied capability is absent. A grant changed directly on OneCLI is observed as it really
is, so a manual edit that diverges from Intent is visible here and reconverged by the next tick.

Later rules extend this registry when they require other normalized evidence.

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

`observation.construction` describes the Workstream's execution footprint as a set. Each **coherent
envelope** — one Pod running a harness image, with its bound OneCLI Agent and relay binding both
present — contributes the resolved digest of that Pod's image. Any footprint that is not part of a
coherent envelope — a Pod without its Agent or binding, an Agent or binding without its Pod, a
second Pod — contributes the distinguished element `⊥`. The set is `∅` when the Workstream has no
footprint at all.

It is derived from fresh reads of the same inventories as `observation.power`: every Kubernetes Pod
with the resolved image reference (digest) of its harness container, every OneCLI Agent and every
Broker relay binding, each attributed to its Pod. It is inferred from what those systems run and
hold — never from an Agora-written annotation, an Intent value or a Session fact. Kubernetes runs
exactly the referenced image, so a digest is observed reality rather than a declared value: a Pod
cannot report an image it is not running, and no annotation the running image does not carry can
be inferred.

The reviewed image catalogue pins each `harness_id` to one image digest
([ADR 0006](../../adr/0006-complete-harness-images.md)). Resolving `intent.harness` to its pinned
digest for comparison is the concern of the rule that reads this field, not of the Observation.
Because persona, skills and capabilities produce no image variant (ADR 0006), they never change
this value.

`observation.construction` reports which envelopes execute and whether the footprint is whole.
Readiness, ACP connectivity and Session state are not part of it.

## `observation.session`

This scalar describes the current Pod/process/native context, not an Agora Session lifecycle phase:

- `pending`: the Pod/controlled launcher is still progressing within its startup deadline and has
  no usable ACP context yet;
- `openable`: the Pod is Running, its controlled launch seam can safely initialize the pinned
  harness, and owner readback proves no live context is bound;
- `live`: the current process owns a reachable, attributable ACP context able to accept controlled
  configuration or prompts under the admission contract;
- `unusable`: a terminal Pod/process, a lost or replaced context, expired startup deadline or
  unrecoverable launch/context failure prevents reuse of this execution boundary.

Sources are fresh Kubernetes status, the runtime controller's live launch/process evidence and the
harness/driver reads specified by [ACP integration](../04-acp-integration.md) and
[Harness conformance](../09-agent-registry.md). An unreachable owner that cannot distinguish a live
context from absence produces no value; it does not prove `openable`. A historical Session row or
an action error cannot by itself produce `unusable`.

The controlled launch seam is operational runtime control, not a custom ACP method. It permits
restore before starting the ACP context. The ACP bridge and Broker provider relay are distinct.
With no Pod, this field is inapplicable: construction must act before the Session rule.

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

A hot Agora Session transition that retains the same verified live context retains its original
opening descriptor and continuity proof ([Session boundaries](../03-session-lifecycle.md)). It
creates no new opening Handoff. Replacement below means replacement of the native context
incarnation, not merely a change of Agora attribution.

The Handoff command record supplies only the range a `REFILL` committed to; it is the definition of
the delivery, not evidence that it landed. Under the mono-active Workstream — one current Session,
every prompt routed to it — no gap can open while a Session is live, so `current` holds until the
Session is replaced.

## `observation.model`

The actual model id of the live context, read through the reviewed standard ACP model config option.
It is defined when `observation.session = live`, under the fresh snapshot/continuous-stream contract
in [ACP integration](../04-acp-integration.md#current-evidence-and-configuration).

A resumed context must report its actual model, not a default copied from the request. This is an
enablement requirement on the pinned integration, not an assertion about an unverified adapter.

## `observation.effort`

The actual effort of that same live context, acquired under the same contract. Values and valid
choices depend on the observed model. Model changes may rebuild the option and clamp unsupported
values; the next tick must observe the resulting model/options before selecting an effort change.
Missing required options or broken readback invalidate acquisition; they never imply `default`.

## `observation.grants.attached` and `observation.grants.effective`

These fields are sets of exact non-secret grant authorizations on the one Pod-bound OneCLI Agent:

- `observation.grants.attached` reports what OneCLI currently attaches to that Agent, including
  attachments masked by organization policy;
- `observation.grants.effective` reports the authority actually usable after OneCLI's restrictions.

Both come from fresh, exhaustive OneCLI inventories for the same Agent incarnation. They are
defined only after construction establishes that unique Agent. Their representation and equality
are defined in [Capabilities and OneCLI](../10-equipment-and-broker.md#exact-grant-comparison).
Credential/connection identity, tool scope, approval mode and restrictions are preserved. Unknown
or partially attached rights are retained as independently removable entries, never dropped because
they do not complete a named capability. Failed or inconsistent inventory reads produce neither a
fabricated empty set nor a conclusion about effective authority.

The observations depend on no Intent value. The rule compiles the desired capability set separately
for comparison. OneCLI denial reasons and source revisions accompany acquisition as diagnostics;
they are not a capability, action result or persisted proof of current access.

Later rules extend this registry when they require other normalized evidence.

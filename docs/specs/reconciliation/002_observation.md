# 002 — Observation taxonomy

`observation.*` contains normalized current evidence derived during the current tick from the
systems that own the observed resources. It is not read from a persisted Agora current-state row.

A normalized field may be produced only from the fresh and exhaustive source reads declared for
that field during the current tick. Retaining an Observation for diagnostics does not make it valid
for a later tick.

## `observation.power`

This scalar has exactly two values: `on` and `off`. Its authoritative Workstream inventories are:

- every Kubernetes Pod, regardless of phase/readiness/termination;
- runtime control's unresolved retirement obligations for Pod incarnations whose physical execution
  is not yet proven stopped or fenced ([spec 08](../08-session-runtime-control.md));
- every OneCLI Agent, including an Agent with no grants;
- every attached or effective OneCLI grant;
- every Broker relay binding, including an inactive or unhealthy binding.

Each owner provides stable Workstream attribution and exhaustive coverage independent of another
resource's existence. A missing Pod cannot hide its Agent, grant, binding or retirement obligation.
Session facts are not an inventory. Retirement records track unfinished controller work and require
current owner verification; a historical deletion receipt cannot discharge them.

```text
observation.power = off
  iff every required inventory is freshly verified empty

observation.power = on
  iff at least one fresh owner observation proves a remaining footprint
```

An incomplete acquisition cannot prove `off`. A positive footprint suffices for `on` even while
another owner is unavailable, so an off Intent can start cleanup on reachable owners. If neither
predicate can be established, acquisition produces no value and the engine retries; `unknown` is
not a third rule value. Later fields still require their own complete source reads.

Pending, Failed, Terminating, duplicate and orphaned resources all count as `on`. It says nothing
about readiness or useful work. ACP connections, admission, Sessions, Session facts, Saves and
Anchors are not themselves power footprint. Recovery material remains after extinction.

## `observation.construction`

This set describes the execution envelope. Exactly one coherent, reusable envelope contributes its
harness image digest. An empty footprint contributes `∅`. Every incomplete, duplicate, wrong-bound
or retired component contributes `⊥`; in particular, two envelopes on the same digest still add
`⊥`, rather than collapsing into an apparently valid singleton.

A coherent envelope has one non-retiring Pod, its unique Pod-bound selective OneCLI Agent and its
relay binding. A Pending Pod can be coherent. Terminal/terminating Pods, unresolved retired
incarnations and owner-verified unrecoverable launch/process loss cannot be reused and contribute
`⊥`. The runtime owner applies the original startup deadline; a failed Pod cannot remain a valid
construction forever because a later capability row is waiting for propagation.

Sources are fresh exhaustive Kubernetes, runtime-retirement, OneCLI and Broker inventories, joined
by immutable Pod/Agent binding identities. Image evidence comes from Kubernetes' admitted pinned
Pod spec and, when running, the container image ID, checked under the reviewed manifest/platform
digest mapping. A Pending Pod exposes a requested image, not evidence of executing it. An annotation,
tag, current Intent or Session fact is never substituted for this evidence.

The trusted catalogue maps each `harness_id` to a pinned digest. The rule resolves the desired
harness separately; Observation reports the observed envelope without reading Intent. Persona,
skills and capabilities create no image variant (ADR 0006). The runtime contract specifies the
fixed isolation/binding checks; this field does not establish ACP connectivity, config or admission.

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

- `compatible` — the Anchor store holds an Anchor for `(workstream, harness_id)` whose Save/target pair has no verified
  invalidation and is resumable under the current reviewed harness definition: its recorded format
  id, format version and adapter version are ones that definition accepts
  ([spec 06, "Choosing continuation"](../06-anchors-and-handoffs.md);
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

This scalar has exactly two values, `current` and `stale`, for a verified live native context. It
compares that context with its immutable opening descriptor from
[spec 06](../06-anchors-and-handoffs.md): origin Pod/process/context, selected Save and frontier `W`
(or zero), and cutoff `H` fixed before the origin Agora Session's first facts.

```text
observation.sync = current
  iff the verified context origin has W = H,
      or fresh native proof establishes completed incorporation and continuing lineage
         of the exact opening Handoff for (W, H], its policy and content digest

observation.sync = stale
  iff W < H and fresh native evidence establishes the opening input is absent,
      with no possibly accepted delivery still unresolved
```

A native URI occurrence, echoed metadata, recorded command, transport receipt or past ACP success
alone satisfies neither predicate. The pinned driver must prove the exact native input and its
completion/lineage, including across supported compaction. It does not prove lossless retention or
semantic understanding of all Workstream facts. Core does not parse native transcripts or Save bytes.

Unverifiable lineage, an in-flight Handoff or unknown acceptance prevents producing a value; the
engine handles acquisition/attempt recovery and never invents `stale` to authorize a blind retry.
The two values partition valid, decisively acquired input; unavailable evidence is not a third value.

The descriptor is historical input defining what should have been supplied, not proof of delivery.
A hot Agora Session transition on the same verified native context keeps this descriptor; it sends
no new opening Handoff. Pod/process/context loss invalidates evidence even if an ACP id is reused.
Mono-active routing alone does not make synchronization permanent. Every use requires the freshness
and continuity contract in spec 04; declared source invalidation closes admission and re-enqueues work.

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

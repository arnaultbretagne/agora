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

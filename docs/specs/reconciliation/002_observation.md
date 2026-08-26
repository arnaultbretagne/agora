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

Later rules extend this registry when they require other normalized evidence.

# 003 — Verb taxonomy

A verb is the constrained action selected by `ACTION(verb)`. `PASS`, `HOLD` and `CONVERGED` are
results, not verbs.

Invoking a verb may change external systems, but has no semantic return value. A verb never returns
an Observation or decides which rule comes next. Once its attempt ends, the reconciler emits the
next `NOTIFY`; only that tick's fresh Observation determines the next result.

The verb catalogue is closed. Before implementation, every verb MUST define its owner, inputs,
idempotency contract and observable postcondition. A rule selects a verb; it does not inline the
verb's procedure or reproduce decisions owned by later rules.

## `BUILD`

`BUILD` is selected when a live footprint is wanted but the Workstream runs no Pod on the desired
harness image. It provisions, for the Workstream, one Pod from the image `intent.harness` resolves
to, together with the bound OneCLI Agent and relay binding that complete the footprint envelope. It
attaches no grant and opens no ACP session. Its observable objective is a subsequent fresh
`observation.construction` that contains that image (and therefore `observation.power = on`).

`BUILD` is idempotent on the Workstream's footprint: repeating it while the envelope is already
being created adds no second Pod, Agent or binding.

## `TURN_OFF`

`TURN_OFF` is selected when the current footprint must cease: because power is desired `off`, or
because a construction rule found the wrong footprint and wants it gone before a rebuild. It
performs the controlled shutdown of [ADR 0008](../../adr/0008-saves-anchors-and-refill.md): quiesce
the harness, capture the Save, advance the Anchor, revoke the grants and relay binding, remove the
OneCLI Agent, then delete the Pod. Its observable objective is a subsequent fresh
`observation.power = off`.

`TURN_OFF` does not decide whether the Workstream comes back up; the next tick reads `intent.power`
and the construction rules to decide that.

## `OPEN_SESSION`

`OPEN_SESSION` is selected when the Workstream's Pod is `Running` but holds no live ACP session. It
establishes the session on the harness: a fresh session, or — when a compatible Save exists for the
same `harness_id` — a restore from the Anchor followed by the refill of the product-history frontier
([ADR 0008](../../adr/0008-saves-anchors-and-refill.md)). Its observable objective is a subsequent
fresh `observation.session = live`.

`OPEN_SESSION` is idempotent on the Workstream's session: it opens no second session when one is
already live. Restore-versus-fresh is decided inside the verb from the Anchor store; the selecting
rule does not reproduce that choice.

## `GRANT`

`GRANT` is selected when the Workstream's Agent lacks grants that `intent.capabilities` requires. It
attaches, on that Agent, the OneCLI grants realizing every capability in `intent.capabilities` that
is absent from `observation.capabilities`
([ADR 0010](../../adr/0010-capabilities-are-onecli-grants.md)). Its observable objective is a
subsequent fresh `observation.capabilities` that includes those capabilities.

`GRANT` is idempotent: re-attaching an already-effective grant is a no-op.

## `REVOKE`

`REVOKE` is selected when the Workstream's Agent holds grants that `intent.capabilities` does not
authorize. It detaches, on that Agent, the OneCLI grants for every capability in
`observation.capabilities` that is absent from `intent.capabilities`. Its observable objective is a
subsequent fresh `observation.capabilities` that excludes those capabilities.

`REVOKE` is idempotent: detaching an absent grant is a no-op.

No verb returns its postcondition. Once its attempt ends, the reconciler obtains a fresh Observation
and reevaluates the rules from the first.

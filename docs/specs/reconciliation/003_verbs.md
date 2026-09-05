# 003 — Verb taxonomy

A verb is the constrained action selected by `ACTION(verb)`. `PASS`, `HOLD` and `CONVERGED` are
results, not verbs.

Invoking a verb may change external systems, but has no semantic return value. A verb never returns
an Observation or decides which rule comes next. Once its attempt ends, the reconciler emits the
next `NOTIFY`; only that tick's fresh Observation determines the next result.

The verb catalogue is closed. Before implementation, every verb MUST define its owner, inputs,
idempotency contract and observable postcondition. A rule selects a verb; it does not inline the
verb's procedure or reproduce decisions owned by later rules. A verb observes nothing and branches
on nothing: every decision it would need has already been made by the rule that selected it.

## `BUILD`

`BUILD` is selected when a live footprint is wanted but the Workstream runs no Pod on the desired
harness image. It provisions, for the Workstream, one Pod from the image `intent.harness` resolves
to, together with the bound OneCLI Agent and relay binding that complete the footprint envelope. It
attaches no grant and opens no ACP session. Its observable objective is a subsequent fresh
`observation.construction` that is exactly the coherent envelope on that image (and therefore
`observation.power = on`).

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

## `RESTORE`

`RESTORE` is selected when the Workstream's Pod is `Running` without a live ACP session and a
compatible Anchor exists for its harness. It places the Anchor's Save into the Pod — the control
plane does this; the runtime has no Save-store access
([ADR 0006](../../adr/0006-complete-harness-images.md)) — and binds the harness to the Anchor's
Session by `session/resume`, which replays no message
([ADR 0008](../../adr/0008-saves-anchors-and-refill.md)). The restored context incorporates the
Anchor watermark `W`. Its observable objective is a subsequent fresh `observation.session = live`.

`RESTORE` is idempotent on the Workstream's Session: it opens no second session when one is live. It
delivers no Handoff; closing the gap above `W` belongs to `REFILL`.

## `START`

`START` is selected when the Workstream's Pod is `Running` without a live ACP session and no
compatible Anchor exists for its harness. It opens a fresh, empty session on the harness, whose
context incorporates watermark `0`. Its observable objective is a subsequent fresh
`observation.session = live`.

`START` is idempotent on the Workstream's Session. It delivers no Handoff.

## `REFILL`

`REFILL` is selected when the live Session's context is `stale`. It commits the opening Handoff
command for the range `(W, head]` — `W` the watermark the Session incorporates, `head` the Workstream
head read at commit — and, when that range is non-empty, dispatches it as the Handoff prompt: a
deterministic, bounded `ContentBlock::Resource` at the stable URI, `purpose = handoff`
([spec 06, "Handoff representation"](../06-anchors-and-handoffs.md)). Its observable objective is a
subsequent fresh `observation.sync = current`.

`REFILL` is idempotent within one live incarnation of the Session: a retry rebuilds the same range
and dispatches nothing twice. A later incarnation — the Session reopened after a Save captured
without the Handoff — is a new idempotency scope, so the same range is delivered again rather than
refused. Prompt admission waits for `observation.sync = current`, so the head read at commit is the
head at activation, never one advanced by the Session's own turns.

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

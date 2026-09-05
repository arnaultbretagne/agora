# 003 — Verb taxonomy

A verb is the constrained action selected by `ACTION(verb)`. `PASS`, `HOLD` and `CONVERGED` are
results, not verbs.

Invoking a verb may change external systems, but has no semantic return value. A verb never returns
an Observation or decides which rule comes next. Once its attempt ends, the reconciler emits the
next `NOTIFY`; only that tick's fresh Observation determines the next result.

The verb catalogue is closed. Before implementation, every verb MUST define its owner, inputs,
idempotency contract and observable postcondition. A rule selects a verb; it does not inline the
verb's procedure or reproduce decisions owned by later rules. Rules choose the business objective.
A verb may verify ownership, preconditions and partial effects to execute or recover that objective
safely. It MUST NOT choose a different business objective or report its response as Observation.

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

## `SET_MODEL`

`SET_MODEL` is selected when the live Session runs a model other than `intent.model`. It sets the
session's `model` configuration option to `intent.model` by `session/set_config_option`; the change
takes effect on the next turn, and the adapter re-derives the valid effort levels for the new model.
Its observable objective is a subsequent fresh `observation.model = intent.model`.

`SET_MODEL` is idempotent: setting the current value is a no-op. It touches no other option. If the
model change clamps the effort level, the next tick observes that and `SET_EFFORT` corrects it.

## `SET_EFFORT`

`SET_EFFORT` is selected when the live Session runs `intent.model` but an effort level other than
`intent.effort`. It sets the session's `effort` configuration option to `intent.effort` by
`session/set_config_option`, effective on the next turn. Its observable objective is a subsequent
fresh `observation.effort = intent.effort`.

`SET_EFFORT` is idempotent. It is only ever selected once the model is correct, so the level it sets
is validated against the model that will actually run.

## `GRANT`

**Owner:** Broker control, using OneCLI. **Inputs:** Workstream, Pod UID, bound Agent, current
mutation authority, attempt key and the exact desired grant set compiled for one policy revision.

`GRANT` attaches the missing desired authorizations only after the rule has established that neither
attached nor effective authority exceeds that set. It preserves rights shared by desired
capabilities. Work admission remains gated during the transition.

**Idempotency and recovery:** the key binds the same target and exact grant payload. A retry reads
OneCLI and completes missing attachments; it never appends broader defaults. Unknown acceptance is
resolved through OneCLI readback before reissuing an equivalent mutation. External denial is
reported without modifying organization policy.

**Observable postcondition:** a later `observation.grants.attached` equals the desired set. Effective
equality is independently observed; attachment alone does not permit work.

## `REVOKE`

**Owner and inputs:** the same ownership and target contract as `GRANT`.

`REVOKE` removes every attached or effective excess authorization, including partial, unknown,
masked or over-broad entries. It narrows a connection grant to the desired tool/approval scope, or
detaches it before a later `GRANT` if OneCLI cannot safely narrow it. It preserves shared desired
rights whenever the owner supports that mutation. Restriction cannot depend on ACP health.

**Idempotency and recovery:** absence is a no-op; partial revocation is reread and completed against
the same target. The relay is closed to affected traffic before changing authority and existing
tunnels are terminated. Unremovable externally supplied authority leaves access gated and a typed
diagnostic requiring its owner; it is never declared removed.

**Observable postcondition:** a later union of `observation.grants.attached` and
`observation.grants.effective` is a subset of the desired set.

No verb returns its postcondition. Once its attempt ends, the reconciler obtains a fresh Observation
and reevaluates the rules from the first.

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

**Owner:** runtime control and Broker, coordinated by the control plane. **Inputs:** Workstream,
still-current creation authority, stable attempt key, pinned target harness/catalogue revision and
reviewed workspace reference. The rule has proved that the footprint is empty.

Create one gated Pod and its uniquely bound selective OneCLI Agent and relay binding. Record
creation correlations before dispatch and discover each partial effect through its owner. Once the
Pod exists, complete its idempotent Agora Session birth before native launch. BUILD attaches no
grant and opens no ACP context. A request that produces no Pod has no Session.

**Idempotency and recovery:** the same attempt completes or discovers the same reserved targets.
An unknown creation cannot free the slot for a competing BUILD. A stale owner cannot create or
activate a successor; late resources remain discoverable and fenced. A partial envelope after the
attempt ends is observed as incoherent and the rule selects cleanup on the next tick.

**Observable postcondition:** exactly one coherent envelope on the pinned image,
`observation.construction = {D}`. This establishes neither live ACP nor work admission. Full target,
retirement and launch contracts are in [execution](execution.md).

## `TURN_OFF`

**Owner:** runtime control, Broker and custody/control plane for the optional Save. **Inputs:**
Workstream, concrete footprint/retirement targets, current mutation authority, stable shutdown
attempt, original deadline and the producing Session/context when one exists.

Close admission and affected relay paths, terminate existing tunnels and start OneCLI revocation
independently of ACP. Attempt quiescence and eligible Save capture within the fixed shutdown budget;
conditionally advance the Anchor only after commit. Continue Pod termination and Agent/binding
cleanup whether saving succeeds, fails or times out. No extra forced-loss permission is required
([ADR 0008](../../adr/0008-saves-anchors-and-refill.md)).

**Idempotency and recovery:** repeat cleanup on the same concrete targets, discover partial effects
and committed Saves, and never reset the preservation deadline. Reachable owners progress even if
another fails. Unknown physical execution remains in the runtime retirement inventory until stopped
or fenced; deleting its API object alone cannot complete the objective. An old attempt cannot delete
a replacement by following a reused name or Workstream alias.

**Observable postcondition:** all required inventories empty, `observation.power = off`. No `off`
Session is created. The verb never decides whether to rebuild; only a later tick's Intent and rules
do. It has no semantic success value that could replace the independent absence check.

## `RESTORE`

**Owner:** control plane, through runtime custody/launch control and ACP. **Inputs:** current
Workstream/Pod/process, the newly opened Agora Session, selected immutable Save, context descriptor,
current mutation authority and stable attempt key.

The rule has established `openable` and a compatible Anchor. Authority is already reconciled.
Runtime control places and verifies Save bytes before the ACP context starts; the Pod has no
Save-store access. The control plane initializes ACP and calls standard `session/resume` for the
Save's native context. It binds that context to the new Agora Session, never to the producing
Session. It delivers no Handoff.

**Idempotency and recovery:** one attempt binds one Save and target. Partial byte placement is
recovered by the custody contract; unknown ACP acceptance requires live-context discovery or stays
explicitly unresolved. A second context is never opened merely because a response was lost.

**Observable postcondition:** `observation.session = live` for the selected restored context, with
its origin watermark recorded. Permanent failure remains attributed to the attempted Session and
uses the explicit cleanup/fallback contract, never an inline switch to `START`.

## `START`

**Owner:** control plane and standard ACP. **Inputs:** current Workstream/Pod/process, newly opened
Agora Session and context descriptor at watermark zero, mutation authority and stable attempt key.

The rule has established `openable` and no compatible Anchor. With required authority verified,
initialize ACP and call `session/new`. Capture and bind the actual returned native context. No
Handoff is delivered here.

**Idempotency and recovery:** replay of local bookkeeping is idempotent. ACP context creation is
not assumed universally idempotent: after possible acceptance, discover the actual context or leave
the attempt unresolved under [delivery recovery](engine.md#prompt-delivery-and-context-creation). Never open another context on a blind retry.

**Observable postcondition:** `observation.session = live` for the fresh context at watermark zero.

## `REFILL`

**Owner:** control plane, canonical history renderer and ACP bridge. **Inputs:** current live
context/opening descriptor, immutable `(W, H]`, rendering-policy revision, verified grants/config,
current dispatch ownership and the descriptor's stable opening-command identity.

Commit or recover the exact Handoff range, digest and standard embedded content under
[Native continuity](continuity.md). `H` was frozen before the origin Session's first facts;
the current journal head is not an input. The rule has proved stale context with no unresolved
possibly accepted opening delivery. Send the Handoff under the same effectful-turn admission barrier
as other work, except its own synchronization prerequisite. An empty range requires no dispatch.

**Idempotency and recovery:** rebuilding command data is idempotent within this native-context
origin, including hot Agora Session changes. Delivery is not universally idempotent. Possible ACP
acceptance must be resolved under [delivery recovery](engine.md#prompt-delivery-and-context-creation), never blindly retried or deduplicated by URI alone.
A clean replacement is a new Pod/Agora Session and context-origin scope even if native resume reuses
an ACP identifier; prior remote effects may still be ambiguous.

**Observable postcondition:** fresh driver evidence yields `observation.sync = current` for this
origin. A response, command receipt or URI match alone does not establish it.

## `SET_MODEL`

`SET_MODEL` is selected when the live Session runs a model other than `intent.model`. It sets the
session's `model` configuration option to `intent.model` by `session/set_config_option`; the change
must take effect before the next turn, with actual effort options reported for the new model.
Its observable objective is a subsequent fresh `observation.model = intent.model`.

**Owner:** control plane/ACP. **Inputs:** current target context, desired model, verified transition
boundary and stable attempt key. Unknown acceptance is resolved by config readback under [ACP evidence](execution.md#acp-facts-and-current-evidence).
The same setting is safely repeatable only for the same live target and still-current desired value.
The integration must demonstrate safely repeatable model selection. Changing model can alter effort
options; the next tick observes the actual result before `SET_EFFORT`. No other desired option is
implicitly rewritten or accepted as a substitute.

## `SET_EFFORT`

`SET_EFFORT` is selected when the live Session runs `intent.model` but an effort level other than
`intent.effort`. It sets the session's `effort` configuration option to `intent.effort` by
`session/set_config_option`, effective on the next turn. Its observable objective is a subsequent
fresh `observation.effort = intent.effort`.

**Owner and target contract:** control plane/ACP, as for `SET_MODEL`, with the desired effort and
verified running model. Partial/unknown completion is reread before repeat; a changed model
invalidates the precondition. `SET_EFFORT` is idempotent. It is only ever selected once the model is correct, so the level it sets
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

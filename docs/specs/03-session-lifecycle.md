# Session boundaries and work admission

This specification applies ADRs [0002](../adr/0002-workstream-session-model.md),
[0007](../adr/0007-kubernetes-runtime.md) and [0008](../adr/0008-saves-anchors-and-refill.md).
It replaces the former durable lifecycle phases. Session facts record execution; live admission is
owned by the control/transport and runtime boundaries and is verified from those owners.

## Identities and attribution

- A Session belongs permanently to one Workstream and logs one realized execution.
- Every new Pod incarnation has a new Agora Session, even when it resumes an old ACP context.
- A retained Pod can carry successive Sessions across a verified quiescent boundary.
- Pod UID, process generation and ACP context identifier are non-secret correlations. They do not
  define an additional domain aggregate. One ACP identifier may occur in several Agora Sessions.
- A reconnect to the same verified live process/context alone creates no new Session.
- A lost or replaced process/context invalidates its evidence and ends ordinary work admission. It
  cannot silently continue under the previous Session identity.

All execution facts enter the Workstream stream once. A projection may expose a Session timeline,
last error or previously verified conditions, but none is proof of current readiness.

## Birth on a new Pod

1. The controller establishes the Pod under a stable creation attempt; harness work stays gated.
2. The control plane verifies current ownership and the Pod UID. Under Workstream ordering, it pins
   `H` to the head before any fact of the new Session, opens the Session and records the Pod's
   provenance. The operation is idempotent for that Pod establishment.
3. If the Pod exists but startup fails, that Session retains the failure and cleanup facts. A
   creation request that never establishes a Pod has operational diagnostics but no Session.
4. The initially ungranted Agent is reconciled to the required exact authority before bootstrap
   that needs provider access. All controlled bootstrap is attributed to the new Session.
5. The rules select native restore/resume or a fresh ACP context. The selected origin, Save if any,
   watermark `W` and opening cutoff `H` are recorded immutably for this context incarnation.
6. Model and effort are applied and read back before an opening Handoff may start.
7. User-purpose work is admitted only after verified synchronization and all other current Intent
   conditions. A failed bootstrap or Handoff does not erase or reuse the Session.

Creating a Session and admitting work are distinct operations. The Session exists before its first
ACP envelope; it need not ever become usable. Recording desired values as realized configuration
before verification is forbidden.

## Admission conditions

The control plane owns prompt admission; the runtime controller and Broker enforce the corresponding
execution and transport restrictions. A durable work obligation is not permission to execute.

The following conditions are checked for the same Workstream and target incarnation:

- the current Intent requests power on and the acting controller still owns its mutation boundary;
- exactly one reviewed Pod/Agent/binding envelope exists and predecessor authority is fenced out;
- a Session already owns the bootstrap or work being dispatched;
- required OneCLI attachments and effective rights match the complete compiled set;
- native context and ACP connection are established and attributable;
- model and effort match the requested values before any Handoff or user prompt;
- synchronization is verified before a user prompt;
- no prior prompt, callback, tool process or unresolved delivery prevents the required boundary.

A Handoff is an effectful ACP prompt and may invoke the model and tools. It receives the same exact
authority/configuration checks as other work, with only its own synchronization precondition omitted.
The reviewed bootstrap contract must state any provider access required before config readback.
It cannot start an unrequested generation or admit user work as a shortcut to obtaining that readback.

Prompt admission is serialized with new Intent authoring, transition start and finalization. A
prompt command accepted earlier is revalidated before actual dispatch; it is never silently moved
to a different Session or sent with stale authority. At most one prompt turn is in flight per
Workstream, including Handoffs. A superseding Intent closes further admission immediately.

## Hot transition on a retained Pod

The boundary wraps the rule-selected changes; it is not an alternate lifecycle command API.

1. Close new prompt admission. Bind the transition to its current Intent, resolved policy/catalogue,
   Pod/process/context and the Session whose work is ending.
2. Reach quiescence: finish or cancel the in-flight turn, settle its final ACP exchange, and drain or
   terminate its tool processes and external requests. A cancel notification alone proves none of
   this. A bounded operational deadline prevents unlimited waiting.
3. Restriction can close provider access immediately without waiting for ACP. Consequences for the
   interrupted turn stay attributed to its original Session. Additions and config changes wait for
   the quiescent boundary.
4. Apply only rule-selected mutations. Each transition exchange is a fact of the previous Session.
   Partial changes leave work gated; a failure never admits a mixed configuration.
5. After fresh verification of the complete effective conditions, conditionally commit the boundary
   against the still-current Intent and target. Close old attribution and open the next Session
   before subsequent work. A repeated completion commits no second boundary.
6. Reopen admission only after the owners confirm the committed target is still current and usable.
   Native context continuity is retained: no Save, restore, resume or new Handoff occurs solely
   because Agora Session attribution changed.

The relevant effective conditions include harness artifacts, native context, model/effort,
capability meaning and effective grants, and any reconciled persona/skill versions. A new Intent
with no effective change creates no Session. A compiler revision with an identical meaning/output
is recorded as verification provenance rather than fabricating a new execution.

If a new Intent arrives mid-transition, already observed partial effects remain historical facts.
The old transition cannot admit work or complete a boundary for that obsolete target. Reconciliation
uses the latest complete Intent. If it restores the same effective conditions without intervening
work, no new Session is required. A controller crash leaves admission closed until the same live
context and actual conditions are verified again.

An inability to prove quiescence or context identity is an operational failure requiring the runtime
loss/recovery contract; no verb may silently convert a hot change into fresh-context work. Spontaneous
harness changes during a turn are recorded as observed discrepancies and close subsequent admission.
Agora never fabricates a historical model/authority boundary at an unknowable earlier instant.

## Context continuity across Session boundaries

The opening context descriptor records the originating Agora Session, Pod UID, process generation,
ACP context identifier, Save/origin, `W`, `H` and Handoff command if required. Later Sessions on that
same live context reference this descriptor and its fresh owner proof; they do not reset `W` to zero
or create another opening Handoff.

A descriptor is historical correlation. Fresh evidence of the same native context is still required.
A new Pod or context always gets a new descriptor and new Session. A reconnect that cannot prove
continuity remains gated until operation-specific recovery resolves the ambiguity.

## Fact boundary

The normative meanings of boundary facts are:

- Session opening: execution provenance and causal Intent for the concrete boundary;
- native context binding: the actual ACP context and its immutable opening descriptor;
- effective-conditions verification: what was read, with source identity and resolved versions;
- transition completion: the old/new Session attribution boundary and realized conditions;
- execution end or failed attempt: the observed reason and any unresolved effects;
- restore, Handoff and Save facts: their immutable references and outcomes.

Their wire/database schemas must be aligned separately with the canonical Workstream journal.
Operational claims and command delivery records are not Session lifecycle truth. Late frames retain
original request/connection causation. If a transport cannot distinguish old buffered frames across
an attribution boundary, it must drain/reconnect safely before new work; receipt time alone cannot
relabel them into the next Session.

## Off and recovery

An off Intent closes admission and runs controlled shutdown under ADR 0008. Shutdown facts belong to
the execution being stopped; there is no off Session. Recovery from Pod loss opens a new Session and
uses the selected harness's own compatible Anchor or an explicitly fresh context. A permanent native
restore failure never switches continuation mode inside the failed Session.

# Reconciliation engine contract

## Scope and invariants

This specification implements [ADR 0003](../../adr/0003-reconciliation-over-state.md). It owns work
discovery, claims, observation acquisition, effect ownership, retries and conditional finalization.
The [taxonomy](000_taxonomy.md) and ordered rule tables alone choose business objectives. Engine
control adds no Intent field, Observation value, result, verb or product runtime identity.

The required properties are:

- A committed complete Intent and every later drift wake remain discoverable until reconsidered.
- One Workstream has at most one currently authorized mutation owner; lease expiry alone cannot
  make an already dispatched external effect disappear.
- An obsolete worker cannot finalize newer work, reopen admission or make a late resource usable.
- A tick uses one selected Intent/catalogue resolution and current evidence for the same target.
- A rule-selected action ends that row's evaluation; only fresh evidence selects the next action.
- Unknown delivery, failed acquisition and exhausted retries never become fabricated convergence.

Operational ownership, attempts, pending cleanup and scheduling may be durable PostgreSQL records
under ADR 0005. They are not another Session journal or proof that a remote resource currently exists.

## Intent authoring and revision selection

Serialize authoring per Workstream using a database lock or equivalent serializable conditional
transaction. A request supplies a complete Intent and stable author/request key. Reusing that key
with the same content returns the original event; different content is a conflict. Distinct requests
receive increasing `intent_seq` values regardless of timestamps or concurrent arrival.

Validate the complete shape and authorized public selections. For an on Intent, validate model,
effort and required named authority against the trusted revision. Off authoring must not depend on
reachable runtime/OneCLI owners or successful validation of inapplicable execution against a newly
enabled catalogue; previously accepted retained selections can be carried in the complete off
Intent. Its schema and product authorization still apply.

In one transaction:

1. append the immutable Intent event with its next sequence;
2. upsert its Workstream work row with a fresh `work_generation`, make new work due and invalidate
   obsolete claims/admission authorizations;
3. emit the empty `NOTIFY` on `workstream_reconciliation`.

Prompt dispatch reservations and Session boundaries participate in the same Workstream ordering.
A command queued earlier is revalidated before dispatch; Intent authoring cannot race a permission
that remains indefinitely usable. A request already possibly sent is retained as an in-flight
obligation and is resolved under [prompt recovery](#prompt-delivery-and-context-creation), not retroactively called unsent.

The deployment selects an immutable compatible set of harness, capability, compiler and rendering
revisions. Workers do not choose from their local binaries. Each evaluation/attempt records its
resolved revisions and digest; retry never changes a payload under the same attempt key. Catalogue
publication durably records affected Workstreams and schedules bounded re-enqueue, including idle
ones. Mutation/admission checks reject an obsolete selected revision immediately; they do not wait
for the publication sweep to finish. An identical effective result needs provenance, not a new
Session. An incompatible result remains visible and unrealized until its owner changes the cause.

### Publication procedure

Publishing a reviewed revision is one transaction followed by bounded, resumable work.

**The transaction.** Record the new selection (one row: revision id and revision set) and open a
publication for it. The two commit together, and that commit is the moment the previous revision
becomes obsolete: from then on, a mutation or admission carrying the old revision id is rejected
immediately, at the check, without waiting for any sweep to reach its Workstream. Publishing the
same revision id twice discovers the existing publication instead of opening a second one, so a
retried operator request cannot double the work.

**Enumeration.** Walk the desired-state index — every Workstream, in id order — and record each as a
target of this publication. Not the workset: a Workstream with no work row is exactly the case a
workset scan misses, and an idle Workstream whose harness digest was re-pinned is exactly the case
that matters. Enumeration is paginated, and the cursor advances in the same transaction as the page
it describes, so an interrupted publication resumes at the last target actually written — never from
the start, never skipping a page.

**Re-enqueue.** Wake recorded targets in bounded batches, each with a fresh work generation. The
fresh generation is what makes the wake real: an in-flight claim under the previous generation can no
longer finalize over it. Publication authors no Intent and names no verb — it makes work due, and
the rule tables then read fresh evidence under the new revision and select whatever that implies.

**Resumption.** A publication that has not reached `complete` still owes wakes; a sweep resumes it.
Enumeration must finish before any re-enqueue begins: a publication that does not yet know its full
target list cannot claim to have woken it.

**Authority.** Publication is an operator action taken as a service actor, not a product user
action: it changes what every Workstream in the deployment is reconciled against.

## Work generations, claims and leases

The coalescing workset has at most one row per Workstream. It refers to the latest immutable Intent
requiring evaluation. A drift/resynchronization wake keeps that Intent sequence, allocates a fresh
work generation and emits a notification atomically. Neither generation nor claim token may be
reused after a row is removed and recreated; a monotonic allocator or unique token prevents ABA.

These operational correlations have different jobs:

| Correlation | Obligation |
|---|---|
| `intent_seq` | Orders complete desired-state events within a Workstream |
| `work_generation` | Prevents a pass from deleting any newer wake, including a wake for the same Intent |
| Claim token and lease | Select one worker for a bounded attempt; protect renewal/release/finalization |
| Mutation ownership epoch | Lets trusted effect owners reject obsolete requests across worker failover and work-row deletion |
| Attempt/command key | Binds one operation to immutable payload and concrete external targets |
| Pod UID/process/context and Agent ID | Prevent target reuse, stale readback and deletion by reused names |

Workers atomically claim due unclaimed/expired work in bounded batches. Renewal, release and due-time
updates compare the exact claim and work generation. Use database time for lease decisions; worker
clock skew cannot reclaim another owner's lease. Do not hold a database transaction open across a
network call. A lost/expired claim stops new worker dispatch and cannot be renewed by an old token.

Lease transfer issues a new ownership epoch, but first accounts for the old owner's dispatched or
possibly dispatched requests at every trusted boundary. The owner may continue observing or closing
unsafe access; it cannot start conflicting positive effects until old requests are settled/fenced.
Operational epoch/target retirement survives work-row finalization. Deleting a work row does not
revive old permits or erase pending external cleanup.

## Tick and acquisition

Notifications carry no Workstream id, Intent or action state. They prompt a scan of durable due
work, not one action per ping. Duplicate notifications may coalesce; polling and scheduled recovery
ticks discover work when listeners miss all notifications.

For each claimed row, load its complete Intent and selected revision, then evaluate from POWER.
Acquire fields as needed by the reached rules; inability to read ACP config cannot prevent POWER
from selecting an off cleanup. No later mutation or CONVERGED finalization may reuse an earlier
rule's evidence after a detected invalidation or target change.

Every acquisition reports non-secret source identity, target incarnation, observation time,
version/cursor where available, completeness and validity conditions. The
[Observation registry](002_observation.md) specifies each field's owners and normalization. A
failed or incomplete source read produces no invented empty set/default. POWER's existential on
proof is explicitly weaker than the exhaustive absence needed for off.

OneCLI attached/effective sets must describe the same Agent and a consistent source view; if the
owner supplies separate reads, bracket/revalidate source changes and retry inconsistent pairs.
Kubernetes, Broker and native reads must refer to the same incarnation. A stored diagnostic snapshot
or an action response is not the next tick's evidence. A continuously maintained config snapshot is
usable only with freshly verified stream continuity and current target under [ACP evidence](execution.md#acp-facts-and-current-evidence), not solely
because its timestamp is recent.

There is no atomic transaction across Kubernetes, OneCLI and a harness. The engine records the
scope/time of evidence, verifies dependencies again at mutation/admission boundaries, and closes
admission on expiry or observed invalidation. Owner-local enforcement and the epoch protocol below
protect effects. Out-of-band external edits have a bounded detection interval, not an invented
instantaneous global snapshot. Privileged maintenance of an Agora Agent closes its relay before
widening authority; ordinary changes go through the serialized owner path.

Historical input is restricted to immutable definitions named by the contracts: the current
Intent, selected revisions, Session/context origin, Handoff range/digest and Save/Anchor metadata.
These define targets or recovery material; none proves current process, grant, config or delivery.

## Effect ownership and late requests

Only trusted runtime control, Broker and ACP bridge boundaries may perform their respective
mutations. Workers submit constrained owner requests; they have no bypass credentials to Kubernetes,
OneCLI or an unguarded prompt transport. Each request carries its epoch, concrete/reserved target,
stable attempt key and payload digest. Reused keys with mismatched inputs are rejected.

A takeover references the existing reservation under the new current epoch and records both the
original dispatch owner and recovery owner. It preserves the attempt's immutable target/payload;
it does not resend a possibly accepted operation or revive the old permit merely because ownership
changed. Recovery authorization is distinct from authorizing another external dispatch.

Before an effect can be dispatched, its owner durably reserves it under the Workstream ordering and
checks current ownership, Intent/revision and operation preconditions. Reservation records the
possibility of remote acceptance before the network call. A target is not released for conflicting
work while that possibility remains unresolved. All replicas of the owner share this serialization;
an in-memory mutex or worker-side lease check is insufficient.

Changing Intent or ownership fences obsolete requests at these boundaries. Not-yet-dispatched work
is rejected. A request already in flight may still complete; its target stays gated and its effect
is discovered and settled before conflicting activation. Restriction/relay closure is prioritized
and need not wait for ACP or capture. Retiring a target forbids positive mutations or rebinding it
for future work, while concrete-target cleanup remains authorized.

Where the upstream supports conditional mutation/idempotency, the pinned integration uses and
tests it. Where it does not, the sole trusted writer must durably serialize target requests and
resolve possible acceptance before retry, release or conflicting activation. An old network request
can arrive after a newer local decision; reading the database just before sending is not a fence.
Failover of that writer must preserve its in-flight reservation and prevent an old process from
issuing another request. Unprovable failover leaves the target closed and the obligation unresolved.

The owner request protocol (contract: `contracts/schemas/owner-request.schema.json`): every owner
mutation is one envelope `{ epoch, workstream_id, attempt_key, operation, target: concrete | reserved, payload, payload_digest, revision_set }`,
answered by exactly one of `accepted | rejected_stale_epoch | rejected_key_mismatch | completed | unknown`.
`payload_digest` is the SHA-256 of the canonical JSON payload. Owners reject an `epoch` older than
the last epoch they accepted for the Workstream, reject a reused `attempt_key` carrying a different
digest, return the recorded result for a reused key with the same digest, and retain `unknown` when
their own downstream call did not settle. Positive operations are refused on retired targets;
concrete-target cleanup stays authorized.

For example, an old GRANT may become attached after a newer off Intent. The relay must already be
closed, and cleanup cannot declare the Agent absent/finalized until the grant request is definitively
settled and authority removed. An unknown Agent/Pod creation similarly keeps its reservation: an
empty inventory at one instant cannot license another create or off finalization while it can still
arrive. The resulting late resource is discoverable by its pre-recorded correlation and cannot be
activated. No OneCLI support for an Agora-specific epoch parameter is presumed.

This is an owner integration acceptance requirement. If the chosen API cannot discover unknown
creation or the deployment cannot fence old writers, that integration cannot promise automatic
recovery. It must retain explicit uncertainty and require owner remediation; retrying with a fresh
key or claiming successful cleanup is not an implementation option.

## Action recovery and result handling

A rule selects one verb and ends the row's evaluation. Its owner may verify preconditions and
complete/discover partial effects of that same objective. Attempt records can report errors or
unknown delivery for operations, but return no reconciliation value or Observation. They never
select a fallback verb. After the attempt ends, release/reschedule conditionally and emit the empty
continuation notification. The next eligible evaluation restarts at POWER.

Recover a crashed attempt before allowing a duplicate or conflicting action. This does not require
running its obsolete desired effect to completion: an old target can be fenced and cleaned while
the latest Intent remains authoritative. A currently selected TURN_OFF may close reachable paths
despite an unresolved older positive request; it must retain that request's cleanup obligation.
The [prompt contract](#prompt-delivery-and-context-creation) defines ACP new/resume/prompt ambiguity.

- `PASS` continues within this tick with valid prerequisite evidence.
- `ACTION(verb)` executes at most that one selected objective, then schedules reevaluation.
- `HOLD` changes nothing and leaves the row active, tied to a watched owner and a bounded due time.
  Its lack of immediate successor notification does not mean sleeping forever.
- `CONVERGED` requests conditional finalization; it does not itself authorize work forever.

Attempt completion alone changes neither `intent_seq` nor `work_generation`. Due time, retry metadata
and lease release are conditional operational updates, so an old completion cannot postpone a new
Intent or overwrite its claim. An independently observed resource change is an external wake and
can legitimately advance the generation even when that resource changed because of Agora's action.

## Prompt delivery and context creation

The baseline assumes no universal ACP prompt idempotency guarantee. The control plane commits the
command and exact target before dispatch; the bridge durably records that dispatch may occur before
sending. Transport acceptance is distinguished from harness acceptance, turn completion and native
incorporation. A crash in an uncertain interval yields an unresolved attempt, not a safe resend.

Recovery first reconnects to the same verified Pod/process/context and seeks operation-specific
evidence. A proven never-sent or definitively rejected-before-acceptance attempt may dispatch the
same command. Possible acceptance without decisive evidence remains `prompt_delivery_unknown`,
visible to the user, with that context's next turn gated. A URI occurrence, lost response or elapsed
time cannot prove that no external side effect occurred.

A user-requested retry is a new command explicitly linked to the ambiguous predecessor and exposes
the possibility of duplicated external effects. It is admitted only after the previous context/turn
has been resolved or extinguished; a new key alone is not permission to run concurrently. Neither
custom ACP metadata nor a product command ID is assumed to deduplicate harness/provider operations.

An opening Handoff follows the same contract. Its immutable range and digest can be rebuilt, but
that is not permission to resend after possible acceptance. `observation.sync` is unavailable while
native incorporation/absence is unresolved. Only verified incorporation passes SYNC. A clean
replacement has a new Session/context delivery scope; earlier remote effects can still be unknown.

ACP new/resume follows the same acceptance distinction: discover and bind the actual context, or
retain the unresolved reservation. A reconnect is not evidence that no context was created. Never
open a second context after possible acceptance merely because the response was lost.

A delayed session-scoped cancel must not interrupt a later turn. Repeat cancellation only after
verifying the intended context and active turn; completion requires the execution contract's stronger
quiescence evidence. Late exchanges and effects retain their original Session attribution.

Verified permanent restore incompatibility follows [clean fallback](continuity.md#compatibility-restore-and-fallback).
Unknown acceptance or temporary owner failure cannot invalidate a Save or select a different verb.
Other operation-specific repetition and postconditions belong to the [verb contracts](003_verbs.md)
and [capture/publication contract](continuity.md), not an alternative engine decision tree.

## Retry budgets and fairness

Acquisition errors, claim loss and unresolved acceptance are engine control, not extra domain HOLD
rows. They leave durable work due for an appropriate owner watch or bounded recheck. Persist the
original operation/startup/shutdown deadline and cumulative attempt budget across restarts.

Backoff has a configured cap and jitter. Notifications do not make work eligible before its due
time. New Intent or a materially changed source/revision can reset the relevant blocking cause;
repeated notification alone cannot. Exhausted or permanent failures remain unrealized with typed
remediation and a bounded diagnostic recheck, without repeatedly invoking an unchanged action.
An unrelated failing Workstream cannot monopolize a scan or starve other due rows.

Deployment settings must pin claim duration/renewal, owner/evidence expiry, action deadlines, retry
caps and resynchronization bounds before acceptance. The conformance suite uses a controllable clock
to prove these bounds; prose does not imply that current defaults satisfy them. Security closure
and the fixed preservation budget cannot be extended by ordinary action backoff.

Every timing and budget this section leaves open is pinned in
`contracts/catalogue/runtime-settings.json`, with one line of rationale each, and read through one
typed loader that carries no defaults: a value that can silently fall back to something in code is a
value nobody has decided. `packages/engine/test/settings.test.ts` proves the pinned set is coherent
and proves each coherence rule by falsifying it — a backoff that could exceed its cap, a lease that
could be reclaimed under a live worker, a capture budget that could consume the whole shutdown
window, a proof older than the tick reading it.

## Watches and recovery sweeps

Every fact that can invalidate convergence has both a wake source and a bounded recovery path:

| Source | Wake and missed-event recovery |
|---|---|
| New complete Intent | Transactional work upsert/NOTIFY; polling discovers the committed row |
| Kubernetes/runtime inventory | Pod/process/retirement changes; resumable watch plus relist after loss and bounded reconciliation sweep |
| OneCLI/Broker | Attached/effective grants, Agent/binding/credential availability and pending mutations; owner events or polling, with exhaustive inventory rescan |
| Harness/ACP | Connection/context loss, option changes and native continuity invalidation; supervised connection plus declared health/continuity revalidation |
| Save/Anchor metadata | Commit, publication or verified incompatibility/invalidation; durable change notice plus metadata sweep |
| Registry/compiler policy | Durable publication list and bounded enumeration of affected Workstreams, including those absent from the workset |
| Attempts/commands | Completion, unknown-delivery resolution or deadline; durable due records survive caller crashes |

Watches are live-source mechanisms, never a lookup of the latest Session fact. Lost cursors or
listener reconnects require relist/revalidation. A missed event after work-row finalization must
still re-enqueue: sweeping only active work rows is insufficient. Owners retain exhaustive
Workstream attribution for orphans and in-flight creations; recovery enumerates affected live
resources and a bounded paginated desired-state index. It need not replay all historical Intents.

## Conditional finalization and admission

Finalization serializes with Intent authoring, drift re-enqueue, claim transfer and admission. It
checks exact Intent sequence, work generation, current claim/epoch, selected revision, target
identity and valid prerequisite evidence. It also requires that no pending owner request could
invalidate the conclusion. In particular, observed absence cannot finalize off while an unknown
creation can still arrive. A mismatch retains the newer obligation and starts no old-generation work.

For POWER's off convergence, all footprint and retirement inventories must be empty; no Session or
admission is opened. For terminal on convergence, conditionally complete the idempotent attribution
boundary from [execution](execution.md#hot-session-boundaries) and enable only its current target. Admission owners validate that committed
boundary and their current local conditions before accepting a prompt/route; a database commit
alone does not reopen an obsolete transport.

The work row can then be removed or conditionally marked no longer pending. Its absence is not a
durable assertion of readiness. Per-dispatch validation, evidence expiry, watches and recovery
sweeps continue for live resources. A subsequent change creates a fresh work generation.

Acceptance interleavings are in [the scenario catalogue](acceptance.md). This contract requires
aligned SQL/API constraints and owner conformance before implementation acceptance; it neither
introduces a lifecycle state machine nor asserts that existing code already provides these guarantees.

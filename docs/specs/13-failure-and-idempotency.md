# Failure model and idempotency

## Principles and attempt records

Durable Intent or a durable command precedes its external effects. Reconciliation coalesces desired
state by Workstream; commands for which each occurrence matters, including user prompts and
Handoffs, retain their own identities. Coalescing one cannot discard the other.

An operational attempt binds a stable key to Workstream, selected verb/command, Intent and catalogue
revision, ownership epoch, concrete target incarnation and immutable payload digest. Reusing the
key with another target or payload is a conflict. The owner records dispatch possibility, known
partial effects, deadlines and unresolved remote completion across crashes. These are recovery
records, not a Session lifecycle or an Observation of present reality.

A timeout does not prove non-acceptance. A successful response does not become a future Observation.
Before any retry, reconcile the same target through its owner and validate current ownership and
preconditions. The engine cannot translate a failed verb into a different business verb; fresh
registered observations and ordered rules select the next objective.

## Retry contracts

| Operation | Safe repetition and ambiguity resolution |
|---|---|
| Append complete Intent | Same author/request key and payload returns the original immutable event; new requests serialize by Workstream |
| Open Agora Session | Unique birth per Pod UID, or unique verified hot-boundary key; retry cannot duplicate the Session/cutoff |
| Create Pod/envelope | Same creation attempt and reserved target; discover external creation before another build |
| Create OneCLI Agent/binding | Same Pod-bound creation correlation; inventory discovers partial/orphaned results before retry |
| Attach or revoke grants | Reread exact attached/effective rights on the same Agent; converge the still-authorized payload without widening defaults |
| Change model/effort | Fresh current-context readback; revalidate the model/options and still-current target before repeating |
| ACP initialize | Connection-scoped negotiation; reconnect does not imply a new native context |
| ACP new/resume | After possible acceptance, discover/bind the actual context or remain unresolved; never blindly open another |
| ACP prompt, including Handoff | Never automatically resend after possible acceptance; apply the prompt contract below |
| ACP cancel | Repeat only for the intended active target/turn; do not let a delayed session-scoped cancel interrupt a later turn |
| Place Save bytes | Same Save and target attempt, clean/verified placement under the driver contract before ACP launch |
| Capture Save | Same capture key yields one immutable committed Save; a partial stream is not reusable recovery material |
| Publish Anchor | Conditional expected-Anchor/provenance/frontier transaction; an older/equal-watermark capture cannot replace a newer publication |
| Terminate Pod | Delete the concrete UID, never a replacement with a reused name; verify physical retirement separately |
| Remove Agent/binding | Same concrete incarnation, complete partial removal and verify absence; do not operate on a rebound Workstream alias |
| Journal/projector apply | Stable fact identity and canonical Workstream sequence; replay never duplicates product facts |
| Emit reconciliation tick | Duplicate or missing notifications do not lose durable work; due work is rediscovered |

No operation is universally safe merely because its HTTP method or ACP method appears repeatable.
Pinned owner integrations must demonstrate the indicated discovery, deduplication and fencing.

## Prompt delivery ambiguity

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

## Restore failure and clean fallback

A verified permanent format, checksum or native-resume incompatibility is recorded against the
artifact or exact Save/driver target under spec 07. The failed execution is retired and its native
state is not eligible for capture/Anchor publication. Fresh owner evidence makes it unusable, so
the domain rules select `TURN_OFF`. After verified cleanup, a still-on Intent can build a new Pod,
open a new Session and choose fresh start because the unusable recovery pair is excluded.

Unavailable storage, permission/configuration errors and lost responses are typed separately; they
do not establish corruption. An unknown new/resume attempt stays bound to its reserved target.
Runtime control may fence and retire an unrecoverable launch attempt within its original launch
budget; it must still discover/stop any possibly opened context before replacement can perform work.
There is no silent restore-to-start switch inside an attempted Session.

## Crash and race scenarios

| Interruption | Required recovery |
|---|---|
| Intent commits but notification is lost | Durable due work is rediscovered and the latest complete Intent evaluated |
| Worker loses claim during an external request | The old response cannot finalize work or reopen admission; the trusted owner settles/fences the old request before conflicting mutation |
| Pod exists but Session bootstrap has not committed | Keep the Pod gated and complete its same idempotent Session birth/cutoff before work |
| BUILD creates only part of its envelope | Discover the same attempt; after it ends, fresh incomplete construction selects cleanup, never an undocumented repair action |
| Broker creates Agent then crashes before linking Pod | Recover by the pre-recorded creation correlation and exhaustive Workstream inventory; no second untracked Agent |
| Grant request arrives after a newer off Intent | Owner admission rejects obsolete work or keeps its in-flight target fenced until the late effect is removed |
| Config changes then worker crashes | Recover actual config and the same quiescent boundary; no old-generation admission or duplicated successor Session |
| Prompt may be accepted before local acknowledgement | Recover the same turn or retain explicit ambiguity; no blind resend |
| Pod or native process dies without a Save | Keep old Anchor; new Pod means new Session and compatible restore/refill or explicit cross-seed |
| Save commits before Anchor publication crashes | Discover immutable Save and conditionally publish only with valid capture provenance and expected Anchor |
| Anchor commits before termination crashes | Preserve committed Anchor; continue target cleanup without recapturing or resetting the shutdown deadline |
| Capture never finishes | Cancel/abandon capture at the fixed deadline, retain old Anchor and proceed with termination |
| Pod API object disappears on a partitioned node | Keep retirement obligation; revoke authority independently and block successor work until physical execution is fenced |
| OneCLI or Kubernetes is unavailable during off | Progress cleanup through reachable owners; report unresolved remainder and never manufacture empty inventories |
| Relay is unavailable or binding evidence expires | No alternate provider path or credential injection; access remains closed until the owner verifies the current target |
| OneCLI credential/trust state cannot be restored | Keep access closed and require the responsible owner to restore/rotate compatible state; never remount secrets into Pods |
| Projection lags or crashes | Replay canonical facts; expose incomplete projection and do not render a Handoff from an unproved cutoff |

## Deadlines, errors and scheduling

Every operation declares a timeout, cumulative retry budget and external-owner diagnostic category:
acquisition unavailable/inconsistent, stale ownership, incompatible integration, denied authority,
launch/context failure, prompt ambiguity, Save integrity/size/capture failure, or incomplete
extinction. Exact wire error names and values belong in aligned machine-readable contracts.

Deadlines survive restarts. Backoff uses bounded delay and jitter; notifications cannot bypass a
retry budget or turn an unchanged permanent incompatibility into an immediate action loop. A
resource/Intent/catalogue change can invalidate the blocking cause and request fresh evaluation.
An exhausted budget retains the unrealized work and exposes its cause; it is not `CONVERGED`.

`HOLD` is selected only by domain rows for a valid observed condition awaiting its owner.
Acquisition failure, unknown acceptance and claim loss are engine control, not additional HOLD rows
or alternate domain state. Each remains discoverable with a wake source or scheduled bounded
recheck. Shutdown restrictions are never suspended by an ACP or Save retry budget.

Operational diagnostics may persist attempts and errors. Product facts retain execution outcomes
in their original Session, including late frames from interrupted work. Recovery cannot erase,
relabel or invent history to make an attempt appear successful. The scenarios in spec 15 are design
acceptance obligations, not claims that existing code or schemas already implement this behavior.

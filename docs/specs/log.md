# The log

Contract to implement — PostgreSQL **17** (CloudNativePG), ACP protocol version **1**, schema of
`@agentclientprotocol/sdk` **1.5.1**. How it fits together is explained in `architecture/log.md`;
why, in the log ADR.

**Every command and every ACP line is written whole, at its Workstream's next position, before
Agora acts on it. The client only ever reads what is projected from it.**

## Entries

| Kind | Written when | Content |
| --- | --- | --- |
| `command` | A user command is accepted. | Its id, actor, kind and body. |
| `acp` | An ACP line is about to be sent to the bridge, or has been received from it. | The line, whole. |
| `acp.dispatching` | The dispatcher commits to making an outgoing line's first transport write. | The outgoing entry's position, connection and bridge instance. |
| `acp.sent` | That transport write's callback succeeds. | The outgoing entry's position and connection. This proves a local write, not harness acceptance. |
| `request.failed` | A correlated request fails locally: invalid answer, transport error or response timeout. | Its outgoing entry's position, a closed reason, and the diagnostic id when there is one. Never the invalid content or an exception message. |
| `execution.obtained` | A claim is returned or found for an accepted Create. | Its name and UID, bound to the Create and its execution. |
| `execution.failed` | Startup or restoration cannot complete. | A closed reason and the relevant command or request position. |
| `anchor.received` | An authenticated anchor has been committed to storage. | Its id, execution and Session; never its bytes. |
| `session.opened` | `session/new`, `session/load` or `session/resume` is answered without error. | The ACP session id, the execution, the pool, the harness, and its origin: new, or the anchor restored. |
| `session.ended` | The execution is lost or ended, or another ACP session replaces this one. | The reason. |
| `execution.connected` | Agora opens a connection to the bridge. | The connection, the bridge instance. |
| `execution.break` | A connection to the bridge closes, after the received lines have been committed. After a restart, a connection left without a break gets one, not clean, before any new dispatch. | The connection, the close code when known, clean or not. |
| `execution.lost` | The adapter died, or the bridge instance changed. | The reason. |
| `execution.ended` | The claim has disappeared. | The anchor received, or why there is none. |

| Rule | Detail |
| --- | --- |
| Position | Each entry takes its Workstream's next position, allocated under a lock on the Workstream in the transaction that writes it. Positions are consecutive. |
| Admission | Deduplication, the admission check and its entries commit under that same lock. The check reads canonical entries and their synchronous indexes, never a lagging client view. |
| Attribution | Every entry names its Workstream; execution and Session entries name their execution. Requests, replies and dispatch markers retain their original Session, even if it has ended, except the successful answer opening a new Session, which belongs to that Session. Other entries name the Session open when their event occurred. |
| Time | The time an entry is written is recorded. It never orders anything. |
| Immutable | An entry is never updated or deleted. |
| Kinds | Closed: a kind is added to the table above before any code writes it. |

## ACP lines

| Rule | Detail |
| --- | --- |
| A line | One JSON value in UTF-8: one WebSocket text message from or to the bridge, at most 16 MiB. |
| Stored as | Bind the original text as `jsonb`, without a JavaScript parse/serialize round trip. Preserve unknown members, array order and exact semantic numbers, including `9007199254740993`. `jsonb` may change whitespace, object member order and numeric notation; identical transport text is not promised. Read back as text (`::text`) and parse losslessly wherever exact values matter. |
| Beside it | Direction (`out`, `in`), JSON-RPC kind (request, response, error, notification), method, the method of the request a response answers, JSON-RPC id, the command that caused it, the connection that carried it. They index the line; they are not a second copy. |
| Outgoing | Written, then dispatched. If the entry or `acp.dispatching` write fails, nothing is sent. The ACP entry means "scheduled for sending"; only a committed dispatch marker permits its first transport write. |
| Incoming | Written, then handled (turns, deadline) and projected. The entry means "received". |
| Order | Both directions share the Workstream's positions; within a direction, the order of the connection. |
| Database unavailable | Retain the received line whose commit failed and pause the connection. Send nothing, refuse new commands and perform no deadline renewal until storage returns. Previously granted deadlines still apply. |
| Ids | Agora's own requests carry `agora-<execution-id>-<position>` string ids, derived from their outgoing entry's position. Allocate the position and construct the line in one transaction. Ids survive restarts and are never reused in that execution. |
| Correlation | Resolve responses against requests from the opposite direction in the same execution, with the exact string or safe integer id. Reconnection does not clear pending requests. Receipt time never changes their Session or command attribution. |

### Validation

Each line is checked against the pinned schema: its JSON-RPC envelope, kind, direction and
method. For a response, use the method of the request it answers. Validation does not rewrite
the stored text; numeric id bounds are checked losslessly before conversion to a JavaScript
number. The schema's `x-side` names the side serving the method, not the response's direction.

| JSON-RPC kind | `agent` | `client` | `both`, `protocol` |
| --- | --- | --- | --- |
| Request or notification | out | in | Either direction |
| Response or error | in | out | Opposite direction to the correlated request |

Validate request and notification `params`, successful response `result`, and error envelopes
separately. An error does not need a successful result body. An uncorrelated response may be
stored if its envelope is valid, with no correlated method; it completes no pending request.

| Line | Verdict |
| --- | --- |
| A known method, in its direction, with a matching body | Valid. |
| A method the schema does not know | Valid as an extension only after envelope validation. |
| A `session/update` whose type the schema does not know | Valid as an extension only with a valid outer notification, Session id and string discriminator. |
| A known method in the wrong direction, or with a body that does not match | Invalid. |
| A batch (a JSON array) | Invalid. |
| A numeric id beyond ±(2⁵³ − 1) | Invalid. |
| Not UTF-8, not JSON, or more than one value | Invalid. |
| Duplicate object keys, `\u0000`, or numbers outside PostgreSQL's `numeric` range | Refused as an unsupported JSON value; never silently changed to fit storage. |

An invalid line is never an `acp` entry and is never forwarded or semantically handled. Its
diagnostic holds execution, connection, direction, reason, size and SHA-256, never content.
If an invalid incoming answer can be correlated safely, commit the diagnostic and
`request.failed` together before notifying the waiter. The failure is then reproducible from
entries alone. Retain that request's correlation so a later valid answer can still resolve its
turn. If correlation is unsafe, fail no request by guessing.

Reasons are closed: `invalid_utf8`, `invalid_json`, `invalid_envelope`, `batch`, `wrong_direction`,
`invalid_body`, `unsafe_id`, `line_too_large`, `unsupported_json_value`, `transport_error`,
`response_timeout`, `deadline_refused`, `startup_failed`, `restore_failed`, `claim_conflict`, `claim_missing`,
`adapter_exited`, `instance_changed`, `deadline_reached`, `stopped`, `replaced`, `anchor_missing`.
No parser, database or transport exception message becomes a reason.

### Dispatch and recovery

One serialized dispatcher drives a Workstream. Command acceptance and the start of each external
effect share its ordering, including outgoing lines, cancellation, deadline renewal and Stop;
allocating positions alone does not authorize concurrent transport writers. A second
server must not drive the same execution. Exclusive ownership across overlapping processes is
an implementation acceptance requirement, including failover and rolling restarts.

| Evidence | Permitted recovery |
| --- | --- |
| An outgoing entry without `acp.dispatching` or `request.failed` | Proven never attempted. Its first dispatch may proceed after rechecking the target, admission and Stop. |
| `request.failed` before any dispatch marker | Proven never attempted and locally failed. No later dispatch of that entry; a new user command is needed. |
| `acp.dispatching`, with or without `acp.sent`, without a valid answer | Possibly accepted by the harness. Reconnect to the same instance and await the same request; never resend a prompt, `initialize`, or session creation/resume. |
| A valid correlated answer | Handle its recorded outcome once; no dispatch retry. |
| A local `request.failed` after dispatch | Report the local failure. It proves neither harness rejection nor completion. Keep affected prompt admission closed. |

Commit `acp.dispatching` before calling the transport, then `acp.sent` after its callback succeeds.
If Agora dies between either step, the marker remains evidence of possible dispatch. A callback
error records `request.failed`; it is not proof that no bytes reached the harness. A callback
success does not prove the adapter read the line. Neither event downgrades a recorded answer.

Saved lines retain their original target and id. A Stop prevents their dispatch. Pending
`initialize` and session creation/resume keep their original correlation after restart; a
timeout records a local failure and startup error, never a second context-creation attempt.

### Backpressure and clean shutdown

Per execution, process incoming lines serially and pause the WebSocket while each line is
validated and committed. Keep at most one complete uncommitted line (16 MiB) and one bounded
transport frame (16 MiB): the aggregate pending receive budget is 32 MiB. Enforce this bound
before accepting more bytes, including messages already buffered by the WebSocket library.
No received line is released before its commit succeeds. Retry the retained line before later
lines, with the same connection attribution; resolve an ambiguous commit by its stable receive
identity (connection and receive ordinal), never by payload equality.

If the transport cannot maintain the bound, fail the connection and record an unclean break,
without claiming that all output was captured. If storage is still unavailable, retain that
bounded incident metadata until it can be committed; a restart treats an unclosed connection
as unclean. Recovery can continue a paused turn only while the execution survives; expiry,
adapter death or lost transport exposes the interruption instead of promising lossless output.

A graceful shutdown closes command admission and new dispatch, settles pending send callbacks,
then starts the WebSocket close handshake while continuing to commit received lines. Within
5 seconds of starting shutdown, the peer must complete a normal close, every received line must
be committed, and every dispatch begun on that connection must have its `acp.sent` or a recorded answer. Only
then write a clean `execution.break` and leave. A timeout, failed commit or unresolved write
makes it unclean; inability to write the break leaves it unclosed for recovery. A clean flag
proves this local drain, not harness acceptance. A saved line stays saved across a clean stop.

## Sessions

| Rule | Detail |
| --- | --- |
| Opening | `session.opened` is written in the same transaction as the answer that creates or resumes the ACP session. The Session gets an Agora id; the ACP session id is recorded, never used as its identity. |
| Restoring | A restore from an anchor opens a new Session, even with the same ACP session id. |
| Changing the model | `session/set_config_option` is an ACP line like any other: the Session goes on. |
| Another ACP session in the same execution | Ends the current Session and opens another. |
| Opening requests | `initialize` and session creation/resume requests are attributed to the execution only; the successful opening answer belongs to the new Session. |
| Reconnecting | To the same bridge instance, the Session goes on; to another instance, the execution is lost. |

## Commands

The commands are the interface's: Create, Write, Cancel, Respond to a permission, Stop
(`assistant-ui.md`).

| Rule | Detail |
| --- | --- |
| Identity | Each command carries an id chosen by the interface, unique in its Workstream. Compare kind, target and body using a deterministic JSON encoding: object key order is ignored, array order and values are preserved. The same id and request returns the first answer and writes nothing; a different request is refused. |
| Accepted | The command, its immutable accepted answer and its deduplication row commit together before any effect. For Write and Respond to a permission, the outgoing ACP entry commits in that transaction too. A refused command is answered with its reason and not written. A later operational failure is read in the thread; it does not replace the accepted answer. |
| Create | Carries the reviewed pool, execution settings and anchor to restore, if any. In the acceptance transaction, bind a globally unique execution id, use it as the claim request id, and record the claim name and initial absolute deadline. Claim names are unique across accepted Creates; a hash collision is refused before creation. The same command id in another Workstream cannot select the same execution. |
| Write | Accepted only if the execution is ready, sending is open, and no turn is saved, in progress or uncertain. The command, then its `session/prompt` line, are written before the line is sent. |
| Cancel | Carries the target turn id. Immediately before dispatch, recheck that exact turn and Session under the serialized dispatcher. Send `session/cancel` only while it is in progress or uncertain; otherwise, no effect. Cancelled permission outcomes for its pending requests precede any next prompt. A queued or recovered cancellation never reaches another turn. |
| Respond to a permission | Carries the Session, RPC id and request source position. Accepted while that exact request is pending; the answer is an outgoing ACP line. Reused harness ids cannot redirect an old answer to a new permission occurrence. |
| Stop | Accepted while the execution exists (`executions.md`). Commit it before closing admission, cancelling the active turn or stopping renewal. It prevents later dispatch and renewal even after restart. |

### A turn's states

| State | What the log holds |
| --- | --- |
| saved | The Write command and its `session/prompt` line, without `acp.dispatching` or `request.failed`: no transport write attempted. |
| in progress | `acp.dispatching`, with no valid answer, local failure or unclean break since dispatch. Dispatch has begun; harness acceptance is not proved. |
| done | Its answer, with a `stopReason` other than `cancelled`. |
| cancelled | Its answer, with `stopReason` `cancelled`. |
| failed | A valid error answer, `request.failed` before any dispatch, or the execution lost/ended before its valid answer, with the failure/interruption reason. |
| uncertain | Dispatch began and no valid answer is recorded; an unclean break or local `request.failed` prevents observing completion. An invalid answer is a local failure, not a terminal harness answer. |

An uncertain turn is never resent. It changes state only on proof: its valid answer —
`cancelled` once a Cancel reaches a turn still running — or the loss/end of the execution.
An invalid answer shows a failure notice and keeps the turn uncertain, with Write blocked.
Late valid answers may resolve uncertainty; an execution already ended is not reopened.

## Views

The client's objects — Workstream, turn, element, notice — are projections of the entries. Their
folds from ACP are those of `assistant-ui.md` ("Blocks of a response"); a line no fold
understands becomes a generic element.

| Object | Identity: name-based UUID of |
| --- | --- |
| Turn | The Session and the `session/prompt` request id. |
| Tool, with its permission | The Session and the tool call id. |
| Text, reasoning | The turn and the rank of the run of consecutive chunks. |
| Plan | The turn. |
| Notice | The Workstream and the position of the entry it comes from. |
| Generic element | The Workstream and the position of the line. |

| Rule | Detail |
| --- | --- |
| Deterministic | A fold reads entries in position order and nothing else: the same entries give the same views. |
| Failures | Fold `request.failed` and lifecycle entries just like ACP entries. Do not read diagnostic rows, current clocks or live executions to invent view state. |
| Version | Each projector has a version. A checkpoint records, per projector and Workstream, the version and the last position folded; a checkpoint from another version counts as none, and the projector rebuilds from the first entry. |
| Same transaction | Views, their thread changes and their checkpoint are written together, under one projector lock per Workstream. |
| Rebuild | For the same projector version and source position, gives the same identities and rows as the incremental run. Hash a canonical encoding of the rows sorted by kind and id; exclude no product field. Build replacement rows separately and publish them atomically, removing obsolete objects. A version change may deliberately change rows. |
| Publication | Projectors contributing to the thread publish through a common source position. At rebuild publication, serialize with incremental writes, catch up through that position and reset with the complete state of every client object, including unchanged objects owned by other projectors. |

### The thread

What the client reads (`assistant-ui.md`, "A workstream's thread").

| Rule | Detail |
| --- | --- |
| Update | Each change to a view appends an update to the Workstream's thread: its position, the operation (`upsert` with the whole object, or `remove`), the object's kind and id. |
| Positions | Allocated under the Workstream's thread lock, strictly increasing and never reused. A rebuild atomically appends `reset`, then every replacement object; it never truncates the thread. |
| Reading | From cursor C, read a consistent database snapshot with thread high-water mark H. Send the latest state or removal for each object changed in (C, H], ordered by its last change position, then a snapshot-end marker carrying H. Tail only positions greater than H. Read durable rows after each wake-up; notifications alone are not delivery. |
| Reset | If (C, H] contains `reset`, send the latest reset and the complete state at H. The client clears its objects before applying that state. No object from an earlier projector version survives the reset. |
| Cursor | Apply snapshot objects without advancing C; advance to H only after snapshot-end. Thereafter apply and checkpoint each live position together. Reopening may redeliver an incomplete snapshot; whole-object replacement, removals and reset make it idempotent. Reuse a cursor only with its corresponding object state; an empty browser starts at zero. No change is skipped or applied twice in the resulting state. |
| Invalid cursor | A negative cursor or one beyond the current high-water mark is refused. Zero requests a complete initial snapshot. |

## An execution's memory

What a restarted Agora reads to take each execution back:

| Needed | From |
| --- | --- |
| Which executions require recovery | Accepted Create entries without a terminal execution entry, joined with the claims Agora manages (`app.kubernetes.io/managed-by=agora`). Include Creates whose claim does not exist yet. |
| Request id, claim name, initial deadline, pool, settings, anchor to restore | The Create command and `execution.obtained` for its claim UID. |
| Bridge instance | The last `execution.connected`. |
| The agent's capabilities, or initialization still pending | The answer to Agora's `initialize`, or its original outgoing line and dispatch markers. |
| Session | The last `session.opened` not ended. |
| Turn, delivery and its start | The unresolved `session/prompt`, its dispatch markers, failures and connection breaks; its entry time bounds the turn deadline. |
| Idle since | The time of the last answer to a `session/prompt`. |
| Stop | The Stop command. |
| Received anchors not yet published in the log | Stored anchor metadata without `anchor.received`; append the missing entry before exposing the anchor. |

Every execution belongs to a Workstream; the lab creates it before its first execution.
Restoring another execution into that Workstream retains its ordered history. The claim carries
only its pool, its deadline and its labels (`executions.md`), including the recorded execution
id in `agora.bretagne.dev/execution-id`. That correlation label is not recovery state.

Recovery first accounts for every accepted Create and unmatched connection. If the claim was
never obtained, query its recorded name: verify its managed-by, execution-id and pool labels
before binding a matching claim by `execution.obtained`; a
confirmed absence before the recorded initial deadline permits the same Create request with
the same name, pool and deadline. An unavailable lookup permits no creation. Once a UID was
obtained, disappearance ends the execution; it never authorizes recreating its claim. A
different UID or incompatible claim is a conflict, with no mutation of that resource. If the
initial deadline has passed before a claim was obtained, record startup failure rather than
create a fresh lease. These checks do not prove physical extinction for a replacement.

Then restore request correlations, Session attribution and Stop before connecting. Persist an
unclean break for each connection without a completed drain. Reuse the initialization answer
for the same instance, or await its original pending request; never send a second initialization
after possible dispatch. A turn with dispatch recorded becomes uncertain after an unclean
break; one with no dispatch stays saved. No recovery path invents a successful send or answer.

## Storage

The mounted driver holds a database advisory lock on a dedicated writer connection. A second
driver is refused. Losing ownership stops sends and closes its bridges; restart reconstructs
the resulting gaps. Per-Workstream queues serialize effects; the marker transaction rechecks
canonical cancellation and permission targets. This does not prove physical extinction.

| Table | Key | Holds |
| --- | --- | --- |
| `workstreams` | id | Owner, last entry position and last thread position. The displayed title belongs to the Workstream object in `objects`. |
| `entries` | Workstream, position | Kind, execution, Session, content (`jsonb`), the ACP columns, time. Incoming ACP occurrences also have a unique (connection, receive ordinal). |
| `commands` | Workstream, command id | Kind, target, SHA-256 of the encoded request, immutable accepted answer, position of its entry. |
| `sessions` | id | Workstream, execution, ACP session id, positions where it opened and ended. |
| `diagnostics` | id | Execution, connection, direction, closed reason, size, SHA-256, time. |
| `anchors` | id | Execution, Session, harness, pool, format, files, content (`bytea`). |
| `objects` | Workstream, kind, object id | Workstream views, turns, elements and notices; owning projector, object, first and last position folded. |
| `thread` | Workstream, position | Operation, object kind and id, the object. |
| `checkpoints` | Projector, Workstream | Version, last position folded. |

| Role | May | May not |
| --- | --- | --- |
| `agora_writer` | Read Workstream identity/owner/last entry position, canonical entries, commands, Sessions, diagnostics and anchor metadata; insert Workstreams, entries, commands, Sessions and diagnostics; update only Workstream last entry position and Session end position. | Update/delete entries or commands; read anchor bytes; write anchors, client views, the thread or checkpoints. |
| `agora_projector` | Read Workstream identity/owner/last thread position, entries, views, thread and checkpoints; insert/update/delete views and checkpoints, append thread rows, update only Workstream last thread position. | Write canonical entries, commands or Sessions; read/write anchors; update/delete thread rows. |
| `agora_anchors` | Read execution/Session correlation columns; read and insert authenticated anchors, including bytes. | Write entries, commands, Sessions, views or checkpoints; update/delete anchors. |

| Rule | Detail |
| --- | --- |
| Connections | Every boundary role is NOLOGIN; the server connects with a separate restricted login per role. Runtime logins own no table and inherit no migration/superuser privileges. Schema changes use a separate migration login. |
| Encoding | The database uses UTF-8. Reject unsupported JSON values at validation, before their attempted insert; a transient storage failure remains backpressure, not invalid ACP. |
| Grants | Enumerate SELECT, INSERT and UPDATE columns. The writer can lock a Workstream through UPDATE on last entry position; the projector through UPDATE on last thread position. Session closing can update only end position, and cannot change identity or attribution. |
| Role creation | Cluster-global role creation must tolerate both duplicate-object and unique-violation races. Concurrent migrations in separate databases must succeed without widening existing roles. |
| `bigint` | Keep PostgreSQL `bigint` as decimal strings in the driver; register the parser once for every connection. Position arithmetic and comparison use JavaScript `bigint`. Thread cursors travel as decimal strings and are compared losslessly by the client. No unchecked conversion to `number`. |
| Anchors | The anchor role commits metadata and opaque bytes together. The writer then appends `anchor.received` before acknowledging/exposing it. A crash between commits leaves recoverable unpublished metadata; repeated publication of the same anchor id writes no second entry. |
| Tests | Application operations run through the actual restricted logins, never as a superuser or table owner. Provisioning alone uses the migration/admin login; each run has its own database. Size each test pool above the maximum clients held concurrently by its tests, and release them on failure. |

### Operational logs

Operational logs are separate from the product journal. The logger accepts only a closed
allow-list: actor id, Workstream id, Session id, execution id, connection id, command id,
source position, operation, outcome, error class, byte count and duration. Identifiers come
from validated correlation fields, never arbitrary strings supplied under those field names.
Operations, outcomes, error classes and metric label values have closed vocabularies registered
before use. Metrics use no content or unbounded identifier labels.

Never log prompts, tool content, credentials, tokens, headers, query strings, anchor bytes or
exception messages. Report an error's reviewed class/code. Unknown fields are ignored by the
allow-list, not passed through a redaction filter. Error paths and database/transport wrappers
follow the same rule. Acceptance includes feeding those forbidden values through every logger
entry point and proving that neither values nor fragments are emitted.

## Cases to validate

Measurements: 2026-09-30, Node 24.20.0, PostgreSQL 17.11, ACP SDK 1.5.1, real mock-agent
bridges and Chromium 141. A separate live run used Claude Code 2.1.261, claude-agent-acp 0.75.1,
Haiku, Kata and agentgateway 1.5.0. `packages/log/test/log.test.ts` is the reproducible measurement
suite; `packages/log/scripts/live-claude.ts` runs the opt-in billed cases. Fault injection is called
out explicitly; these results do not establish full adapter conformance, product authentication
or replacement extinction.

| # | Case | Expected | Measured |
| --- | --- | --- | --- |
| L1 | A line carrying `9007199254740993`, unknown members and arrays | Exact semantic values and array order read back as text; whitespace/member order may differ. | Passed: PostgreSQL 17.11, exact integer and decimal values, unknown members and array order. |
| L2 | Two identical lines | Two entries. | Passed: two identical occurrences retained. |
| L3 | An invalid line: batch, wrong direction, unsafe id, unsupported JSON value | A diagnostic without content; no ACP entry; not handled. | Passed: diagnostic-only rejection, UTF-8/body/direction/id/JSON value cases. |
| L4 | An invalid correlated answer, then projector rebuild and a later valid answer | `request.failed` and diagnostic commit together; the turn remains uncertain and Write blocked; rebuild agrees; only the valid answer resolves it. | Passed: invalid reply, rebuild equality, blocked Write and later valid completion. |
| L5 | An extension method, an unknown `session/update` type | Entries; generic elements. | Passed: generic extensions and sparse tool patches. |
| L6 | The write of an outgoing line fails | Nothing is sent. | Passed: rejected outgoing transaction and dispatch marker, no transport write. |
| L7 | PostgreSQL stops after receipt but before commit, then returns before execution expiry | Retained line committed once before later lines; pending receive bytes stay within 32 MiB; the turn continues. | Partial: PostgreSQL commit refusal injected; ordered bounded retention and recovery passed. Whole server stop/restart not measured. |
| L8 | Write during a turn, then during an uncertain turn | Refused; nothing written. | Passed: real mock bridge; concurrent and uncertain Write refused. |
| L9 | A command replayed with the same id, then another body | Same answer, one entry; then refused. | Passed: immutable replay answer, conflict refusal and one admitted concurrent turn. |
| L10 | A break that is not clean during a turn | The turn is uncertain; its answer, if it arrives, closes it. | Passed: real bridge peer displacement; uncertainty until the valid cancelled answer. |
| L11 | Cancel on an uncertain turn still running | `cancelled`; Write accepted again. | Passed: targeted Cancel of the real mock agent after a break. |
| L12 | Restore from an anchor | A new Session, same ACP session id. | Passed on mock and live Claude: opaque native files, new Session, same ACP id and recalled history. Claude capture used the tester's invocation of the bridge helper; termination-hook push was not exercised. |
| L13 | Change the model | Same Session. | Passed for attribution: valid configuration request/reply retains Session. Applied model readback belongs to the configuration contract. |
| L14 | Agora restarts after a completed drain, with a dispatched turn and a separate saved-line case | Dispatched turn remains in progress; saved line stays saved; all committed correlations found; claims carry only pool/deadline and labels. | Partial: clean restart of dispatched turn and initialization reuse passed; saved state covered at the marker failure boundary. |
| L15 | Agora killed during a turn | The turn is uncertain until its answer arrives. | Partial: missing-break crash window injected and recovered. OS-level SIGKILL not measured. |
| L16 | Rebuild against incremental, on a real claude-code transcript | Same identities, same hash. | Passed: live Haiku response and Bash tool traffic through the gateway, 105 canonical entries and 26 objects; identical identities/hash after rebuild. Captured real transcript also replayed in the PostgreSQL suite. |
| L17 | A projector's version changes and removes an object while another projector's objects remain | Atomic rebuild/reset through one source position; positions go on; obsolete object gone, unchanged objects retained. | Passed: version removal, coordinated reset and other projector objects retained. |
| L18 | Snapshot while updates commit, disconnect before snapshot-end, then reconnect | Snapshot through H, live tail after H; idempotent recovery; no skipped change or duplicate state. | Passed: repeatable-read snapshot, partial replay, lossless live tail and browser reload. |
| L19 | Normal create, append, lock, Session close, projection and anchor operations under actual logins; forbidden operations too | Required operations succeed; each role's forbidden writes/reads are denied, including anchor bytes for writer/projector and history edits for writer. | Passed: real restricted logins, permitted operations and denied history/anchor/view access. |
| L20 | Standard requests, notifications, successful responses and errors in both directions | Direction matrix accepts normal initialization/prompt answers and permission replies, and rejects their reversals. | Passed for initialize, prompt, permission, cancel and update families against SDK 1.5.1; full adapter conformance remains separate. |
| L21 | Crash before dispatch marker, after marker before transport write, and after write before `acp.sent` | First case may dispatch once; remaining cases are uncertain and never blindly resent, including initialization and session creation/resume. | Passed for prompts at all three boundaries; initialization reuse passed on restart. Opening-request crash windows were not separately measured. |
| L22 | Crash after Create acceptance before claim POST, and after claim POST before UID recording | Same execution, claim name, body and initial deadline recovered; no second claim. A previously obtained missing/different UID is not recreated or mutated. | Passed: accepted Create and POST/UID gaps recovered; obtained disappearance/conflicting UID never recreated or mutated. |
| L23 | Receive commit succeeds but its response is lost | Same receive identity resolves to one entry; identical separate occurrences still produce two. | Passed: real COMMIT with injected lost reply, receive identity retry and distinct occurrences. |
| L24 | Close handshake times out or database fails during shutdown | No clean break; restart records uncertainty; no false claim that output was drained. | Partial: database failure during break commit injected; missing break recovered unclean. Stalled peer close handshake not measured. |
| L25 | Two simultaneous Writes; Cancel delayed until the next turn; Stop racing dispatch/renewal | One admitted turn; cancellation never hits the next; no new dispatch or renewal attempt after Stop. | Passed: concurrent Writes, stale Cancel, Stop disables later prompts and renewal; dispatcher rechecks targets in its marker transaction. |
| L26 | Large cursors and positions beyond 2⁵³ − 1; roles created by concurrent migrations | Lossless arithmetic, ordering and thread resume; migrations succeed without privilege changes. | Passed: canonical positions and thread cursors beyond 2^53; concurrent role provisioning in separate databases. |
| L27 | Operational logger receives prompts, tools, tokens, headers, query strings, anchor bytes and exception messages | Only validated allow-listed correlations and closed classes emitted; no forbidden value or fragment. | Passed: forbidden values excluded by the logger allow-list, including forged correlation fields and exception messages. |
| L28 | Uncertain turn after a break or invalid answer, in assistant-ui | Composer disabled with reason; targeted Cancel and Stop available; uncertainty survives reload. | Partial: external-store mapping and Chromium lab composer/actions/reload passed. assistant-ui integration not measured. |
| L29 | Anchor committed before crash, without its journal entry | Recovery appends one `anchor.received` before exposure; writer/projector cannot read bytes. | Passed: unpublished committed metadata recovered once; restricted byte access and actual native restore. |
| L30 | Database outage exceeds execution deadline, or receive budget cannot be enforced | Interruption visible; no lossless-continuation claim or fresh lease invented. | Passed with injected commit outage, shortened infrastructure expiry and receive-budget overflow; visible interruption, no fresh lease. |

### Live Claude run

Run on 2026-09-30 in an isolated sandbox namespace. The gateway kept the Anthropic token;
the bridge received a ten-minute JWT with only the Anthropic grant. The pinned harness image
was `ghcr.io/arnaultbretagne/agora-harness-claude-code@sha256:5f3bb480d8cd1dccfe9ab6561b8a46d8cf5bad90574bccef2e379124e311b81c`.
It installs global Claude Code 2.1.261 and claude-agent-acp 0.75.1. The adapter selects its
bundled Agent SDK 0.3.257 native CLI, verified as Claude Code 2.1.257.
The tester's temporary gateway ingress policy and namespace were removed after both executions
stopped and their claims expired. Runtime database operations used the three restricted logins.

| Case | Validated turn (ms) | New canonical entries | Objects | Result |
| --- | --- | --- | --- | --- |
| Response and memorized test marker | 2,852 | 37 | 15 | `end_turn`; gateway CONNECT 200; rebuild hash identical. |
| Bounded Bash printf | 3,483 | 49 | 26 | `end_turn`; gateway CONNECT 200; tool updates retained; rebuild hash identical. |
| Recall after native restoration | 2,730 | 32 | 41 | `end_turn`; original marker recalled; rebuild hash identical. |

One sample per case, timed from command admission through all assertions, including projection
checks and bridge outbound readback. These are validated-run durations, not isolated inference
latencies or throughput benchmarks. Create through Session/configuration readiness took 20,930 ms;
native restore through readiness took 20,435 ms. The native bundle was 30,539 bytes in one file.
Restoration preserved the ACP context id and opened a different Agora Session. No ACP line was
rejected during the live run.

The Pod was ready before Create. The bridge and ACP adapter were warm; the adapter starts a new
Claude CLI query process during Session creation. Gateway credentials were supplied after the
opening response in this sample. A separate direct startup A/B reproduced the long wait when
credentials were withheld and removed it when supplied before opening. The live runner supplies
the gateway JWT before initialization and Session opening through the driver's optional credential
provider; a failed provisioning attempt
leaves those requests unsent. Credentials remain outside the canonical log.

| Original trace interval | Transaction-start difference (ms) |
| --- | --- |
| Create to bridge connection | 899 |
| Initialize request to response | 22 |
| Session/new request to response | 19,747 |
| First Write to acp.sent | 32 |
| Second Write to acp.sent | 35 |

Entries use PostgreSQL's transaction-start timestamp, not a commit or socket-receipt timestamp.
These differences locate the long opening wait but do not isolate platform latency. The two
turns contain 24 and 32 thought fragments respectively; the receive handler serially commits,
reconciles Kubernetes state and projects before handling the next retained line. That path can
delay output independently of generation. The original host-side measurement also looked up the
Pod on every claim read; the runner now caches the address once per Pod. The HTTP thread tail
waits 250 ms after an empty read, adding a separate scheduled delay before the next read.

The live runner writes `platform-timings.json` with monotonic durations, closed stage names and
validated correlations. Command-to-write ends at the local WebSocket send callback; it excludes
the response wait and does not prove adapter receipt. Receive-to-commit and receive-to-projection
start at the WebSocket message callback. They include queue waits after that callback but exclude
earlier socket buffering and SSE/browser delivery. Projection timing includes pool acquisition,
source reads, folding, view writes and the COMMIT acknowledgement. Nested stages overlap and
must not be added. The preserved live run has no such stage measurements.

The offline analysis script reads the preserved fixture, computes those transaction-start
differences and measures canonical folding and projection folding/hashing over prefixes of 20,
55 and 105 entries. Its CPU samples exclude SQL and all transport. The report is
`packages/log/test/fixtures/claude-code-platform-analysis.json`; it cannot establish gateway,
commit or publication latency.

The source fixture and report are `packages/log/test/fixtures/claude-code.json` and
`claude-code-report.json`. The fixture includes the two original turns; its 26-object projection
hash is `649841fda777e804e050f82e77f75731352fd7f50d513f113c643fec79e02b98`.
The native restoration sample is in the report. Native files were captured while quiescent by
the bridge's helper and published through the log; the Pod termination hook and anchor receiver
were not exercised by this case.

### Startup isolation

The direct startup experiments on 2026-09-30 used fresh already-ready Kata Pods and the same
pinned image. They bypassed the journal and projector, sent no model prompt and measured RPC
boundaries with a monotonic host clock. The adapter's own phase durations locate the wait
inside SDK initialization. Each row is one observation, not a percentile or throughput claim.

| JWT delivery | First Session/new (ms) | SDK initialize phase (ms) | Second Session/new on the same Pod (ms) | Refused outbound connections |
| --- | --- | --- | --- | --- |
| Before initialize and Session opening | 2,518 | 2,467 | 815 | 0 |
| After the first Session closes | 20,236 | 20,101 | 1,418 | 14 |

Initialize took 25 ms in both cases. Without credentials the bridge's loopback proxy refuses
CONNECT with 503 before reaching the gateway. The missing route introduces roughly 18 seconds
of SDK initialization delay in this experiment. It is independent of journal work and model
generation. The earlier implementation also recorded a 21.5-second SDK-initialize phase in
`field-findings.md`; its Pod-ready and post-opening turn timings did not include this wait.
A separate before-order repeat on another fresh warm Pod took 2,215 ms for the first opening
(2,170 ms in SDK initialize), 1,087 ms for the second and had no refused connections.

Warm-pool readiness covers the bridge and ACP adapter, not a ready Claude CLI query. The pinned
adapter calls the SDK's query API inside Session creation. Its bundled Agent SDK 0.3.257 also
provides startup, which initializes a CLI subprocess without a prompt and returns a reusable
WarmQuery handle. A separate real probe with gateway credentials took 1,400 ms to initialize
and 0.53 ms to obtain that handle's already-initialized query. This measures query-handle reuse,
not the first token or an ACP Session opening. The probe runs after claim; pool preinitialization
requires adapter integration that retains the process and respects the chosen Session settings,
client capabilities and native restoration. Starting then closing a disposable Session does
not preserve a ready SDK process.

The complete log run with credentials provisioned before opening reached Session/model readiness
in 3,265 ms and native-restored readiness in 2,453 ms. Response, Bash and restored-marker recall
all passed, with no rejected ACP lines. These readiness durations include claim acquisition,
initialization, Session opening, configuration and the runner's 100-ms observation polling;
they exclude model generation. Their wall-clock boundaries match the original readiness samples.

| Monotonic platform stage | Samples in this run | Median (ms) | p95 (ms) | Boundary |
| --- | --- | --- | --- | --- |
| Command to local prompt write | 3 | 35.23 | 49.78 | Command invocation through the WebSocket send callback. |
| Receive to canonical commit | 139 | 70.13 | 318.26 | Message callback through successful COMMIT acknowledgement, including the receive queue. |
| Receive to projection | 139 | 103.88 | 370.88 | Message callback through projection completion, including both receive and driver queues. |
| Canonical capture commit | 139 | 4.51 | 18.70 | Capture call, including pool acquisition and its transaction. |
| Projection call | 517 | 14.03 | 22.40 | Pool acquisition, reads, fold, writes and COMMIT; includes periodic reconciliations. |

Most receive-to-commit time in this run is queueing: its receive queue measured 65.86 ms median
and 312.54 ms p95. These are per-event distributions from one execution sequence, including
startup/configuration and turns, not production latency targets. They exclude buffering before
the WebSocket callback, SSE polling and rendering. Nested stages overlap.

The report is `packages/log/test/fixtures/claude-code-startup-report.json`. The opt-in
`measure:startup` runner emits the direct A/B and SDK probe separately from the billed
`measure:claude` run. Its 2,062 raw monotonic stage observations are preserved in
`claude-code-platform-timings.json`. Gateway JWTs are absent from all saved reports.

## Decisions still open

| Subject | Contract required before its implementation |
| --- | --- |
| Uncertain turns | Evidence that permits release without a valid final answer or execution loss/end. Timeout or a Cancel send is not that evidence. |
| Applied configuration | Model/effort readback after new/resume, invalidation after a break, model before dependent effort options, and explicit incompatibility rather than default substitution. |
| Retention and deletion | Retention by data kind and stop-before-delete semantics. Entries stay immutable until a separate deletion policy is accepted. |
| User access | Trusted authentication-proxy identity, protection from forged headers, Workstream ownership enforcement and service actors. An owner column alone authorizes nothing. |
| History seeding without an anchor | Included/excluded content, deterministic encoding and truncation, visible failures and proof of reception. Retaining a transcript does not prove a new context received it. |
| Harness conformance | Initialization identity, configuration readback, delivery/cancellation, native-file exclusions and allowed/refused gateway calls, demonstrated per pinned adapter. |
| Replacement and dispatch ownership | Physical extinction evidence before replacing an execution, and exclusive dispatch across overlapping server processes. Claims, positions and process-local queues alone provide neither guarantee. |

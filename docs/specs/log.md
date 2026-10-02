# The log

Contract to implement — PostgreSQL **17** (CloudNativePG), ACP protocol version **1**, schema of
`@agentclientprotocol/sdk` **1.5.1**. How it fits together is explained in `architecture/log.md`;
why, in the log ADR.

**Every command and every ACP line is written whole, at its Workstream's next position, before
Agora acts on it. The client only ever reads what is projected from it.**

## Who does what

| Part | Role |
| --- | --- |
| `Workstreams` (`@agora/log`) | Accepts commands, writes entries, decides every dispatch, captures every received line, recovers after a restart, projects the views and serves the thread. |
| `ExecutionManager` (`@agora/executions`) | The execution mechanics (`executions.md`): claims, bridge connections, deadlines, anchor authentication. It keeps no history, sends a line only when asked, and hands each received line over before reading the next. |
| PostgreSQL | The log, the views, the thread and the anchors, behind three roles. |
| The lab | Mounts both with PostgreSQL, creates one Workstream per execution, and serves a page that plays every case. |

## Entries

| Kind | Written when | Content |
| --- | --- | --- |
| `command` | A user command is accepted. | Its id, actor, kind, target and body. |
| `acp` | An ACP line is about to be sent to the bridge, or has been received from it. | The line, whole. |
| `acp.dispatching` | The dispatcher commits to a line's first transport write. | The line's position and the connection. |
| `acp.sent` | That write's callback succeeds. | The line's position and the connection. It proves a local write, not that the harness read the line. |
| `request.failed` | A request of Agora's fails locally: an invalid answer, a transport error, a response timeout, a refused deadline, a Stop. | The request's position, a closed reason, and the diagnostic id when there is one. Never the invalid content or an exception message. |
| `execution.obtained` | The claim of an accepted Create is created or found. | Its name and UID. |
| `execution.connected` | A connection to the bridge is open and its instance checked. | The connection, the bridge instance. |
| `execution.break` | A connection to the bridge closes, after every line received on it is committed. | The connection, the close code when known, clean or not. |
| `session.opened` | `session/new`, `session/load` or `session/resume` is answered without error. | The ACP session id, the pool, the harness, and the origin: new, or the anchor restored. |
| `session.ended` | The execution is lost, failed or ended, or another ACP session replaces this one. | The reason. |
| `execution.lost` | The adapter died, the bridge instance changed, or the claim conflicts with the record. | The reason. |
| `execution.failed` | Startup or restoration cannot complete. | The reason and the request position when there is one. |
| `anchor.received` | An authenticated anchor is stored. | Its id; never its bytes. |
| `execution.ended` | The claim has disappeared. | The reason, and the anchor received if any. |

| Rule | Detail |
| --- | --- |
| Position | Each entry takes its Workstream's next position, under a lock on the Workstream in the transaction that writes it. Positions are consecutive and never reused. |
| Admission | A command's deduplication, its admission check and its entries commit under that same lock. The check reads entries, never a view. |
| Attribution | Every entry names its Workstream; execution and Session entries name their execution. A request, its answer and its dispatch markers keep the Session the request was written in, even once it has ended — except the answer that opens a Session, which belongs to the new one. |
| Time | The time an entry is written is recorded. It orders nothing. |
| Immutable | An entry is never updated or deleted. |
| Kinds | Closed: a kind is added to the table above before any code writes it. |

## ACP lines

| Rule | Detail |
| --- | --- |
| A line | One JSON value in UTF-8: one WebSocket text message from or to the bridge, at most 16 MiB. |
| Stored as | The original text, bound as `jsonb` with no JavaScript parse and serialize on the way. Unknown members, array order and exact numbers survive, `9007199254740993` included; whitespace, member order and number spelling may change. Read back as text (`::text`) and parsed losslessly wherever exact values matter. |
| Beside it | Direction (`out`, `in`), JSON-RPC kind (request, response, error, notification), method, the method of the request a response answers, that request's position, JSON-RPC id, the command, the connection, and for a received line its receive ordinal on that connection. They index the line; they are not a second copy. |
| Outgoing | Written, then dispatched. Only a committed `acp.dispatching` permits the first transport write. |
| Incoming | Written, then handled (turns, deadline, Sessions) and projected. |
| Order | Both directions share the Workstream's positions; within a direction, the order of the connection. |
| Ids | Agora's own requests carry `agora-<execution>-<position>` string ids, from the position their entry takes. |
| Correlation | An answer resolves the request with the same id, from the opposite direction, in the same execution. A reconnection keeps pending requests. Receipt time changes no attribution. |

### Validation

Each line is checked against the pinned schema: its JSON-RPC envelope, kind, direction and
method. A response is checked against the method of the request it answers. A method's `x-side`
names the side that serves it.

| JSON-RPC kind | `agent` | `client` | `both`, `protocol` |
| --- | --- | --- | --- |
| Request or notification | out | in | Either direction |
| Response or error | in | out | Opposite to the request it answers |

| Line | Verdict |
| --- | --- |
| A known method, in its direction, with a matching body | Valid. |
| A method the schema does not know, in a valid envelope | Valid: an extension. |
| A `session/update` whose type the schema does not know, in a valid notification with a Session id and a string type | Valid: an extension. |
| An answer that correlates with no request, in a valid envelope | Valid; it resolves nothing. |
| A known method in the wrong direction, or with a body that does not match | Invalid: `wrong_direction`, `invalid_body`. |
| A batch | Invalid: `batch`. |
| A numeric id beyond ±(2⁵³ − 1) | Invalid: `unsafe_id`. |
| Not UTF-8, not JSON, more than one value | Invalid: `invalid_utf8`, `invalid_json`. |
| A duplicate key, even with an equal value; a `__proto__` key; `\u0000`; a number beyond PostgreSQL's `numeric` | Invalid: `unsupported_json_value`. |

An invalid line is never an `acp` entry, never forwarded and never handled. Agora keeps a
diagnostic: execution, connection, receive ordinal, direction, reason, size and SHA-256 — never
its content. When an invalid incoming line carries the id of a pending request of Agora's, the
diagnostic and a `request.failed` naming it commit together; that request stays pending, and a
later valid answer still resolves it.

Closed reasons: `invalid_utf8`, `invalid_json`, `invalid_envelope`, `batch`, `wrong_direction`,
`invalid_body`, `unsafe_id`, `line_too_large`, `unsupported_json_value`, `transport_error`,
`response_timeout`, `deadline_refused`, `startup_failed`, `restore_failed`, `claim_conflict`,
`claim_missing`, `adapter_exited`, `instance_changed`, `deadline_reached`, `stopped`, `replaced`,
`anchor_missing`, `credentials_refused`. No parser, database or transport message becomes a reason.

### Dispatch and recovery

One dispatcher per Workstream orders command acceptance and every effect: outgoing lines,
deadline renewal, Stop. Positions alone authorize no concurrent writer.

| Evidence for an outgoing line | What may follow |
| --- | --- |
| No `acp.dispatching`, no `request.failed` | Never attempted. It may be dispatched once its target, admission and Stop are rechecked. |
| `request.failed` and no `acp.dispatching` | Never attempted, failed. It is never dispatched; a new command is needed. |
| `acp.dispatching`, with or without `acp.sent`, and no valid answer | Possibly accepted by the harness. Agora reconnects to the same instance and waits for the same answer; it never resends a prompt, an `initialize` or a Session opening. |
| A valid answer | Its outcome is applied once. |

`acp.dispatching` commits before the transport is called; nothing that can still refuse the
write comes after it. `acp.sent` commits once the write's callback succeeds; a callback error
records `request.failed` (`transport_error`), which proves neither that no byte left nor that
the harness finished. Two distinct answers to one request are two entries; only the first valid
one applies its outcome, and an answer cannot open a Session twice, nor once its execution is
lost, failed or ended.

| Timeout | Rule |
| --- | --- |
| `initialize`, Session opening | 60 s after `acp.sent` without a valid answer — an invalid one does not stop the clock: `request.failed` (`response_timeout`), then `execution.failed`, in one transaction. Never resent. |
| `session/prompt` | None: the turn ends with its answer, its execution, or the turn's maximum duration. |

### Backpressure and shutdown

The lines of a connection are handled one at a time. The WebSocket is paused while a line is
validated and committed, and resumed only once the commit succeeds: nothing more is read from the
connection, and only what came with that line in the same read of the socket (64 KiB) may wait
with it. The rest waits with the bridge, which stops reading the adapter.

When a commit fails, the line is kept and retried first, with the same connection and receive
ordinal; an ambiguous commit is resolved by that identity, never by comparing content. Meanwhile
Agora sends nothing, admits no command and renews no deadline; deadlines already granted stand.
Past the claim's deadline, or when Agora stops, the line is given up and the connection failed.

A clean shutdown, within 5 s: admission and dispatch close, pending write callbacks settle, the
close handshake runs while received lines keep being committed. If the peer completes the close,
every received line is committed and every dispatch on the connection has its `acp.sent` or its
answer, the break is written clean; otherwise unclean. A restart writes an unclean break for every
connection left without one, before any dispatch.

### Database ownership

The running server holds a PostgreSQL advisory lock on a dedicated connection; a second server is
refused at its start. If that connection fails, or its check goes unanswered for 10 s, the process
exits with a non-zero status and recovery runs on its restart.

## Sessions

| Rule | Detail |
| --- | --- |
| Opening | `session.opened` commits with the answer that creates or resumes the ACP session. The Session gets an Agora id; the ACP session id is recorded, never used as its identity. |
| Restoring | A restore from an anchor opens a new Session, even with the same ACP session id. |
| Changing the model | `session/set_config_option` is an ACP line like any other: the Session goes on. |
| Another ACP session in the same execution | Ends the current Session and opens another. |
| Opening requests | `initialize` and the opening requests belong to the execution only. |
| Reconnecting | To the same bridge instance, the Session goes on; to another instance, the execution is lost. |

## Commands

The commands are the interface's: Create, Write, Cancel, Respond to a permission, Stop
(`assistant-ui.md`).

| Rule | Detail |
| --- | --- |
| Identity | Each command carries an id chosen by the interface, unique in its Workstream. Kind, target and body are compared through a canonical encoding: the same id and request return the first answer and write nothing; a different request is refused (`command_conflict`). |
| Accepted | The command, its answer and its deduplication record commit together, before any effect; for Write, Cancel and Respond to a permission, the outgoing line too. A refused command is answered with its reason and written nowhere. A later failure is read in the thread; the answer never changes. |
| Create | Carries the pool, the settings (lease, turn duration), the profiles to grant and the anchor to restore, if any. The pool is checked against the catalogue before the transaction. The acceptance binds a new execution id, the claim name and the initial deadline. Refused while the Workstream's execution exists (`execution_active`), until its claim has disappeared. |
| Write | Accepted only if the execution is connected with its Session open, sending is open, no turn is saved, in progress or uncertain (`turn_active`, `turn_uncertain`), and no permission is pending (`permission_pending`). |
| Cancel | Carries the target turn id. Right before dispatch, the dispatcher checks that this turn is still in progress or uncertain; otherwise `request.failed` (`stopped`) and no line leaves. |
| Respond to a permission | Carries the Session and the request's position. Accepted while that exact request is pending. Once a `session/cancel` is sent, Agora answers every pending permission of the execution `cancelled` itself. |
| Stop | Accepted while the execution exists, lost included. Committed before admission closes; after it, no dispatch other than the turn's `session/cancel` and the `cancelled` answers to pending permissions, and no renewal, even after a restart. |

| Refusal | When |
| --- | --- |
| `command_conflict` | The id was used for another request. |
| `invalid_command` | A value PostgreSQL cannot hold, or a line that is not valid ACP (its reason instead: `invalid_body`, `unsupported_json_value`…). |
| `unavailable` | Agora is stopping, or a received line is waiting for its commit. Answered 503. |
| `execution_active` | Create while the Workstream's execution exists. |
| `unknown_pool`, `invalid_create`, `quota` | Create: a pool not in the catalogue; settings out of bounds; the active executions at their maximum. |
| `unknown_profile` | Create: a profile the catalogue does not know. |
| `unknown_anchor`, `anchor_incompatible` | Create: no such anchor; an anchor of another harness. |
| `execution_conflict` | Create: the execution or claim name already recorded. |
| `execution_unavailable` | No execution, or it has ended; or, except for Stop, it is lost or failed. |
| `stale_execution` | The target is not the Workstream's execution. |
| `stopped` | Stop already given; or a Write, Cancel or answer after it. |
| `disconnected`, `execution_ending` | Write: no connection to the bridge; the claim being deleted or its deadline passed. |
| `stale_session`, `opening_session`, `permission_pending` | Write: another Session; the Session still opening; a permission pending. |
| `turn_active`, `turn_uncertain` | Write: a turn saved or in progress; a turn uncertain. |
| `stale_turn` | Cancel: the target is not the turn in progress or uncertain. |
| `stale_permission`, `invalid_permission_option` | Respond to a permission: not that pending request; an option it did not offer. |

### A turn's states

| State | What the log holds |
| --- | --- |
| saved | The Write and its `session/prompt` line, without `acp.dispatching` or `request.failed`. |
| in progress | `acp.dispatching`, and no valid answer, local failure or unclean break since. |
| done | A valid answer with a `stopReason` other than `cancelled`. |
| cancelled | A valid answer with `stopReason` `cancelled`. |
| failed | A valid error answer, a `request.failed` before any dispatch, or the end of its execution before an answer. |
| uncertain | Dispatched, no valid answer, and an unclean break or a local `request.failed` since. |

An uncertain turn is never resent. It changes only on proof: its valid answer — `cancelled` once a
Cancel reaches a turn still running — or the end of its execution.

## Views

The client's objects — Workstream, turn, element, notice — are projections of the entries. Their
folds from ACP are those of `assistant-ui.md` ("Blocks of a response"); a line no fold
understands becomes a generic element.

| Object | Identity: name-based UUID of |
| --- | --- |
| Turn | The Session and the `session/prompt` request id. |
| Tool | The Session and the tool call id. |
| Permission | The Session and the request's position. |
| Text, reasoning | The turn and the rank of the run of consecutive chunks. |
| Plan | The turn. |
| Notice | The Workstream and the position of the entry it comes from. |
| Generic element | The Workstream and the position of the line. |

| Rule | Detail |
| --- | --- |
| Deterministic | A fold reads entries in position order and nothing else: no diagnostic row, clock or live execution. |
| Version | Each projector has a version. A checkpoint records, per projector and Workstream, the version and the last position folded; a checkpoint from another version counts as none. |
| Same transaction | Views, their thread updates and their checkpoint commit together, under a projector lock of their own, separate from the capture lock. |
| Rebuild | For the same version and source position, gives the same identities and rows as the incremental run: a hash of the canonical encoding of the rows, sorted by id, with no field left out. A rebuild publishes atomically and removes obsolete objects. |

### The thread

What the client reads (`assistant-ui.md`, "A workstream's thread").

| Rule | Detail |
| --- | --- |
| Update | Each change to a view appends an update: its position, the operation (`upsert` with the whole object, or `remove`), the object's kind and id. |
| Positions | Strictly increasing and never reused. A rebuild appends `reset`, then every object; it never truncates. |
| Reading | From cursor C: a consistent snapshot through high-water mark H — the latest state or removal of each object changed in (C, H], then `snapshot-end` carrying H — then live updates after H. A `reset` in (C, H] sends the complete state at H. |
| Cursor | A decimal string, compared losslessly. Zero asks for a complete snapshot; a negative cursor or one beyond H is refused. |

## HTTP

| Route | Answer |
| --- | --- |
| `POST /api/workstreams` | Creates a Workstream: `id`, `owner`. 409 if the id belongs to another owner. |
| `POST /api/workstreams/{id}/commands` | A command: `id`, `kind`, `target`, `body`. 200 accepted, 409 refused, with the reason. |
| `GET /api/log-json.js` | The lossless JSON parser the page reads the thread with. |
| `GET /api/workstreams/{id}/thread?after=C` | Server-sent events: `snapshot` rows, `snapshot-end`, then `live` rows. |
| `POST /api/workstreams/{id}/control` | Lab only: one `session/set_config_option` for the current Session, between turns. |
| `POST /api/workstreams/{id}/credentials` | Lab only: hands a signed credential to the execution's bridge (`credentials.md`). |
| `GET /api/workstreams/{id}/entries` | Lab only: the entries, as stored. |
| `GET /api/anchors`, `GET /api/anchors/{id}/content` | Lab only: the stored anchors, and an anchor's native files. |

Bodies are UTF-8 JSON of at most 16 MiB, parsed losslessly. A malformed body is 400; a storage
failure is 503; no answer carries an exception message.

## An execution's memory

| Needed after a restart | From |
| --- | --- |
| Which executions to take back | Accepted Creates without `execution.ended`, joined with the claims Agora manages (`app.kubernetes.io/managed-by=agora`, `agora.bretagne.dev/execution-id`). |
| Claim name, pool, settings, initial deadline, anchor to restore | The Create, and `execution.obtained` for the UID. |
| Bridge instance | The last `execution.connected`. |
| The agent's capabilities | The answer to Agora's `initialize`, or its pending request. |
| Session | The last `session.opened` not ended. |
| Turn, its delivery and its start | The unresolved `session/prompt`, its markers, failures and breaks; its entry time bounds the turn. |
| Stop | The Stop command. |

The claim carries only its pool, its deadline and its labels. Before connecting, recovery writes
the unclean breaks, then joins Creates and claims:

| Situation | Recovery |
| --- | --- |
| No claim, no UID recorded, before the initial deadline | Create the claim with the recorded name, pool and deadline — unless the execution is stopped, lost or failed: then `execution.ended` (`claim_missing`). |
| No claim, no UID recorded, after the initial deadline | `execution.failed` (`startup_failed`), then `execution.ended` (`claim_missing`); no fresh lease. |
| No claim, a UID recorded | `execution.ended` (`claim_missing`); never recreated. |
| A claim with other labels or another UID | `execution.lost` (`claim_conflict`); the claim is left untouched. |
| Expiry, deletion in progress, adapter loss | Dispatch and renewal stop; the execution stays counted, and Create stays refused, until the claim has disappeared. |

An anchor is matched to its execution through the Pod's claim, its labels and UID, and the Pod
UID TokenReview returns, even with no connection open. It is stored by the anchor role, then
`anchor.received` is appended; an anchor stored without its entry gets it at the next start.

## Storage

| Table | Key | Holds |
| --- | --- | --- |
| `workstreams` | id | Owner, last entry position. |
| `threads` | Workstream | The thread's last position; its row is the projector's lock. |
| `entries` | Workstream, position | Kind, execution, Session, content (`jsonb`), the ACP columns, time. A received line has a unique (connection, receive ordinal). |
| `commands` | Workstream, id | Kind, target, SHA-256 of the canonical request, the answer, its entry's position, the execution and claim name of a Create. |
| `sessions` | id | Workstream, execution, ACP session id, the positions where it opened and ended. |
| `diagnostics` | id | Execution, connection, receive ordinal, direction, reason, size, SHA-256, time. |
| `anchors` | id | Workstream, execution, Session, metadata, content (`bytea`). |
| `objects` | Workstream, kind, id | The view object, its projector, its first and last positions. |
| `thread` | Workstream, position | Operation, object kind and id, the object. |
| `checkpoints` | Workstream, projector | Version, last position folded. |

| Role | May | May not |
| --- | --- | --- |
| `agora_writer` | Read and insert Workstreams, entries, commands, Sessions, diagnostics; read anchor metadata; update a Workstream's last entry position and a Session's end. | Update or delete an entry or a command; read anchor bytes; write views, the thread or checkpoints. |
| `agora_projector` | Read Workstream ids and owners, and entries; write views, checkpoints and the thread; update the thread's last position. | Write entries, commands or Sessions; read anchors; change thread rows. |
| `agora_anchors` | Read Workstream ids and owners, and the execution and Session columns; read and insert anchors, bytes included. | Write entries, commands, Sessions, views; change anchors. |

| Rule | Detail |
| --- | --- |
| Logins | The three roles are NOLOGIN. The server connects with one login per role; no login owns a table or inherits a migration or superuser privilege. The schema is applied by the database owner. |
| Login creation | Tolerates a concurrent creation; the password is set from a SCRAM verifier, never plain text in a statement. |
| `bigint` | Read as decimal strings, set once for every connection; position arithmetic uses JavaScript `bigint`. |
| Tests | Run under the real logins, each in its own database. |

### Operational logs

The operational logger takes a closed list of fields: actor, Workstream, Session, execution,
connection, command, position, operation, outcome, error class, byte count, duration. Operations,
outcomes and error classes come from closed lists. A value that is not a valid identifier is
dropped. Never a prompt, tool content, credential, token, header, query string, anchor byte or
exception message.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| L1 | A received line carrying `9007199254740993`, unknown members, `_meta` and arrays | Read back as text: the same integer, members and array order. |
| L2 | Two identical lines received | Two entries, at two positions, with two receive ordinals. |
| L3 | Invalid received lines: a batch, a wrong direction, an id beyond 2⁵³, invalid UTF-8, two values, a duplicate key with an equal value, a `__proto__` key, `\u0000` | For each: one diagnostic with its reason, size and SHA-256, no content; no `acp` entry; nothing handled. |
| L4 | An invalid answer to Agora's pending prompt, then a valid one | The diagnostic and a `request.failed` naming it, in one transaction; the turn uncertain; Write refused `turn_uncertain`; the valid answer closes the turn. |
| L5 | An extension method and an unknown `session/update` type | `acp` entries, and generic elements in the thread. |
| L6 | The insert of a Write's line fails | Answered 503; no command and no entry written; no `acp.dispatching`; nothing reaches the bridge. |
| L7 | A capture connection is terminated during a turn | The line is retried and committed once, in order; the turn goes on to its answer. |
| L8 | The ownership connection is terminated | The process exits with a non-zero status. On restart: an unclean break, the dispatched turn uncertain, never resent. |
| L9 | Write during a turn, then during an uncertain turn | Refused `turn_active`, then `turn_uncertain`; nothing written. |
| L10 | A command replayed with the same id and request; then a different request; then two Writes at once | The first answer, one command entry; then `command_conflict`; then exactly one Write accepted. |
| L11 | The bridge side closes the connection during a turn | An unclean break; the turn uncertain; its answer after reconnection closes it; the prompt is never resent. |
| L12 | Cancel on an uncertain turn still running | One `session/cancel` sent; the turn `cancelled`; Write accepted again. |
| L13 | A Cancel whose turn has ended before its dispatch | `request.failed` (`stopped`), no `session/cancel` sent; the next turn unaffected. |
| L14 | Stop, between turns and during a turn | No dispatch but the turn's `session/cancel`, and no renewal afterwards; without Stop, renewal happens during a turn. |
| L15 | Restore from an anchor | `session.opened` with the anchor as origin, a new Session, the same ACP session id; the agent recalls the history. |
| L16 | `session/set_config_option` between turns | The same Session. |
| L17 | Agora stops cleanly (SIGTERM) during a dispatched turn | A clean break; the turn in progress; its answer after restart closes it; no second `initialize`. |
| L18 | Agora is killed (SIGKILL) during a dispatched turn | On restart: an unclean break, the turn uncertain until its answer; never resent; no second `initialize`. |
| L19 | Agora dies before `acp.dispatching`, after it, and after the write but before `acp.sent` | Dispatched once after restart; then uncertain and never resent; then uncertain and never resent. |
| L20 | Agora dies after accepting a Create, before the claim; after the claim, before its UID; a recorded claim disappears; a claim with another UID | The claim created once, with the recorded name and deadline; the UID recorded, no second claim; `execution.ended`, never recreated; `execution.lost` (`claim_conflict`), the claim untouched. |
| L21 | A capture commit succeeds but its acknowledgement is lost | The retry finds the same receive identity: one entry. |
| L22 | The real claude-code transcript, folded incrementally and through a rebuild | The same identities, and the hash recorded at capture. |
| L23 | A projector's version changes and drops an object, while another projector's objects remain | `reset`, then the complete state; positions go on; the dropped object is gone, the others stay. |
| L24 | The thread read while updates commit, cut before `snapshot-end`, read again | No change skipped, none applied twice; a negative cursor or one beyond H refused. |
| L25 | Each role does what it may, then what it may not | The first succeed; each of the second is denied. |
| L26 | Positions and cursors beyond 2⁵³ − 1 | Exact arithmetic, order, request ids and thread reads. |
| L27 | Migrations run at once in two databases of one cluster | Both succeed; no existing role gains a privilege. |
| L28 | Prompts, tool content, tokens, headers, query strings, anchor bytes and exception messages fed to every logger entry point | None of them, nor a fragment, is emitted. |
| L29 | An anchor stored without its `anchor.received` | One `anchor.received` appended at the next start, before the anchor is exposed. |
| L30 | The adapter dies | `execution.lost`; no dispatch or renewal; the execution counted and Create refused until the claim disappears; then one `execution.ended`, and a new execution can be created. |
| L31 | The claim is being deleted while its Pod lives, across a restart | Admission closed; the execution counted and Create refused until the claim disappears. |
| L32 | A Pod pushes its anchor after a restart, with no connection open | Stored, attributed to the original Session, one `anchor.received`; a push whose Pod UID differs is refused. |
| L33 | The same opening or final answer received twice, including after the end of the execution | Each captured; the first valid applies once; no Session reopened. |
| L34 | `initialize` unanswered | `request.failed` (`response_timeout`), `execution.failed` (`startup_failed`); no second `initialize`. |
| L35 | A line waits for its commit while the agent keeps writing | Nothing more is read: what waits stays within the line and one read of the socket; then every line is captured once, in order. |
| L36 | A storage outage lasting past the execution's deadline | The interruption shown; no fresh lease. |
| L37 | A permission answered; then another pending when a Cancel is sent | The answer goes to that request once, a second refused (`stale_permission`); the Cancel's `session/cancel` is followed by a `cancelled` answer to the pending one. |
| L38 | The bridge restarts inside its Pod during a turn: a new instance | `execution.lost` (`instance_changed`), the turn failed; no dispatch, no renewal; Write refused. |
| L39 | A second server started on the same database | It exits at start, writing nothing; the first goes on. |
| L40 | The deadline cannot be moved when a prompt is dispatched | `request.failed` (`deadline_refused`); the turn failed; nothing sent; a Write accepted again. |
| L41 | An invalid answer to `initialize`, then no valid one | The diagnostic and `request.failed` naming it; then `request.failed` (`response_timeout`) and `execution.failed` (`startup_failed`); no second `initialize`. |

**To be specified:** releasing an uncertain turn without an answer or the end of its execution;
the applied model and effort as a view; retention and deleting a Workstream; who may read and
write a Workstream; seeding a new context when no anchor can be restored; per-harness
conformance; proof that an old execution is extinct before a replacement.

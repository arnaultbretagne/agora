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
| The server (`apps/server`) | Mounts both with PostgreSQL, serves the client (`assistant-ui.md`) and the API. With its test routes open (`TEST_ROUTES` `true`), it also serves a page that plays every case. |

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
| `session.opened` | `session/new`, `session/load` or `session/resume` is answered without error. | The ACP session id, the pool, the harness, the origin: new, or the anchor restored; and the exchanges its first prompt will give and those left out ("Continuing"). |
| `session.ended` | The execution is lost, failed or ended, or another ACP session replaces this one. | The reason. |
| `execution.lost` | The adapter died, the agent answered a prompt with an internal error (JSON-RPC `-32603`), the bridge instance changed, or the claim conflicts with the record. | The reason. |
| `execution.failed` | Startup or restoration cannot complete. | The reason and the request position when there is one. |
| `anchor.received` | An authenticated anchor is stored. | Its id; never its bytes. |
| `execution.ended` | The claim has disappeared. | The reason, and the anchor received if any. |
| `delegation.started` | A delegate's Workstream is created by `delegate` (`delegation.md`), in that Workstream. | The delegator's Workstream and execution; the harness, model, effort and rights given; the approval's position in the delegator's Workstream, when one was asked. |
| `delegation.continued`, `delegation.result`, `delegation.reported` | Not written any more; those in the log stay. | |
| `question.expired` | An approval reaches its expiry unanswered, or the server starts while it waits (`delegation.md`, "Approval"). | The question's position. |

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
`claim_missing`, `adapter_exited`, `agent_failed`, `instance_changed`, `deadline_reached`, `stopped`, `replaced`,
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
| Settings | The Session's settings are the `configOptions` of the answer that opens it, replaced whole by each answer to `session/set_config_option` and each `config_option_update`. Changing one is an ACP line like any other: the Session goes on. |
| Opening settings | Those the Create resolves (below). Once the Session opens, and before any prompt, Agora sends one `session/set_config_option` at a time, in the order resolved: only for a setting the Session offers, with a value it lists, that is not already the current one; each sent once, whatever its answer. They are settled when none is left to send or unanswered. |
| Another ACP session in the same execution | Ends the current Session and opens another. |
| Opening requests | `initialize` and the opening requests belong to the execution only. |
| Reconnecting | To the same bridge instance, the Session goes on; to another instance, the execution is lost. |

## Continuing

A Workstream outlives its executions. A new one continues it: the agent gets back what an anchor
saved, and the rest of the conversation as text, from the log.

| Rule | Detail |
| --- | --- |
| The anchor | The Create's `anchor` when it names one; otherwise the Workstream's last anchor of the pool's harness, whatever the pool's name: that of the execution created last among those that opened a Session and left one naming an ACP session. Never an anchor an execution failed to restore — `restore_failed`, `anchor_missing`, or an error answering its `session/resume` or `session/load`. None: a new ACP session. |
| An exchange | A turn whose `session/prompt` was dispatched: the user's blocks, but an earlier catch-up; then the agent's `agent_message_chunk` text and the title of each tool it called, a failed one marked, in their order. No reasoning, tool content, plan or permission. |
| What an anchor holds | Its execution's exchanges; those its execution was given, once a prompt carrying them was dispatched; and what the anchor it restored held. Nothing for an anchor of another Workstream. |
| Which exchanges | Every exchange of the Workstream the anchor does not hold — all of them without an anchor —, oldest first. |
| Chosen | At the Create, recorded in its body as `catchUp`: the positions of the prompts of the exchanges to give, and how many were left out. `session.opened` gives their two counts. |
| Given | With the execution's first prompt that is not a command — a first text block starting with `/` runs one, and must stay first. One text block ahead of the user's, marked in its `_meta` with `agora.bretagne.dev/catch-up` and the two counts. Once dispatched, never again in that execution; never dispatched, the next execution gives those exchanges. |
| Length | At most 200,000 characters of exchanges, the most recent kept whole; a message or a response beyond 20,000 characters is cut. |
| What it says | Whether the Session was restored from a save that ends before these exchanges, or no save could be restored; that they are context, oldest first; how many were left out; that the user's new message follows. |

What is given as text is what was said, not the agent's state: no tool result, no file. A Pod that
ends without its anchor is an incident — the node dying, Agora unreachable during the grace period
— not the normal path: anchors stay saved only when the Pod ends (`executions.md`).

## Commands

The commands are the interface's: Create, Write, Cancel, Respond to a permission, Configure, Scope,
Stop (`assistant-ui.md`); and a question's, Ask and Answer: whoever drives the Workstream — a flow —
asks the person, and the interface answers.

| Rule | Detail |
| --- | --- |
| Identity | Each command carries an id chosen by the interface, unique in its Workstream. Kind, target and body are compared through a canonical encoding: the same id and request return the first answer and write nothing; a different request is refused (`command_conflict`). |
| Accepted | The command, its answer and its deduplication record commit together, before any effect; for a Write that does not wait, a Cancel and a response to a permission, the outgoing line too. A refused command is answered with its reason and written nowhere. A later failure is read in the thread; the answer never changes. |
| Create | Carries the pool, the limits (lease, turn duration), the Session's settings (`settings`: a setting's id to a value, both strings), the profiles to grant and the anchor to restore, if any; without one, the log finds it ("Continuing"). The pool is checked against the catalogue before the transaction. The acceptance binds a new execution id, the claim name and the initial deadline, and resolves the opening settings: the pool's (`executions.md`, "The API"), each replaced by the Create's own of the same id, then the Create's others, recorded with the command. Refused while the Workstream's execution exists (`execution_active`), until its claim has disappeared. |
| Write | Accepted only if the execution is connected with its Session open, its opening settings settled, sending is open, no turn is uncertain (`turn_uncertain`), no permission is pending (`permission_pending`), no question is pending (`question_pending`), and no setting is being changed (`settings_pending`). Its prompt holds only blocks the agent accepts: text and resource links always; images, audio and embedded resources when its `initialize` answer's `promptCapabilities` says `image`, `audio` and `embeddedContext` (`prompt_unsupported`). During a turn saved or in progress, or behind another message, it waits ("Messages waiting"); otherwise its line commits with it, carrying the catch-up when it is due ("Continuing"). A Write of Agora's (`delegation.md`, "Messages") is refused none of these: it waits until the Workstream can take it. While an approval is pending, a Write of the person's is that approval's refusal instead (`delegation.md`, "Approval"): accepted whatever the turn, no line goes to any agent. |
| Retract | Carries a waiting Write's position (`message`). Accepted while it waits: it is never sent, and no line goes to any agent. |
| Configure | Carries the Session, a setting's id and a value. Accepted only if the execution is connected with its Session open, its opening settings settled, no turn is saved, in progress or uncertain, no permission or question is pending, no other setting is being changed, and only for a setting the Session offers with a value it lists (`unknown_setting`). Its `session/set_config_option` commits with it. |
| Scope | Carries the execution and the whole set of its own profiles (`profiles`, a list of strings). Accepted while the execution is neither stopped, lost nor failed and no turn is saved, in progress or uncertain; its profiles checked as the Create's (`credentials.md`, "On Agora's side"). It replaces the execution's own profiles; no line goes to the agent. |
| Cancel | Carries the target turn id. Right before dispatch, the dispatcher checks that this turn is still in progress or uncertain; otherwise `request.failed` (`stopped`) and no line leaves. |
| Respond to a permission | Carries the Session and the request's position. Accepted while that exact request is pending. Once a `session/cancel` is sent, Agora answers every pending permission of the execution `cancelled` itself. |
| Ask | Carries no target. Its body: `title`, one line of 1 to 200 characters; `text`, Markdown, at most 100,000 characters; `options`, 2 to 4, each an `optionId` of 1 to 64 characters unique among them, a `name` of 1 to 80 characters and a `kind` among `allow_once`, `allow_always`, `reject_once`, `reject_always`; `note`, true when the answer may carry a text, false when absent. Accepted whatever the Workstream's execution, none included, while no question is pending. No line goes to any agent. An approval is an Ask of Agora's own, `kind` `approval` (`delegation.md`, "Approval"): one option, `allow_once`; the gated tool line's `toolCallId`, when matched; its `expiresAt`. |
| Answer | Carries the pending question's position (`question`). Its body: the `optionId` chosen and, when the question allows one, a `note` of at most 10,000 characters. Accepted while that question is pending. No line goes to any agent. |
| Stop | Accepted while the execution exists, lost included. Committed before admission closes; after it, no dispatch other than the turn's `session/cancel` and the `cancelled` answers to pending permissions, and no renewal, even after a restart. |

| Refusal | When |
| --- | --- |
| `command_conflict` | The id was used for another request. |
| `invalid_command` | A value PostgreSQL cannot hold, or a line that is not valid ACP (its reason instead: `invalid_body`, `unsupported_json_value`…). |
| `unavailable` | Agora is stopping, or a received line is waiting for its commit. Answered 503. |
| `execution_active` | Create while the Workstream's execution exists. |
| `unknown_pool`, `invalid_create`, `quota` | Create: a pool not in the catalogue; limits out of bounds, or `settings` not an object of strings; the active executions at their maximum. |
| `settings_pending` | Write or Configure while the opening settings are not settled, or another setting is being changed. |
| `unknown_setting` | Configure: a setting the Session does not offer, or a value it does not list. |
| `unknown_profile`, `profile_not_offered` | Create or Scope: a profile the catalogue does not know; one beyond those offered (`credentials.md`, "Offered profiles"). |
| `invalid_scope` | Scope: `profiles` not a list of strings. |
| `unknown_anchor`, `anchor_incompatible` | Create: no such anchor; an anchor of another harness. |
| `execution_conflict` | Create: the execution or claim name already recorded. |
| `execution_unavailable` | No execution, or it has ended; or, except for Stop, it is lost or failed. |
| `stale_execution` | The target is not the Workstream's execution. |
| `stopped` | Stop already given; or a Write, Configure, Scope, Cancel or answer after it. |
| `disconnected`, `execution_ending` | Write: no connection to the bridge; the claim being deleted or its deadline passed. |
| `stale_session`, `opening_session`, `permission_pending` | Write: another Session; the Session still opening; a permission pending. |
| `prompt_unsupported` | Write: a block of a type the agent's `promptCapabilities` does not accept. |
| `turn_active` | Configure or Scope: a turn saved or in progress. |
| `turn_uncertain` | Write, Configure or Scope: a turn uncertain. |
| `stale_message` | Retract: not a waiting Write. |
| `stale_turn` | Cancel: the target is not the turn in progress or uncertain. |
| `stale_permission`, `invalid_permission_option` | Respond to a permission: not that pending request; an option it did not offer. |
| `invalid_question` | Ask: a body outside its bounds. |
| `question_pending` | Ask, Write or Configure while a question is pending. |
| `stale_question`, `invalid_question_option`, `invalid_answer` | Answer: not the pending question; an option it did not offer; a note it does not allow, or one that is not a string within bounds. |

### Messages waiting

| Rule | Detail |
| --- | --- |
| Waiting | A Write accepted and not sent: its command and answer committed, no line. Its element `waiting` shows it. |
| In order | The Workstream's oldest waiting message goes first, alone: one message, one turn. |
| Sent | As soon as the Workstream can take a message: its execution connected with its Session open and its opening settings settled, not ending, no turn saved, in progress or uncertain, no permission, question or approval pending, no setting being changed. The dispatcher commits its line, with the catch-up when it is due; the Write's answer does not change. |
| No execution | A message waits through its execution's end. Once it has ended, Agora continues the Workstream by a Create of its own: the last execution's pool, or, gone with an older image, one of its harness; its settings, profiles and limits. Refused (`quota`), it is tried again. After a Stop, nothing goes until the person's next Create. |
| A restart | Waiting messages are read back from the log; each line commits once. |

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

## Sub-streams

A Workstream started from another is its sub-stream. It records its parent once, when it is created,
and with it its root — the Workstream at the top of its line — and its depth, one more than its
parent's; a Workstream without a parent is a root: its own root, at depth 0. Agora sets no limit on
depth: whatever starts a sub-stream checks its own. A sub-stream belongs to the owner of its root.

| Rule | Detail |
| --- | --- |
| Parent | Given when the Workstream is created, never changed: a Workstream of the same owner. |
| Root and depth | The parent's root, and the parent's depth plus one. |
| Owner | The parent's, whoever creates it: a sub-stream belongs to the person who owns its root. |
| Its row | In its parent's list, not in its owner's ("The list"). |
| What comes up | A Workstream's row counts what lies under it, at every depth: the sub-streams; those in state `starting`, `ready` or `interrupted`; those with a question pending. Its `changedAt` is the latest of its own and theirs. |

## Views

The client's objects — Workstream, turn, element, notice — are projections of the entries. How
the client shows them is `assistant-ui.md`.

| Object | Identity: name-based UUID of |
| --- | --- |
| Turn | The Session and the `session/prompt` request id. |
| Tool | The Session and the tool call id. |
| Permission | The Session and the request's position. |
| Question | The Workstream and the Ask's position. |
| Text, reasoning | The turn and the rank of the run of consecutive chunks. |
| Plan | The turn. |
| Workstream | The Workstream's id. |
| Notice | The Workstream and the position of the entry it comes from. |
| Generic element | The Workstream and the position of the line. |

| Rule | Detail |
| --- | --- |
| Deterministic | A fold reads entries in position order and nothing else: no diagnostic row, clock or live execution. |
| Version | Each projector has a version. A checkpoint records, per projector and Workstream, the version and the last position folded; a checkpoint from another version counts as none. |
| Same transaction | Views, their thread positions and their checkpoint commit together, under a projector lock of their own, separate from the capture lock. |
| Rebuild | For the same version and source position, gives the same identities and rows as the incremental run: a hash of the canonical encoding of the rows, sorted by id, with no field left out. A rebuild publishes atomically and removes obsolete objects. |

### Elements

| `type` | Folded from | Fields |
| --- | --- | --- |
| `user` | Agora's `session/prompt` | `turn`, `session`, `content`: the prompt's blocks but Agora's catch-up; `catchUp`: its counts, when the prompt carried one; `from` and `as`: who wrote it, when its first block is marked `_meta` `agora.bretagne.dev/from` (`delegation.md`, "Messages"), that block left out of `content`; a block marked `agora.bretagne.dev/delegation`, as earlier delegations wrote it, reads as `as` `delegator` |
| `waiting` | A Write that waits, then its line or its Retract | `position`: the Write's; `content`, `from`, `as`, as the `user` element's; `status` (`waiting`, `sent`, `retracted`) |
| `report` | A `session/prompt` of an earlier delegation, its block marked `_meta` `agora.bretagne.dev/report`, in place of `user`. Not written any more; those in the log stay. | `turn`, `session`, `text`, `delegates` |
| `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` | Consecutive chunks of one type and `messageId` | `turn`, `session`, `chunks`, `text`: their text blocks joined |
| `tool` | `tool_call`, then each `tool_call_update` with its id, merged member by member | `turn`, `session`, and the ACP members: `toolCallId`, `title`, `kind`, `status`, `content`, `locations`, `rawInput`, `rawOutput` |
| `plan` | The turn's last `plan` | `turn`, `session`, `entries` |
| `permission` | `session/request_permission`, then Agora's answer | `execution`, `turn`, `session`, `requestId`, `requestPosition`, `params`, `status` (`pending`, `answered`, `cancelled`), `answer` |
| `question` | An Ask, then its Answer, a refusing Write or its expiry | `position`: the Ask's; `title`, `text`, `options`, `note`, and for an approval `kind` `approval`, `toolCallId` and `expiresAt`: the Ask's; `status` (`pending`, `answered`, `refused`, `expired`); `answer`: the Answer's `optionId` and its `note`, or a refusing Write's text |
| `acp` | Any other line, except `initialize`, the Session openings, `session/prompt`, `session/cancel` | `turn`, `session`, `line`: the line whole |

A pending permission becomes `cancelled` when its Session ends, or its execution is lost, fails or
ends.

### The Workstream view

One object per Workstream, changed by its commands, its execution entries, its Sessions, its
anchors, the dispatch of its prompts, the agent's title, and a delegate's turns' ends.

| Field | Value |
| --- | --- |
| `title` | The agent's last `session_info_update` title in the Workstream; otherwise the first line of the first Write's text, at most 80 characters; otherwise "New workstream". |
| `state` | Below. |
| `execution`, `session` | The last execution's id and its open Session's, or null. |
| `pool`, `harness` | The last execution's, or null. |
| `anchor` | The anchor its `execution.ended` names, or null. |
| `stopped`, `ended`, `lost`, `failed`, `unavailable` | The last execution's flags; `unavailable` while no Session is open and connected. |
| `settings` | The last Session's settings as it last gave them, kept once it has ended: each with `id`, `name`, `category`, `type`, `currentValue` and `options` (`value`, `name`, `description`; groups flattened); or null. |
| `commands` | The last Session's last `available_commands_update`, kept once it has ended: each with `name`, `description` and its input's `hint`; or empty. |
| `configuring` | A `session/set_config_option` of the open Session is unanswered. |
| `usage` | The open Session's last `usage_update`: `used`, the context's tokens in use, and `size`, the context's size; a `size` of zero or less, or a number missing, is ignored. Null before the agent has said, and once the Session has ended. |
| `profiles` | The last execution's own profiles: its Create's, then its last Scope's; or empty. |
| `promptCapabilities` | What the last execution's agent accepts in a prompt beyond text and resource links, from its `initialize` answer: `image`, `audio` and `embeddedContext`, each true only when it says so; kept once it has ended; null before it has answered. |
| `exchanges` | The Workstream's turns whose prompt was dispatched. |
| `question` | The pending question's position, or null. |
| `delegation` | A delegate's state (`delegation.md`, "A delegation"): `working`, `idle`, `failed` or `cancelled`. Absent on any other Workstream. |
| `continuation` | For each harness with an anchor a Create would restore: that anchor, and the number of exchanges it does not hold ("Continuing"). |
| `changedAt` | The time of the entry that changed the view last. |

| `state` | When, the first that applies |
| --- | --- |
| `none` | No Create accepted. |
| `ended` | The last execution has `execution.ended`. |
| `failed` | It has `execution.failed`. |
| `lost` | It has `execution.lost`. |
| `stopped` | Its Stop is accepted. |
| `ready` | Its Session is open, its opening settings settled, and its connection open. |
| `interrupted` | Its Session is open, its connection broken since. |
| `starting` | Otherwise. |

### Notices

| `type` | From | Fields |
| --- | --- | --- |
| `session.opened` | `session.opened` | `origin`: `new` or the anchor restored; `harness`; `catchUp` and `omitted`, when counted |
| `session.ended` | `session.ended` | `reason` |
| `execution.break` | an unclean `execution.break` | `reason` `transport_error` |
| `request.failed` | `request.failed` | `reason` |
| `execution.lost`, `execution.failed`, `execution.ended` | the same entry | `reason` |

Every notice also names its execution and Session.

### The thread

What the client reads (`assistant-ui.md`, "The exchanges").

| Rule | Detail |
| --- | --- |
| Update | Each change to a view takes the Workstream's next thread position, stored with the object: an object holds the position of its last change, never the changes before it. A row is an `upsert` with the whole object, its kind and id, at that position. |
| Reset | A rebuild, or a change that removes an object, takes the next position for a `reset`, then gives every object a position after it: the complete state, in order. A removal is never sent on its own. |
| Positions | Strictly increasing and never reused; the thread's last position and its last reset's are kept with the projector's lock. |
| Reading | From cursor C: a consistent snapshot through high-water mark H — each object changed in (C, H], in position order; after a `reset` in (C, H], that `reset` then every object — then `snapshot-end` carrying H; then live, the same from the last position sent: a change made twice in between arrives once, as it stands. |
| Cursor | A decimal string, compared losslessly. Zero asks for a complete snapshot; a negative cursor or one beyond H is refused. |

### The list

What the client's list of Workstreams reads (`assistant-ui.md`, "The exchanges"): one light row per
Workstream, written beside its view, read as the thread is read, so that a client follows the
changes instead of fetching every view again.

| Rule | Detail |
| --- | --- |
| Row | The Workstream's id, `parent` and `depth`; of its view `title`, `state`, `harness`, `question` and a delegate's `delegation`; `below`, what lies under it ("Sub-streams"): `count`, `live`, `waiting`; and `changedAt`, the latest of its view's and of theirs. Written in the transaction that writes the view, once the Workstream has one. |
| List | A root's row is in its owner's list: the person's identity for their own, their agents' folder for their agents' ("HTTP"). A sub-stream's row is in its parent's list. |
| Positions | Per list, strictly increasing and never reused: each row written takes its list's next position, and waits for the row before it to be committed. A row equal to the one stored is not written. |
| Up the line | A row written writes its parent's row again in the same transaction, then its parent's, up to the root, each with what lies under it, each in its own list. Lists are taken from the sub-stream up, so that two lines never wait on each other. |
| Reading | From cursor C, as the thread: from zero, the 50 most recently changed rows, by `changedAt` then id; from C, the current row of each Workstream whose row was written in (C, H]; then `snapshot-end` carrying H, the list's last position; then the rows written after H, live. |
| Pages | The rows older than a page cursor, by `changedAt` then id, 50 at most, with the next page's cursor or none. With a text, the rows whose title holds it, ignoring case, from every list of the owner's: sub-streams included, at any depth. A page cursor is the last row's `changedAt` and id. |
| Removal | None is sent: a Workstream deleted from the log leaves the list at its next reading from zero. |
| Back-filling | At start, a Workstream with a view and no row gets one, and its ancestors' rows count it. |

## HTTP

| Route | Answer |
| --- | --- |
| `GET /api/workstreams/list?after=C` | Server-sent events of the caller's list ("The list") — the owner its identity gives, as for a Create: `snapshot` rows, `snapshot-end`, then `live` rows. With `folder`, one of the caller's folders: `agents`, the Workstreams of the agents its runs staff, owned by the name-based UUID of its identity under `agents` rather than `owner` — the caller's folder alone, out of its own list; 400 `unknown_folder` for any other. With `parent`, a Workstream's list, its sub-streams: the caller's, 404 `unknown_workstream` otherwise. Without the proxy, the list of the `owner` or `parent` given; 400 `invalid_identifier` without either. A Workstream's whole view is read in its thread. |
| `GET /api/workstreams/page?before=B&title=T` | JSON: `rows`, the caller's rows older than page cursor B — the most recent without one —, whose title holds T when given; `next`, the following page's cursor, or null. `folder`, `parent` and `owner` as for the list; 400 `invalid_cursor` for a malformed cursor. |
| `GET /api/workstreams/{id}/row` | The Workstream's row ("The list"), the caller's: its parent and depth, so that a client climbs its line one row at a time. 404 `unknown_workstream` before its first entry or for another's. |
| `GET /api/account` | `email`: the identity the proxy passes, as it passes it, or null without one. |
| `POST /api/workstreams` | Creates a Workstream: `id`, and `parent`, the Workstream it is started from, if any ("Sub-streams"). The owner is a name-based UUID of the identity the proxy passes (`X-Forwarded-Email`, which it sets and drops from the client's request), or the body's `owner` without one; with a parent, the parent's: 404 `unknown_parent` for a parent that does not exist or is not the caller's. 409 if the id belongs to another owner or has another parent. |
| `GET /api/pools` | The catalogue (`executions.md`), each pool with the `settings`, `commands` and `promptCapabilities` the last Session opened in it gave; a pool none has opened in yet, as a harness's newer image is, with its harness's last Session's; else null and empty. |
| `POST /api/workstreams/{id}/commands` | A command: `id`, `kind`, `target`, `body`. 200 accepted, 409 refused, with the reason. |
| `GET /api/log-json.js` | The lossless JSON parser the test page reads the thread with. |
| `GET /api/workstreams/{id}/thread?after=C` | Server-sent events: `snapshot` rows, `snapshot-end`, then `live` rows. |
| `POST /api/workstreams/{id}/control` | Test only: one `session/set_config_option` for the current Session, between turns. |
| `POST /api/workstreams/{id}/credentials` | Test only: hands a signed credential to the execution's bridge (`credentials.md`). |
| `GET /api/workstreams/{id}/entries` | Test only: the entries, as stored. |
| `GET /api/anchors`, `GET /api/anchors/{id}/content` | Test only: the stored anchors, and an anchor's native files. |

The test routes answer only while `TEST_ROUTES` is `true`; otherwise 404.

Bodies are UTF-8 JSON of at most 16 MiB, parsed losslessly. A malformed body is 400; a storage
failure is 503; no answer carries an exception message.

## An execution's memory

| Needed after a restart | From |
| --- | --- |
| Which executions to take back | Accepted Creates without `execution.ended`, joined with the claims Agora manages (`app.kubernetes.io/managed-by=agora`, `agora.bretagne.dev/execution-id`). |
| Claim name, pool, settings, initial deadline, anchor to restore, catch-up | The Create, and `execution.obtained` for the UID. |
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
| `workstreams` | id | Owner; parent, root — none for a root, its own — and depth; last entry position. |
| `threads` | Workstream | The thread's last position and its last reset's; its row is the projector's lock. |
| `entries` | Workstream, position | Kind, execution, Session, content (`jsonb`), the ACP columns, time. A received line has a unique (connection, receive ordinal). |
| `commands` | Workstream, id | Kind, target, SHA-256 of the canonical request, the answer, its entry's position, the execution and claim name of a Create. |
| `sessions` | id | Workstream, execution, ACP session id, the positions where it opened and ended. |
| `diagnostics` | id | Execution, connection, receive ordinal, direction, reason, size, SHA-256, time. |
| `anchors` | id | Workstream, execution, Session, metadata, content (`bytea`). A Workstream keeps its last anchor per harness: one stored removes the earlier ones of its harness. |
| `objects` | Workstream, kind, id | The view object, its projector, its first and last positions; the thread position of its last change; an element's `type`, in a column of its own, and its text's trigrams, in an index (`objects_text`, PostgreSQL's `pg_trgm`), for search (`search.md`). |
| `checkpoints` | Workstream, projector | Version, last position folded. |
| `lists` | Owner | The list's last position; its owner is a person's identity or folder, or a Workstream for its sub-streams; its row is the lock that orders the list's rows. |
| `listings` | Workstream | Its list's owner, position, `changedAt`, title, the row. |

| Role | May | May not |
| --- | --- | --- |
| `agora_writer` | Read and insert Workstreams, entries, commands, Sessions, diagnostics; read anchor metadata; update a Workstream's last entry position and a Session's end. | Update or delete an entry or a command; read anchor bytes; write views, the thread's positions or checkpoints. |
| `agora_projector` | Read Workstream ids, owners and lines, and entries; write views with their thread positions, checkpoints and the lists; update the thread's last position and last reset, and a list's last position. | Write entries, commands or Sessions; read anchors; delete the thread's row or a list's rows. |
| `agora_anchors` | Read Workstream ids and owners, and the execution and Session columns; read, insert and delete anchors, bytes included. | Write entries, commands, Sessions, views; update an anchor. |

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
| L9 | Write during an uncertain turn | Refused `turn_uncertain`; nothing written. |
| L10 | A command replayed with the same id and request; then a different request; then two Writes at once | The first answer, one command entry; then `command_conflict`; then both accepted, one line, the other waiting. |
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
| L24 | The thread read while updates commit, cut before `snapshot-end`, read again | Live rows after H in strictly increasing positions; the client ends at the stored state, no object missed, none applied twice; a negative cursor or one beyond H refused. |
| L25 | Each role does what it may, then what it may not | The first succeed; each of the second is denied. |
| L26 | Positions and cursors beyond 2⁵³ − 1 | Exact arithmetic, order, request ids and thread reads. |
| L27 | Migrations run at once in two databases of one cluster | Both succeed; no existing role gains a privilege. |
| L28 | Prompts, tool content, tokens, headers, query strings, anchor bytes and exception messages fed to every logger entry point | None of them, nor a fragment, is emitted. |
| L29 | An anchor stored without its `anchor.received` | One `anchor.received` appended at the next start, before the anchor is exposed. |
| L30 | The adapter dies | `execution.lost` (`adapter_exited`); no dispatch; the deadline moved once, to now, and no other renewal; the execution counted and Create refused until the claim disappears; then one `execution.ended` naming the anchor received, and a new execution can be created. |
| L31 | The claim is being deleted while its Pod lives, across a restart | Admission closed; the execution counted and Create refused until the claim disappears. |
| L32 | A Pod pushes its anchor after a restart, with no connection open | Stored, attributed to the original Session, one `anchor.received`; a push whose Pod UID differs is refused. |
| L33 | The same opening or final answer received twice, including after the end of the execution | Each captured; the first valid applies once; no Session reopened. |
| L34 | `initialize` unanswered | `request.failed` (`response_timeout`), `execution.failed` (`startup_failed`); no second `initialize`. |
| L35 | A line waits for its commit while the agent keeps writing | Nothing more is read: what waits stays within the line and one read of the socket; then every line is captured once, in order. |
| L36 | A storage outage lasting past the execution's deadline | The interruption shown; no fresh lease. |
| L37 | A permission answered; then another pending when a Cancel is sent | The answer goes to that request once, a second refused (`stale_permission`); the Cancel's `session/cancel` is followed by a `cancelled` answer to the pending one. |
| L38 | The bridge restarts inside its Pod during a turn: a new instance | `execution.lost` (`instance_changed`), the turn failed; no dispatch, no renewal; Write refused. |
| L39 | A second server started on the same database | It exits at start, writing nothing, its log saying the recovery refused (`conflict`); the first goes on. |
| L40 | The deadline cannot be moved when a prompt is dispatched | `request.failed` (`deadline_refused`); the turn failed; nothing sent; a Write accepted again. |
| L41 | An invalid answer to `initialize`, then no valid one | The diagnostic and `request.failed` naming it; then `request.failed` (`response_timeout`) and `execution.failed` (`startup_failed`); no second `initialize`. |
| L42 | Workstreams of one owner listed, one of them with no entry; then another changes | The one with no entry not listed; the one changed last first, with its new title. |
| L43 | A Workstream through Create, a Session, a break and its reconnection, Stop, the end with an anchor | No view before its first entry; then the view's `state`: `starting`, `ready`, `interrupted`, `ready`, `stopped`, `ended`; its `pool`, `harness`, `session` and `anchor`; its `title` from the first Write, then the agent's. |
| L44 | A Session opened new, restored from an anchor, then ended | A `session.opened` notice with origin `new`, one with the anchor, then a `session.ended` notice with its reason. |
| L45 | A Workstream created with the proxy's identity and another `owner` in the body, again, then with another identity | Owned by the identity's name-based UUID; the second accepted; the third 409. |
| L46 | Agora started after its core projector changed version, with a Workstream whose execution has ended | That Workstream's objects rebuilt at start, its view under the new version; its checkpoint at the new version. |
| L47 | A Create with `settings`, in a pool that declares others | The Create's body records the pool's, each replaced by the Create's own, then its others; once the Session opens, one `session/set_config_option` at a time for each not current, before any prompt; the view `starting` until the last is answered, then `ready` with the new `settings`. |
| L48 | Opening settings the Session does not offer, with a value it does not list, or already current; one answered with an error | None sent for the first three; the error's sent once; the Session ready. |
| L49 | Configure between turns | Accepted, its line committed with it; `configuring` until the answer, then `settings` from it; a Write meanwhile refused `settings_pending`. |
| L50 | Configure for a setting the Session does not offer, a value it does not list, during a turn | `unknown_setting`, `unknown_setting`, `turn_active`; nothing sent. |
| L51 | `config_option_update` and `available_commands_update` from the agent | The view's `settings` and `commands` replaced. |
| L52 | `GET /api/pools` after a Session in a pool, another annotated for the tests | That pool's `settings` and `commands` as the Session gave them; the other `testing`. |
| L53 | A Create whose `settings` is not an object of strings | `invalid_create`. |
| L54 | A Create with profiles, then a Scope with others | The view's `profiles`: the Create's, then the Scope's; the Scope recorded with the command. |
| L55 | A Scope whose `profiles` is not a list of strings; one targeting a past execution; one after Stop | `invalid_scope`; `stale_execution`; `stopped`. |
| L56 | Workstreams created under two identities and with a body's `owner`, then listed with each identity; without one, with an owner and with none | Each identity lists its own Workstreams only, a body's owner ignored; without an identity, the given owner's; 400 `invalid_identifier` without one. |
| L57 | An execution ends with its anchor; the next, created with no anchor named, has a turn, and its Pod ends without one; a third is created | The second restores the first's anchor and is given nothing; the third restores it too, counts one exchange, and its first prompt carries the second's exchange alone, ahead of the user's block, once; the thread's user message without it; the view's `exchanges` and `continuation`. |
| L58 | An execution's Pod ends without its anchor after two turns; the next is created | A new ACP session; `session.opened` counts two exchanges; its first prompt carries both, oldest first, saying no save could be restored. |
| L59 | An anchor left in one pool; a Create in another pool of the same harness | That anchor restored; the agent recalls the history. |
| L60 | A Workstream to catch up; the new execution's first message is a command, then two messages | The command without the catch-up; the next message with it; the one after without. |
| L61 | A history with a dispatched turn — text in chunks, a failed tool, reasoning —, one never dispatched, and one carrying an earlier catch-up | Two exchanges, the text joined and the tool marked failed in their order; no reasoning, no earlier catch-up. |
| L62 | Exchanges beyond the catch-up's maximum; then the same given again | The most recent kept, the count of those left out given and said; the same text again. |
| L63 | A restored execution ends before any message, its catch-up never given; the next is created | Its own anchor restored; the exchange it was never given, given now. |
| L64 | The agent refuses to resume the last anchor; the next execution is created | That anchor not restored again, nor the one its execution pushed; a new ACP session given every exchange. |
| L65 | `GET /api/pools` after a Session in a pool, with a newer pool of its harness and a pool of another harness, neither opened | The newer pool: that Session's `settings` and `commands`; the other harness's: null and empty. |
| L66 | The agent reports its context twice, then with a size of zero; then its Session ends | The view's `usage`: the first, then the second; unchanged by the third; null once the Session has ended. |
| L67 | An agent accepting images and embedded resources, not audio: before it answers `initialize`, once it has, once its execution has ended; then `GET /api/pools` | The view's `promptCapabilities`: null; then `image` and `embeddedContext` true, `audio` false; the same once ended; the pool's the same. |
| L68 | That agent: a Write with text and an audio block; then one with text, an image and an embedded resource | The first refused `prompt_unsupported`, nothing written, nothing sent; the second accepted, the agent given the three blocks as sent. |
| L69 | An Ask on a Workstream that has no execution | Accepted; the element `question` pending, with its position, title, text, options and note; the view's `question` its position; no line to any agent. |
| L70 | An Ask while one is pending; Asks outside their bounds — one option, five, an `optionId` twice, an unknown `kind`, a title of two lines | `question_pending`; `invalid_question` for each; nothing written. |
| L71 | A Write and a Configure while a question is pending; then the question answered and the Write again | `question_pending` both, nothing written, nothing sent; once answered, the Write accepted. |
| L72 | An Answer with an option and a note | Accepted; the element `answered`, its `answer` the option and the note; the view's `question` null; another Ask accepted next. |
| L73 | Answers to another position, to an answered question, with an option not offered, with a note the question does not allow | `stale_question` for the first two, `invalid_question_option`, `invalid_answer`; nothing written. |
| L74 | The same Ask again under its id, once answered | Its first answer; no second question. |
| L75 | The account, with the proxy's identity and without | The e-mail; null. |
| L76 | A Workstream of the person's, one of their agents' folder, one of someone else's folder: lists with and without `folder=agents`, for each, an unknown folder; without the proxy, with an owner and with none | The person's list its own only; their folder its own only; someone else's folder theirs only; 400 `unknown_folder`; without the proxy, the given owner's, 400 `invalid_identifier` without one. |
| L77 | The agent answers a prompt with an internal error (JSON-RPC `-32603`), its adapter still running; before it, a turn answered normally | The normal turn grants a lease and the execution goes on. Then the turn failed with that error; `execution.lost` (`agent_failed`); Write refused; the deadline moved to now, the last one set; `execution.ended` naming the anchor received; the next execution restores that anchor. |
| L78 | A Workstream's view changes its title, then its state; then its views are rebuilt | A row with the owner's next position each time; none for the rebuild, its row unchanged. |
| L79 | Two owners, one with a Workstream in its agents' folder, each list read | Each list holds its owner's rows only, each with its own positions. |
| L80 | 60 Workstreams of one owner, its list read from zero | The 50 most recently changed, newest first, then `snapshot-end` with the owner's last position. |
| L81 | The list read from zero, then a Workstream changes; then read again from the last cursor received | The change arrives live, once; read again, nothing more until the next change, which arrives once. |
| L82 | 60 Workstreams of one owner, pages; a title filter in another case | The first page the 50 most recent, then the 10 others and no next cursor; the filter the rows whose title holds the text, from every page. |
| L83 | A list cursor beyond the last position, a negative one; a malformed page cursor; no owner without the proxy | `future_cursor`; `invalid_cursor`; `invalid_cursor`; `invalid_identifier`. |
| L84 | Agora started on a log whose Workstreams have views and no rows | Each gets its row once; started again, none is written. |
| L85 | Two Workstreams of one owner projected at the same time, the list read live | Both rows arrive, with distinct positions, in the order of their positions. |
| L86 | A Workstream created with a parent, then one with that one as its parent; through the proxy, each body naming another `owner` | Their root the first's, their depths 1 then 2; both owned by the root's owner. |
| L87 | A parent that does not exist; a parent of another owner; the same id sent again with another parent | 404 `unknown_parent`; 404 `unknown_parent`; 409 `workstream_conflict`; nothing written. |
| L88 | A root with two sub-streams and one under the first; the lists read | The owner's list the root alone; the root's its two sub-streams; the first's its own; each list with its own positions. |
| L89 | A sub-stream two levels down asks a question, then gets its answer | Its parent's and its root's rows written again each time, at their lists' next positions: `waiting` 1 then 0, `changedAt` the question's then the answer's. |
| L90 | Two sub-streams of one parent projected at the same time | The parent's row counts both: no count lost. |
| L91 | Agora started on a log whose sub-streams have no row | Each gets its row in its parent's list, and each ancestor's row counts it. |
| L92 | A Workstream six levels down | Created, at depth 6: Agora sets no limit. |
| L93 | A sub-stream's row read by its id; a Workstream without an entry; another person's | Its parent and depth; 404 `unknown_workstream`; 404 `unknown_workstream`. |
| L94 | A title search on the owner's list, a sub-stream two levels down holding the text | The sub-stream among the rows, with its parent. |
| L95 | An element changed several times — a text streamed in several chunks —, the thread read from before its first change | One row for it: its last state, at the position of its last change, as stored; each object once, in position order; the thread's last position counts every change. |
| L96 | A projector's fold drops an object without a version change | `reset` at the next position, then every remaining object after it, in order; the dropped object gone, the others kept. |
| L97 | Anchors stored for a Workstream: two of one harness, one of another, one of another Workstream; then the last stored again | The earlier anchor of that harness removed; the other harness's, the other Workstream's and the last kept; storing the last again removes nothing. |
| L98 | The schema applied to a database that kept every change of the thread in a table of its own, a reset among them, and two anchors of one harness | Each object at the position of its last change, the last reset kept, the table gone; a read from before the reset gives it then the complete state, one from after it what changed since; that harness's last anchor kept, the other removed; applied again, nothing changes. |
| L99 | A delegate through its turn, then given another message with `to`; its delegator | Its view's and its row's `delegation` `working`, then `idle`, then `working` and `idle` again; none in its delegator's view or row. |
| L100 | A Write during a turn | Accepted, no line; the element `waiting`; the turn ended, its line, a turn of its own, the element `sent`. |
| L101 | Three Writes during a turn, the second retracted; then a Retract of the first, already sent | The element `retracted`, never sent; the others sent in order, one turn each; `stale_message`. |
| L102 | A restart with a message waiting | Sent after the restart, once. |
| L103 | A Write of Agora's before the Session opens; with the execution ended; with its pool gone; after a Stop | Sent once it is open; a Create with the last execution's pool, settings, profiles and limits, then sent; with a pool of its harness; waiting, no Create, until the person's next one. |
| L104 | A Write of Agora's while an approval, a question or a permission is pending | Waiting, the approval not refused; sent once it is settled. |

**To be specified:** releasing an uncertain turn without an answer or the end of its execution;
the applied model and effort as a view; retention and deleting a Workstream; who may read and
write a Workstream; per-harness conformance; proof that an old execution is extinct before a replacement.

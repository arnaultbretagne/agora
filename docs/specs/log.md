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
| `session.opened` | `session/new`, `session/load` or `session/resume` is answered without error. | The ACP session id, the execution, the pool, the harness, and its origin: new, or the anchor restored. |
| `session.ended` | The execution is lost or ended, or another ACP session replaces this one. | The reason. |
| `execution.connected` | Agora opens a connection to the bridge. | The connection, the bridge instance. |
| `execution.break` | A connection to the bridge closes. On a clean stop, Agora closes its connections and writes their breaks before leaving; after a restart, a connection left without one gets one, not clean. | The connection, the close code, clean or not. |
| `execution.lost` | The adapter died, or the bridge instance changed. | The reason. |
| `execution.ended` | The claim has disappeared. | The anchor received, or why there is none. |

| Rule | Detail |
| --- | --- |
| Position | Each entry takes its Workstream's next position, allocated under a lock on the Workstream in the transaction that writes it. Positions are consecutive. |
| Attribution | Every entry names its Workstream; execution and Session entries name their execution; an entry written while a Session is open names that Session. |
| Time | The time an entry is written is recorded. It never orders anything. |
| Immutable | An entry is never updated or deleted. |
| Kinds | Closed: a kind is added to the table above before any code writes it. |

## ACP lines

| Rule | Detail |
| --- | --- |
| A line | One JSON value in UTF-8: one WebSocket text message from or to the bridge, at most 16 MiB. |
| Stored as | The text itself, bound as `jsonb`, never parsed and serialized again on the way: `9007199254740993` and members Agora does not know survive. Read back as text (`::text`) wherever the exact value matters. |
| Beside it | Direction (`out`, `in`), JSON-RPC kind (request, response, error, notification), method, the method of the request a response answers, JSON-RPC id, the command that caused it, the connection that carried it. They index the line; they are not a second copy. |
| Outgoing | Written, then sent. If the write fails, nothing is sent. The entry means "scheduled for sending". |
| Incoming | Written, then handled (turns, deadline) and projected. The entry means "received". |
| Order | Both directions share the Workstream's positions; within a direction, the order of the connection. |
| Database unavailable | Agora stops reading the bridge and sends nothing; the bridge then stops reading the adapter. New commands are refused. |
| Ids | Agora's own requests carry `agora-<n>` string ids. |

### Validation

Each line is checked against the pinned schema: by JSON-RPC kind, by direction, and by method —
for a response, the method of the request it answers. A method's `x-side` gives its direction:
`agent` goes out, `client` comes in, `both` and `protocol` go either way.

| Line | Verdict |
| --- | --- |
| A known method, in its direction, with a matching body | Valid. |
| A method the schema does not know | Valid: an extension. |
| A `session/update` whose type the schema does not know | Valid: an extension. |
| A known method in the wrong direction, or with a body that does not match | Invalid. |
| A batch (a JSON array) | Invalid. |
| A numeric id beyond ±(2⁵³ − 1) | Invalid. |
| Not UTF-8, not JSON, or more than one value | Invalid. |

An invalid line is not an entry. Agora keeps a diagnostic — execution, direction, reason, size,
SHA-256 — never its content. An invalid outgoing line is not sent. An invalid incoming line is
not handled, except that when it carries the id of a request Agora is waiting on, that request
fails with the reason.

## Sessions

| Rule | Detail |
| --- | --- |
| Opening | `session.opened` is written in the same transaction as the answer that creates or resumes the ACP session. The Session gets an Agora id; the ACP session id is recorded, never used as its identity. |
| Restoring | A restore from an anchor opens a new Session, even with the same ACP session id. |
| Changing the model | `session/set_config_option` is an ACP line like any other: the Session goes on. |
| Another ACP session in the same execution | Ends the current Session and opens another. |
| Before the first Session | `initialize` and the `session/new` request are attributed to the execution only. |
| Reconnecting | To the same bridge instance, the Session goes on; to another instance, the execution is lost. |

## Commands

The commands are the interface's: Create, Write, Cancel, Respond to a permission, Stop
(`assistant-ui.md`).

| Rule | Detail |
| --- | --- |
| Identity | Each command carries an id chosen by the interface, unique in its Workstream. The same id with the same body returns the first answer and writes nothing; with another body, it is refused. |
| Accepted | Written as a `command` entry, then carried out. A refused command is answered with its reason and not written. |
| Create | Carries the pool, the execution's settings and the anchor to restore, if any. |
| Write | Accepted only if the execution is ready, sending is open, and no turn is saved, in progress or uncertain. The command, then its `session/prompt` line, are written before the line is sent. |
| Cancel | Sends `session/cancel` if the targeted turn is in progress or uncertain; otherwise, no effect. It never reaches another turn. |
| Respond to a permission | Accepted while the request is pending; the answer is an outgoing ACP line. |
| Stop | Accepted while the execution exists (`executions.md`). |

### A turn's states

| State | What the log holds |
| --- | --- |
| saved | The Write command and its `session/prompt` line; the line is not sent yet. |
| in progress | The line is sent; no answer yet. |
| done | Its answer, with a `stopReason` other than `cancelled`. |
| cancelled | Its answer, with `stopReason` `cancelled`. |
| failed | An error answer, or an invalid answer. |
| uncertain | No answer, and an `execution.break` that was not clean after the line was written: the connection dropped, or Agora stopped without closing it. |

An uncertain turn is never resent. It changes state only on proof: its answer — `cancelled` once
a Cancel reaches a turn still running — or the end of the execution.

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
| Version | Each projector has a version. A checkpoint records, per projector and Workstream, the version and the last position folded; a checkpoint from another version counts as none, and the projector rebuilds from the first entry. |
| Same transaction | Views and their checkpoint are written together. |
| Rebuild | Gives the same identities and the same rows as the incremental run, checked by a hash of the rows that does not depend on their order. |

### The thread

What the client reads (`assistant-ui.md`, "A workstream's thread").

| Rule | Detail |
| --- | --- |
| Update | Each change to a view appends an update to the Workstream's thread: its position, the operation (`upsert` with the whole object, or `remove`), the object's kind and id. |
| Positions | Strictly increasing and never reused. A rebuild appends `reset`, then every object again; it never truncates. |
| Reading | From a position: first the current state of what changed since, then each update. Nothing lost, nothing twice. |

## An execution's memory

What a restarted Agora reads to take each execution back:

| Needed | From |
| --- | --- |
| Which executions exist | The claims Agora manages (`app.kubernetes.io/managed-by=agora`). |
| Request id, pool, settings, anchor to restore | The Create command. |
| Bridge instance | The last `execution.connected`. |
| The agent's capabilities | The answer to Agora's `initialize`. |
| Session | The last `session.opened` not ended. |
| Turn in progress, and its start | The last `session/prompt` line without an answer, and the time it was written. |
| Idle since | The time of the last answer to a `session/prompt`. |
| Stop | The Stop command. |

Every execution belongs to a Workstream; the lab creates one per execution. The claim carries
only its pool, its deadline and its labels (`executions.md`).

## Storage

| Table | Key | Holds |
| --- | --- | --- |
| `workstreams` | id | Owner, title, last position. |
| `entries` | Workstream, position | Kind, execution, Session, content (`jsonb`), the ACP columns, time. |
| `commands` | Workstream, command id | Kind, SHA-256 of the body, answer, position of its entry. |
| `sessions` | id | Workstream, execution, ACP session id, positions where it opened and ended. |
| `diagnostics` | id | Execution, direction, reason, size, SHA-256, time. |
| `anchors` | id | Execution, Session, harness, pool, format, files, content (`bytea`). |
| `turns`, `elements`, `notices` | Object id | The object, first and last position folded. |
| `thread` | Workstream, position | Operation, object kind and id, the object. |
| `checkpoints` | Projector, Workstream | Version, last position folded. |

| Role | May | May not |
| --- | --- | --- |
| `agora_writer` | Insert entries, commands, Sessions, diagnostics, anchors; move a Workstream's last position. | Update or delete an entry. |
| `agora_projector` | Read entries; write views, the thread and checkpoints. | Write entries, commands or anchors. |

| Rule | Detail |
| --- | --- |
| Connections | Every role is NOLOGIN; the server connects with one login per role. |
| `bigint` | The driver reads `bigint` as a number, set once for every connection. |
| Tests | Run under these roles, never as a superuser; each run has its own database. |

## Cases to validate

| # | Case | Expected | Measured |
| --- | --- | --- | --- |
| L1 | A line carrying `9007199254740993` and members Agora does not know | Read back as text, identical. | — |
| L2 | Two identical lines | Two entries. | — |
| L3 | An invalid line: batch, wrong direction, unsafe id | A diagnostic without content; no entry; not handled. | — |
| L4 | An invalid answer to Agora's request | The request fails with the reason. | — |
| L5 | An extension method, an unknown `session/update` type | Entries; generic elements. | — |
| L6 | The write of an outgoing line fails | Nothing is sent. | — |
| L7 | PostgreSQL stops during a turn | The adapter waits; nothing lost; the turn goes on once it is back. | — |
| L8 | Write during a turn, then during an uncertain turn | Refused; nothing written. | — |
| L9 | A command replayed with the same id, then another body | Same answer, one entry; then refused. | — |
| L10 | A break that is not clean during a turn | The turn is uncertain; its answer, if it arrives, closes it. | — |
| L11 | Cancel on an uncertain turn still running | `cancelled`; Write accepted again. | — |
| L12 | Restore from an anchor | A new Session, same ACP session id. | — |
| L13 | Change the model | Same Session. | — |
| L14 | Agora restarted cleanly during a turn | Everything found from the log; the claim carries only pool and deadline; the turn stays in progress and closes. | — |
| L15 | Agora killed during a turn | The turn is uncertain until its answer arrives. | — |
| L16 | Rebuild against incremental, on a real claude-code transcript | Same identities, same hash. | — |
| L17 | A projector's version changes | Rebuild; `reset` in the thread; positions go on. | — |
| L18 | The client reads from a position | No gap, no duplicate. | — |
| L19 | Roles | The projector cannot write an entry; the writer cannot update or delete one. | — |

**To be specified:** releasing an uncertain turn without stopping the execution; the applied
configuration (model, effort) as a view; retention, and deleting a Workstream; who may read and
write a Workstream; what an operational log line may carry; seeding a new context with history
when no anchor can be restored.

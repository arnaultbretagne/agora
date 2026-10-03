# The client

Contract to implement — `@assistant-ui/react` **0.15.23** (`@assistant-ui/core` 0.3.22), React
19, pinned exactly. The objects it reads are the log's views (`log.md`, "Views"); the choice of
assistant-ui and the options studied before it are in the interface ADR.

**Agora owns the thread and the commands. The client displays what the thread holds and turns the
user's actions into commands.**

## Who does what

| Part | Role |
| --- | --- |
| The server (`apps/server`) | Serves the client at `/` and the API under `/api` (`log.md`, "HTTP"), behind the identity proxy. Projects the log into the objects the client reads, and applies the commands. |
| The client (`apps/web`) | Holds the objects of the Workstream on screen and the Workstream list, converts them into assistant-ui messages, and sends the commands. |
| assistant-ui | `useExternalStoreRuntime`, the primitives, and the registry components. |

Registry components are copied into `apps/web` (`npx assistant-ui add <name>`, shadcn model) and
modified freely. Only `@assistant-ui/react` and `@assistant-ui/react-markdown` are dependencies.

The client invents no state. Even the message the user just wrote appears only once the server
has saved it. A command's effect is read in the thread, never in the answer to the command.

One operator: the server sits behind the identity proxy (Pocket-ID), and the list shows every
Workstream.

## The exchanges

| Exchange | Route | Content |
| --- | --- | --- |
| Workstreams | `GET /api/workstreams` | Every Workstream's view, the most recently active first. Read again whenever the thread on screen changes, and every 10 seconds. |
| Harnesses | `GET /api/pools` | The catalogue: pool, harness, ready replicas (`executions.md`). The choice offered for a new execution. |
| A new Workstream | `POST /api/workstreams` | Its id, chosen by the client; the owner is the identity the proxy passes. |
| A Workstream's thread | `GET /api/workstreams/{id}/thread?after=C` | Server-sent events: `snapshot` rows, `snapshot-end`, then `live` rows (`log.md`, "The thread"). |
| Commands | `POST /api/workstreams/{id}/commands` | Below. |

| Thread rule | Detail |
| --- | --- |
| Parsing | Each event's data is parsed losslessly; a position is a decimal string, compared as an integer. |
| Cursor | Advances at `snapshot-end`, then with each `live` row applied; stored in the browser with the objects it belongs to, and reused only with them. An empty browser starts at zero. |
| Snapshot | Rows replace or remove whole objects. A `reset` clears the objects before the complete state is applied. A snapshot cut before its end is read again from the same cursor. |
| Reconnection | On an error or a close, the stream is opened again from the last cursor, after 1 s, then doubling up to 10 s. Opening, reloading and reconnecting give the same objects, with no change skipped or applied twice. |
| Commands | Disabled until `snapshot-end`. |

## The objects

What the client reads of each view object. Every object also carries `id`, `firstPosition` and
`lastPosition`.

| Kind | Fields read |
| --- | --- |
| `workstream` | `title`, `state`, `pool`, `harness`, `execution`, `session`, `anchor` |
| `turn` | `status`, `session`, `requestPosition`, `stopReason`, `failure` |
| `element` | `type`, `turn`, `session`, and per type below |
| `notice` | `type`, `reason`, `origin`, `harness` |

## Commands

Each command carries an id chosen by the client, kept when the same action is retried after a
network failure: replayed, it runs once. The answer is *accepted*, or *refused* with a reason
(`log.md`, "Commands"), shown where the action was made; the thread is not touched.

| Command | Target | Body | Offered |
| --- | --- | --- | --- |
| Create | — | `pool`, from the catalogue; `anchor`, to continue | Without an execution, or once it has ended. |
| Write | `execution`, `session` | `prompt`: one `text` block | When sending is open (below). |
| Cancel | `execution`, `turn` | — | For the turn in progress or uncertain. |
| RespondPermission | `execution`, `session`, `requestPosition` | `requestId`, and `outcome`: `selected` with the `optionId` | For the pending permission. |
| Stop | `execution` | — | For an execution neither stopped nor ended. |

## The Workstream's state

The view's `state` (`log.md`, "The Workstream view") decides what the screen offers.

| `state` | Badge | Composer |
| --- | --- | --- |
| `none` | — | Replaced by the harness choice: **Create**. |
| `starting` | starting | Closed: "Starting the sandbox…" |
| `ready` | ready | Open, unless a turn or a permission holds it (below). |
| `interrupted` | reconnecting | Closed: "Connection to the sandbox lost, reconnecting…" |
| `stopped` | stopped | Closed: "Stopped. The sandbox ends at its deadline." |
| `lost` | lost | Closed: "The sandbox was lost." |
| `failed` | failed | Closed: "The execution could not start." |
| `ended` | ended | Replaced by **Continue** (Create with the view's `pool` and `anchor`) when there is an anchor, and **New execution** (the harness choice). |

Sending is open when the snapshot is complete, the state is `ready`, no turn is saved, in progress
or uncertain, and no permission is pending. Otherwise the reason shows above the composer:
the state's, then "Answer the permission request first.", then the uncertain turn's banner.

## The connection point: `useExternalStoreRuntime`

The only point of contact between Agora's objects and assistant-ui.

| Property | Fed by |
| --- | --- |
| `messages` + `convertMessage` | The turns and notices, in position order (below). |
| `isRunning` | The last turn is saved or in progress. |
| `isSendDisabled` | Sending is not open. |
| `isDisabled` | The state is `none` or `ended`: the thread stays readable, the composer is replaced. |
| `onNew` | **Write**, with the composer's text. |
| `onCancel` | **Cancel**, targeting the turn in progress or uncertain. |
| `onRespondToToolApproval` | **RespondPermission**: `approvalId` is the permission element's id, which gives the target and `requestId`; `optionId` is the ACP option chosen. |
| `adapters.threadList` | `threads`: the Workstreams, with `title`, and `state` and `harness` in `custom`; `threadId`: the one on screen; `onSwitchToThread`: opens it; `onSwitchToNewThread`: a new Workstream, then the harness choice. |

Not provided, so absent from the interface: `onEdit`, `onReload`, `onDelete`, `setMessages`,
`queue`, `suggestions`, and the `attachments`, `feedback`, `speech`, `dictation` adapters.

## Messages

| From | Message | Placed at |
| --- | --- | --- |
| A turn | A `user` message, id `{turn}:user`, from the text blocks of its `user` element; then an `assistant` message, id `{turn}:assistant`, from its other elements in position order. | The turn's `requestPosition`. |
| A notice | A `system` message, id the notice's. | Its `firstPosition`. |

Elements with no turn, `user_message_chunk` elements and `acp` elements are not shown.

### A turn's states

| `status` | User message | Assistant message `status` |
| --- | --- | --- |
| `saved` | "saved" badge | `running`, empty: an indicator |
| `in_progress` | — | `running` |
| `done` | — | `complete` |
| `cancelled` | — | `incomplete`, reason `cancelled` |
| `failed` | — | `incomplete`, reason `error`, with the failure: the agent's error message, or the closed reason |
| `uncertain` | "uncertain" badge | `incomplete`, reason `other`, "The end of this turn could not be confirmed." |

An uncertain turn is never resent. Its banner offers **Cancel** for that turn and **Stop**; it
changes state only on proof. The turn's status travels in the user message's `metadata.custom`;
reloading rebuilds both from the thread.

### Parts of a response

| Element `type` | Part | Component |
| --- | --- | --- |
| `agent_message_chunk` | `text`: its `text` | `MarkdownText` (registry) |
| `agent_thought_chunk` | `reasoning`: its `text` | `Reasoning` (registry), grouped |
| `tool` | `tool-call` (below) | `ToolFallback` (registry), showing the title; consecutive tools grouped by `ToolGroup` (registry) |
| `tool` with a `diff` content | the same | `DiffViewer` (registry `code-diff`) for each diff |
| `permission` | the `approval` of the tool call with the same `toolCallId`; a tool call of its own, from `params.toolCall`, when there is none | the approval buttons of `ToolFallback` |
| `plan` | `data` named `plan`: its `entries` | `TodoList` (registry `todo-list`) |

| `tool-call` field | From the `tool` element |
| --- | --- |
| `toolCallId` | `toolCallId` |
| `toolName` | `kind`, or `other` |
| `args` | `rawInput`, or nothing |
| `result` | `rawOutput`, or the text of its `content` blocks |
| `isError` | `status` `failed` |
| `artifact` | `title`, `locations`, and its `diff` contents |
| running | `status` `pending` or `in_progress` |

| `approval` field | From the `permission` element |
| --- | --- |
| `id` | its id |
| `options` | `params.options`: `optionId` → `id`, `name` → `label`, `kind` with its underscore turned into a dash (`allow_once` → `allow-once`, and likewise `allow-always`, `reject-once`, `reject-always`) |
| `optionId` | `answer.outcome.optionId`, once `answered` |
| `resolution` | `cancelled`, when its `status` is `cancelled` |

| Plan entry `status` | `TodoList` |
| --- | --- |
| `pending` | `pending` |
| `in_progress` | `active` |
| `completed` | `done` |

### Notices

| `type` | Text |
| --- | --- |
| `session.opened`, `origin` `new`, the Workstream's first | "Session started with {harness}." |
| `session.opened`, `origin` `new`, after another | "New session: the agent does not know the history above." |
| `session.opened`, `origin` an anchor | "Session restored: the agent remembers the history above." |
| `session.ended` | "Session ended ({reason})." |
| `execution.break` | "Connection to the sandbox lost, reconnecting…" |
| `request.failed` | "A request failed ({reason})." |
| `execution.lost` | "The sandbox was lost ({reason}). The history is kept." |
| `execution.failed` | "The execution could not start ({reason})." |
| `execution.ended` | "The execution has ended." |

## The screen

| Area | Element | Component |
| --- | --- | --- |
| Sidebar | Workstream list | `ThreadList` (registry), with the state badge |
| Sidebar | New Workstream | `ThreadListPrimitive.New`, then the harness choice (**ours**) |
| Header | Title, harness, state badge, **Stop** | **ours** |
| Thread | Container, scrolling | `Thread` (registry) |
| Thread | User message, with the turn badge | `UserMessage` (in `Thread`) |
| Thread | Response | `AssistantMessage` (in `Thread`); the turn's failure in `MessagePrimitive.Error` |
| Thread | Notice | `Notice` (**ours**), for `system` messages |
| Thread | Connection to the server | `ConnectionState` (registry `connection-state`): the stream's state in the browser |
| Composer | Input, Send, Cancel | `ComposerPrimitive.Input`, `.Send`, `.Cancel` |
| Composer | Why sending is closed | banner (**ours**) |
| Composer | Uncertain turn: **Cancel**, **Stop** | banner (**ours**) |
| Composer | **Continue**, **New execution** | panel (**ours**), replacing the composer |

`Thread` renders every non-`user` message as a response: the `system` case goes to `Notice`.
Removed from the copied components: `BranchPicker`, the Edit, Reload and Feedback actions,
`EditComposer`, attachments and dictation. Copy stays. Every string is in English.

## Outside this contract, already available

| Future need | Existing component |
| --- | --- |
| Switch model or mode | `ModelSelector` (registry) |
| Slash commands (ACP `available_commands_update`) | `ComposerTriggerPopover` (registry) |
| Context consumption (ACP `usage_update`) | `ContextDisplay` (registry) |
| Attachments | `Attachment` (registry) |

What each registry element can receive from ACP is in `assistant-ui-elements.md`.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| U1 | A Workstream's objects read from zero, then again from its cursor | The same messages, in position order; commands disabled before `snapshot-end`. |
| U2 | A turn saved, in progress, then done | A "saved" badge and an empty running response; then running; then complete, its text and reasoning in order. |
| U3 | An uncertain turn | The "uncertain" badge; the response incomplete with its explanation; sending closed; Cancel targeting that turn and Stop offered. |
| U4 | A permission pending, answered; another pending when its turn is cancelled | The approval on its tool call, its four options with dashed kinds; then the option answered; then `resolution` `cancelled`. |
| U5 | A tool through its updates, an edit with a diff, a plan | One tool call, merged, with its title, result and error; the diff; the plan's statuses mapped. |
| U6 | A `reset` in the stream | The objects cleared, the complete state applied, no message twice. |
| U7 | A command refused | Its reason shown; the objects unchanged. |
| U8 | The stream cut, then back | Opened again from the last cursor; no change skipped or applied twice. |
| U9 | An execution ended with an anchor | **Continue** sends Create with the view's pool and anchor; the restored Session's notice follows. |
| U10 | Each notice type | Its text, with its harness and reason. |
| U11 | Each Workstream state | Its badge, and the composer's state and reason. |

**To be specified:** pagination of long threads; several operators, and who may read and write a
Workstream; showing protocol elements (`acp`); model selection and slash commands; elements
outside a turn (a `session/load` replay).

References: [ExternalStoreAdapter](https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/runtimes/external-store/external-store-adapter.ts),
[component registry](https://r.assistant-ui.com/registry.json).

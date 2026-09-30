# Agora ↔ assistant-ui interface

Contract to implement — `@assistant-ui/react` **0.15.21**.

**Agora owns the thread and the commands. assistant-ui displays the thread and passes
up the user's actions.**

The choice of assistant-ui and the options studied before it are in the interface ADR.

## Who does what

- **The Agora server** projects the ACP log into turns, elements and notices, in the
  database, and applies the commands.
- **The Agora client** holds the received thread in memory, converts it into
  assistant-ui messages and turns actions into commands.
- **assistant-ui** provides the `useExternalStoreRuntime` runtime, the primitives
  and the registry components.

Registry components are copied into Agora's code (`npx assistant-ui add <name>`,
shadcn model): we modify them freely. Only `@assistant-ui/react` and its runtime
are dependencies.

The interface invents no state. Even the message the user just wrote appears only
once the server has saved it. A command's effect is read in the thread, never in
the response to the command.

## The three exchanges

| Exchange | Content |
| --- | --- |
| **Workstream list** | Simple read: id, title, execution state. |
| **A workstream's thread** | A single stream, opened from the last completed cursor (zero at first). A consistent snapshot gives the latest state/removal of objects changed through high-water mark H, then snapshot-end carrying H, then live changes after H. Each update replaces a whole object: workstream, turn, element or notice. |
| **Commands** | Create, Write, Cancel, Respond to a permission, Stop. |

Each live update carries a strictly increasing position, encoded as a decimal string and
compared losslessly. The client advances its snapshot cursor only at snapshot-end, then applies
each live object and its cursor together. A reset clears the objects before a complete snapshot
is applied. An interrupted snapshot may be redelivered; whole-object replacements and removals
are idempotent. A cursor is reused only with its matching object state; an empty browser starts
at zero. Commands stay disabled until snapshot-end. Opening, reloading and reconnecting have
the same result, with no skipped change or duplicate object. The exact snapshot and tail rules
are in `log.md`.

Each command carries an id chosen by the interface. If replayed, it runs only once.
The server's response is *accepted* or *refused, with the reason*.

| Command | Carries | Rule |
| --- | --- | --- |
| **Create** | the harness chosen among the allowed options | — |
| **Write** | the text | Refused if a turn is saved, in progress or uncertain, sending is closed, or configuration application/readiness is unresolved. |
| **Cancel** | the targeted turn id | Available for an in-progress or uncertain turn. No effect if that turn is over; never touches the next turn. Sending Cancel alone does not prove completion. |
| **Respond to a permission** | the request and the chosen option | Refused if the request is no longer pending. |
| **Stop** | — | Closes sending and stops renewing the deadline; the execution disappears when the infrastructure destroys it (`executions.md`). |

## The connection point: `useExternalStoreRuntime`

It is the only point of contact between Agora's data and assistant-ui.

| Property | Fed by |
| --- | --- |
| `messages` + `convertMessage` | The thread's turns and notices. A turn gives a `user` message and an `assistant` message; a notice gives a `system` message. |
| `isRunning` | The last turn is saved or in progress. |
| `isSendDisabled` | Sending closed: execution starting/in error/stopped, storage unavailable, an unresolved saved/in-progress/uncertain turn, or configuration pending/applying/failed. Also disabled while the thread snapshot is incomplete. The server's Workstream view supplies the closure reason. |
| `isDisabled` | Workstream stopped: the thread stays readable. |
| `onNew` | **Write** |
| `onCancel` | **Cancel**, carrying the in-progress turn id known to the interface. The uncertain-turn action uses the same targeted command handler. |
| `onRespondToToolApproval` | **Respond to a permission**: `approvalId` = the request, `optionId` = the choice. |
| `adapters.threadList` | The workstream list (see the sidebar). |

Not provided, so the features are absent from the interface: `onEdit`, `onReload`,
`onDelete`, `setMessages`, `queue`, `suggestions` and the `attachments`,
`feedback`, `speech`, `dictation` adapters.

## Requested and applied configuration

The Workstream projection supplies requested and applied values for model, effort and authorized
resource access, plus the application state. The interface preserves that distinction across
reloads; selecting a value or receiving an accepted request does not display it as applied.
Changes requested during a turn take effect before the next turn, as specified in `log.md`.

| Application state | Display | Actions |
| --- | --- | --- |
| Ready | Confirmed model, effort and resource access. | Write follows normal execution/turn admission. |
| Pending | Requested values alongside the applied values; "Applies before the next turn". | The current turn continues. The next Write stays disabled until confirmation. |
| Applying | "Applying configuration" with the last confirmed and requested values. | Write disabled; Stop remains available. |
| Failed or outcome unknown | Requested values and a visible application error; do not label partial effects as the applied revision. | Write disabled; Stop remains available. An explicit replacement request may supersede the failed desired revision at a safe boundary. |

Cancel and permission answers retain their existing rules during a turn. The interface never
uses a client timer, a clicked Cancel or the disappearance of the running indicator as proof
that configuration can be applied. It sends requests to Agora, not ACP or bridge operations.
Product access is derived from provisioned resource bindings; raw profiles, JWTs, expiry and
tunnel-reset controls are not exposed to the user.

Configuration controls use Agora's projected state outside the assistant-ui runtime adapter;
this contract adds no library callback. Their request schema must be specified with the
configuration command/entry schemas in `log.md`. Configuration changes and JWT renewal preserve
the displayed thread and Session. Their end-to-end cases are separate acceptance requirements,
not validated by the existing uncertain-turn/reload browser test.

## A turn's states

| Turn | User message | Response (`status`) |
| --- | --- | --- |
| **saved** — written by Agora, not yet sent | "saved" badge | `running`, empty: ● indicator |
| **in progress** — dispatch begun, completion not yet confirmed | — | `running` |
| **done** — the agent has finished | — | `complete` |
| **cancelled** — stopped on request | — | `incomplete` / `cancelled`; a pending permission moves to `resolution: cancelled` |
| **failed** — valid agent error, proven failure before dispatch, or execution lost/ended before the answer | — | `incomplete` / `error`, with the recorded error or interruption explanation |
| **uncertain** — completion could not be proved after a break, local transport failure, timeout or invalid answer | "uncertain" badge, clearly visible; Write disabled with reason | `incomplete` / `other`, with the explanation; targeted Cancel and Stop stay available |

An uncertain turn is never resent automatically. It changes state only on proof.
The turn's state and any local failure class travel in the user message's `metadata.custom`.
An invalid answer produces a failure notice and keeps the turn uncertain; it is not presented
as a completed agent error. Reloading reconstructs both from the thread.

## The screen, area by area

### Sidebar

| Element | Component | Wiring |
| --- | --- | --- |
| Workstream list | `ThreadList` (registry) | `threadList.threads`: id, title; execution state in `custom` |
| Open a workstream | `ThreadListItemPrimitive.Trigger` | `onSwitchToThread` → opens the thread |
| New workstream | `ThreadListPrimitive.New` + harness choice (**ours**) | `onSwitchToNewThread` → choice → **Create** |
| Execution state | `Badge` (registry) | starting, available, error, stopped |

### Thread

| Element | Component | Wiring |
| --- | --- | --- |
| Container, scrolling | `Thread` (registry) | — |
| User message | `UserMessage` (in `Thread`) + turn state badge | `role: user` |
| Agent response | `AssistantMessage` (in `Thread`) | `role: assistant`, `status` according to the turn's states |
| Turn error | `MessagePrimitive.Error` (already in `AssistantMessage`) | failed turn |
| Notice | `Notice` (**ours**) | `role: system`, code in `metadata.custom` |
| Execution starting, execution error | execution banner (**ours**) | the workstream's execution state |
| Thread connection lost | `ConnectionState` (registry `elements-connection-state`) | stream state in the browser, not Agora data |

`Thread` currently renders every non-`user` message as a response: we add the
`system` → `Notice` case.

Notices: session started, session ended, context lost, harness lost, local request failure.

### Blocks of a response

Built on the server, in the database, from the ACP log.

| Element | Built from | assistant-ui part | Component |
| --- | --- | --- | --- |
| **Text** | consecutive message chunks | `text` | `MarkdownText` (registry) |
| **Reasoning** | consecutive thought chunks | `reasoning` | `Reasoning` (registry), grouped automatically |
| **Tool** | the call then its updates, merged | `tool-call` | `ToolFallback` (registry), modified to show the title; consecutive tools grouped by `ToolGroup` (registry) |
| **`edit` tool** | same | same | `DiffViewer` (registry) via `makeAssistantToolUI` |
| **`execute` tool** | same | same | `TerminalBlock` (registry `elements-terminal-block`) via `makeAssistantToolUI` |
| **Permission** | the ACP request, attached to its tool | `approval` field of the `tool-call` | buttons already in `ToolFallback` |
| **Plan** | the last plan received in the turn | `data` named `plan` | `TodoList` (registry `elements-todo-list`) via `makeAssistantDataUI` |

Field mappings:

- **Tool** — `toolCallId` = ACP id; `toolName` = ACP kind (`read`, `edit`,
  `execute`…); `args` = input; `result` = result; `isError` = failure;
  `artifact` = title and locations.
- **Diff** — `DiffViewer` receives the ACP diff directly: path, old text,
  new text.
- **Permission** — `approval.id` = the request; `approval.options` = the ACP options.
  The four kinds are identical on both sides: `allow-once`, `allow-always`,
  `reject-once`, `reject-always`. `approval.optionId` = the answer.
- **Plan** — `pending` / `in_progress` / `completed` become `pending` / `active` /
  `done`.

### Composer

| Element | Component | Wiring |
| --- | --- | --- |
| Input | `ComposerPrimitive.Input` | — |
| Send | `ComposerPrimitive.Send` | `onNew` → **Write** |
| Cancel | `ComposerPrimitive.Cancel`, visible while in progress | `onCancel` → **Cancel**, with that turn's id |
| Uncertain turn actions | buttons in the uncertainty banner (**ours**) | **Cancel**, with that turn's id, and **Stop**; available while sending is disabled and `isRunning` is false |
| Closure reason | banner above the composer (**ours**) | sending closed, including configuration pending/applying/failed |

To remove from the copied components: `BranchPicker`, the Edit, Reload and
Feedback actions, `EditComposer`, attachments and dictation. Copy stays.

## Outside this contract, already available

| Future need | Existing component |
| --- | --- |
| Configuration selector presentation | `ModelSelector` (registry); requested/applied state and the between-turn boundary remain Agora's contract. |
| Slash commands (ACP `available_commands`) | `ComposerTriggerPopover` (registry) |
| Context consumption (ACP `usage`) | `ContextDisplay` (registry) |
| Attachments | `Attachment` (registry) |

What each registry element can receive from ACP is in
`assistant-ui-elements.md`.

## The components to write

`Notice`, the harness choice, the turn state badge, the execution banner and the
sending-closed banner with uncertain-turn actions, plus requested/applied configuration state
and its application error. Selector presentation can use registry elements; admission and
confirmation remain server-owned.

**To be specified:** pagination of long threads, and pinning the assistant-ui version —
`adapters.threadList`, `onSwitchToThread` and `onSwitchToNewThread` are marked
unstable in 0.15.

References: [ExternalStoreAdapter](https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/runtimes/external-store/external-store-adapter.ts),
[component registry](https://r.assistant-ui.com/registry.json).

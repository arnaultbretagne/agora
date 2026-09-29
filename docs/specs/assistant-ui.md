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
| **A workstream's thread** | A single stream, opened from the last known position (zero at first). It first sends the current state of what has changed since, then each change. Each update replaces a whole object: workstream, turn, element or notice. |
| **Commands** | Create, Write, Cancel, Respond to a permission, Stop. |

Each thread update carries a strictly increasing position. Opening, reloading and
reconnecting are the same action: nothing is lost, nothing is received twice.

Each command carries an id chosen by the interface. If replayed, it runs only once.
The server's response is *accepted* or *refused, with the reason*.

| Command | Carries | Rule |
| --- | --- | --- |
| **Create** | the harness chosen among the allowed options | — |
| **Write** | the text | Refused if a turn is saved, in progress or uncertain, or if sending is closed. |
| **Cancel** | the targeted turn | No effect if that turn is over; never touches the next turn. |
| **Respond to a permission** | the request and the chosen option | Refused if the request is no longer pending. |
| **Stop** | — | Closes sending and stops renewing the deadline; the execution disappears when the infrastructure destroys it (`executions.md`). |

## The connection point: `useExternalStoreRuntime`

It is the only point of contact between Agora's data and assistant-ui.

| Property | Fed by |
| --- | --- |
| `messages` + `convertMessage` | The thread's turns and notices. A turn gives a `user` message and an `assistant` message; a notice gives a `system` message. |
| `isRunning` | The last turn is saved or in progress. |
| `isSendDisabled` | Sending closed: execution starting or in error, storage unavailable. |
| `isDisabled` | Workstream stopped: the thread stays readable. |
| `onNew` | **Write** |
| `onCancel` | **Cancel**, on the in-progress turn known to the interface. |
| `onRespondToToolApproval` | **Respond to a permission**: `approvalId` = the request, `optionId` = the choice. |
| `adapters.threadList` | The workstream list (see the sidebar). |

Not provided, so the features are absent from the interface: `onEdit`, `onReload`,
`onDelete`, `setMessages`, `queue`, `suggestions` and the `attachments`,
`feedback`, `speech`, `dictation` adapters.

## A turn's states

| Turn | User message | Response (`status`) |
| --- | --- | --- |
| **saved** — written by Agora, not yet sent | "saved" badge | `running`, empty: ● indicator |
| **in progress** — sent, the response is arriving | — | `running` |
| **done** — the agent has finished | — | `complete` |
| **cancelled** — stopped on request | — | `incomplete` / `cancelled`; a pending permission moves to `resolution: cancelled` |
| **failed** — the agent answered with an error | — | `incomplete` / `error`, with the message |
| **uncertain** — the end of the turn could not be seen: the connection dropped, or Agora stopped without closing it | "uncertain" badge, clearly visible | `incomplete` / `other`, with the explanation |

An uncertain turn is never resent automatically. It changes state only on proof.
The turn's state travels in the user message's `metadata.custom`.

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

Notices: session started, session ended, context lost, harness lost.

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
| Stop | `ComposerPrimitive.Cancel`, visible during a turn | `onCancel` → **Cancel** |
| Closure reason | banner above the composer (**ours**) | sending closed |

To remove from the copied components: `BranchPicker`, the Edit, Reload and
Feedback actions, `EditComposer`, attachments and dictation. Copy stays.

## Outside this contract, already available

| Future need | Existing component |
| --- | --- |
| Switch model or mode | `ModelSelector` (registry) |
| Slash commands (ACP `available_commands`) | `ComposerTriggerPopover` (registry) |
| Context consumption (ACP `usage`) | `ContextDisplay` (registry) |
| Attachments | `Attachment` (registry) |

What each registry element can receive from ACP is in
`assistant-ui-elements.md`.

## The components to write

`Notice`, the harness choice, the turn state badge, the execution banner and the
sending-closed banner. Everything else comes from the registry or the primitives.

**To be specified:** pagination of long threads, and pinning the assistant-ui version —
`adapters.threadList`, `onSwitchToThread` and `onSwitchToNewThread` are marked
unstable in 0.15.

References: [ExternalStoreAdapter](https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/runtimes/external-store/external-store-adapter.ts),
[component registry](https://r.assistant-ui.com/registry.json).

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

The client invents no state, but one: the first message of an execution, shown waiting until its
Session opens ("Sending"). Every other message the user writes appears once the server has saved
it. A command's effect is read in the thread, never in the answer to the command.

One operator: the server sits behind the identity proxy (Pocket-ID), and the list shows every
Workstream.

## The exchanges

| Exchange | Route | Content |
| --- | --- | --- |
| Workstreams | `GET /api/workstreams` | The view of every Workstream the signed-in identity owns, the most recently active first. Read again whenever the thread on screen changes, and every 10 seconds. |
| Harnesses | `GET /api/pools` | The catalogue: pool, harness, ready replicas (`executions.md`), and the settings and commands the pool's last Session gave (`log.md`, "HTTP"). The choice offered for a new execution. |
| A new Workstream | `POST /api/workstreams` | On its first message, never before. Its id, chosen by the client; the owner is the identity the proxy passes. |
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
| `workstream` | `title`, `state`, `pool`, `harness`, `execution`, `session`, `anchor`, `settings`, `commands`, `configuring`, `exchanges`, `continuation`, and in the list `changedAt` |
| `turn` | `status`, `session`, `requestPosition`, `stopReason`, `failure` |
| `element` | `type`, `turn`, `session`, and per type below |
| `notice` | `type`, `reason`, `origin`, `harness` |

## Commands

Each command carries an id chosen by the client, kept when the same action is retried after a
network failure: replayed, it runs once. The answer is *accepted*, or *refused* with a reason
(`log.md`, "Commands"), shown where the action was made; the thread is not touched.

| Command | Target | Body | Offered |
| --- | --- | --- | --- |
| Create | — | `pool`, from the catalogue; `settings`, the model and effort picked; `profiles`, the access picked. Never an anchor: the server finds the one it continues from (`log.md`, "Continuing"). | With a message sent while no execution runs ("Sending"). |
| Configure | `execution`, `session` | `configId`, `value` | When sending is open, from the model picker ("Settings and commands"). |
| Scope | `execution` | `profiles`: the whole access picked | When no turn runs, from the access picker ("Access"). |
| Write | `execution`, `session` | `prompt`: one `text` block | When sending is open (below). |
| Cancel | `execution`, `turn` | — | For the turn in progress or uncertain. |
| RespondPermission | `execution`, `session`, `requestPosition` | `requestId`, and `outcome`: `selected` with the `optionId` | For the pending permission. |
| Stop | `execution` | — | For an execution neither stopped nor ended. |

## The Workstream's state

The view's `state` (`log.md`, "The Workstream view") decides what the screen offers. Its label shows
in the header, after the harness.

| `state` | Label | Composer |
| --- | --- | --- |
| `none` | — | Open: sending starts an execution. |
| `starting` | starting | Closed: "Starting the sandbox…" |
| `ready` | ready | Open, unless a turn or a permission holds it (below). |
| `interrupted` | reconnecting | Closed: "Reconnecting to the sandbox…" |
| `stopped` | stopped | Closed: "Stopped. The sandbox ends at its deadline." |
| `lost` | lost | Closed: "The sandbox was lost. It ends at its deadline; then a new one can start." |
| `failed` | failed | Open: sending starts a new execution. |
| `ended` | ended | Open: sending starts a new execution, which continues the Workstream. |

In `ready`, sending is open when the snapshot is complete, no turn is saved, in progress or
uncertain, no permission is pending, and no setting is being changed. Otherwise the reason shows
above the composer: the state's, then "Answer the permission request above.", then "Applying the
settings…", then the uncertain turn's banner.

## Sending

A new Workstream is a draft at `/`, with no id and nothing on the server. Sending is open at once,
and, as in `none`, `failed` and `ended`, it starts an execution:

| Step | What happens |
| --- | --- |
| The harness | Picked inside the composer, among the catalogue's pools but those kept for the tests (`testing`). Offered first: the one picked in this Workstream; else the Workstream's own pool, or one of its harness once that pool is gone with an older image; else, in a draft, the one picked last, remembered in the browser; else the first. A harness with an anchor in the Workstream (`continuation`) is noted "continues its saved session". |
| The Workstream | A draft gets its id and `POST /api/workstreams`, then its address `/w/{id}`. |
| What the agent will be given | Above the composer, when the Workstream has exchanges (`exchanges`) and the harness picked has no anchor holding them all: "{Harness} resumes its saved session; the {n} exchanges since then go to it as text.", from its `continuation`; with none, "No saved {Harness} session: the {n} exchanges above go to the agent as text." One exchange: "the 1 exchange … goes". Nothing when its anchor holds them all. |
| Create | `pool`; `settings`: the model and effort picked, if any; `profiles`: the access picked, if any ("Access"). |
| The message | Shown at once, noted "waiting for the sandbox", the response "starting {harness}". Written (**Write**) once that execution's state is `ready` with its Session. |
| A failure | A refused Create, or the execution `failed`, `ended` or `lost` before its Session opens: the message goes back into the composer, with "The sandbox could not start. Your message is back in the composer." |

## Settings and commands

What an agent offers to change, and the commands it runs, come from its Session (`log.md`, "The
Workstream view": `settings`, `commands`). A draft has no Session: it shows what the pool's last
Session gave (`GET /api/pools`).

| Element | Rule |
| --- | --- |
| The model | A picker beside the harness: the options of the setting in category `model`, without the value `default`, by their full names as the agent gives them ("Opus 5.5"), nothing more; the current one shown. In a draft, the choice goes into the Create's `settings`. In an open Session, choosing one sends **Configure**; sending waits for its answer. |
| The effort | In the same picker, under the model: the options of the setting in category `thought_level`, without `default`. Chosen like the model. |
| The mode and other settings | Not offered: each pool starts its Sessions in the mode it declares (`executions.md`, "The API"), full access. |
| Commands | `/` at the start of the composer lists the commands — name, description, its input's hint — filtered by what follows it; arrows move, Enter or Tab chooses, Escape hides. Choosing one puts `/{name} ` in the composer. Sent as the prompt's text: that is how ACP runs a command. |

## Access

What the agent may reach beyond its harness's own service: the profiles Agora offers
(`GET /api/config`, `credentials.offered`; `credentials.md`, "Offered profiles"). Its own grants
are the execution's (`log.md`, "The Workstream view": `profiles`).

| Element | Rule |
| --- | --- |
| The picker | After the model, when anything is offered. Each offered repository by its `owner/repo`, with **None**, **Read** and, when offered, **Write**; an offered service by its name — `internet` as "Internet" —, with **Off** and **On**. The choices stay open in the menu, one after the other. The button: "No access", the one repository and its access ("agora · Write"), the one service ("Internet"), or how many ("3 repos", "2 grants"). |
| Before an execution | The choice goes into the Create's `profiles`. It starts empty in a draft; when sending continues an ended or failed execution, from that execution's `profiles`. |
| During an execution | Each choice sends **Scope** with the whole set; shown at once, until the view has it, or back as it was if refused. Closed while a turn runs or is uncertain, and once the execution is stopped or lost. |

## The connection point: `useExternalStoreRuntime`

The only point of contact between Agora's objects and assistant-ui.

| Property | Fed by |
| --- | --- |
| `messages` + `convertMessage` | The turns and notices, in position order (below), and a first message while it waits. |
| `isRunning` | The last turn is saved or in progress, or a first message waits. |
| `isSendDisabled` | Sending is not open, or a first message waits. |
| `onNew` | **Write**, with the composer's text; with no execution running, the steps of "Sending". |
| `onCancel` | **Cancel**, targeting the turn in progress or uncertain. |

The Workstream list and the permission card are the client's own: they call the server without
the runtime (**RespondPermission** with the option chosen).

Not provided, so absent from the interface: `onEdit`, `onReload`, `onDelete`, `setMessages`,
`queue`, `suggestions`, the thread list adapter, and the `attachments`, `feedback`, `speech`,
`dictation` adapters.

## Messages

| From | Message | Placed at |
| --- | --- | --- |
| A turn | A `user` message, id `{turn}:user`, from the text blocks of its `user` element; then an `assistant` message, id `{turn}:assistant`, from its other elements in position order. | The turn's `requestPosition`. |
| A notice | A `system` message, id the notice's. | Its `firstPosition`. |

Elements with no turn, `user_message_chunk` elements and `acp` elements are not shown.

### A turn's states

| `status` | User message | Assistant message `status` |
| --- | --- | --- |
| `saved` | "queued" note | `running`, empty: a "working" line |
| `in_progress` | — | `running` |
| `done` | — | `complete` |
| `cancelled` | "cancelled" note | `incomplete`, reason `cancelled` |
| `failed` | — | `incomplete`, reason `error`, with the failure: the agent's error message, or the closed reason |
| `uncertain` | "uncertain" note | `incomplete`, reason `other`, "The end of this turn could not be confirmed." |

An uncertain turn is never resent. Its banner offers **Cancel** for that turn and **Stop**; it
changes state only on proof. The turn's status travels in the user message's `metadata.custom`;
reloading rebuilds both from the thread.

### Parts of a response

A response's steps follow assistant-ui's trace grammar: one monospace line each, a `>` that turns
when the line opens, a shimmer while it runs, a quiet note on the right.

| Element `type` | Part | Shown as |
| --- | --- | --- |
| `agent_message_chunk` | `text`: its `text` | `MarkdownText` (registry) |
| `agent_thought_chunk` | `reasoning`: its `text`; consecutive ones grouped | a "reasoning" line ("thinking" while it runs), opening onto the text |
| `tool` | `tool-call` (below) | its line (below), opening onto its todo list, its diffs (`DiffViewer`, registry), its output, or else its command or input |
| `permission` | the `approval` of the tool call with the same `toolCallId`; a tool call of its own, from `params.toolCall`, when there is none | while pending, a card under the tool's line: the agent's options, in its order, by its names |
| `plan` | `data` named `plan`: its `entries` | a "plan" line noted done/total, open, onto the entries |

| `tool-call` field | From the `tool` element |
| --- | --- |
| `toolCallId` | `toolCallId` |
| `toolName` | `kind`, or `other` |
| `args` | `rawInput`, or nothing |
| `result` | `rawOutput`, or the text of its `content` blocks |
| `isError` | `status` `failed` |
| `artifact` | `title`, `kind`, `status`, `locations`; its `diff` contents, or else those of its permission's `params.toolCall`; `todos`, the entries of `rawInput.todos` that have a `content` |
| running | `status` `pending` or `in_progress` |

| `approval` field | From the `permission` element |
| --- | --- |
| `id` | its id |
| `options` | `params.options`: `optionId` → `id`, `name` → `label`, `kind` with its underscore turned into a dash (`allow_once` → `allow-once`, and likewise `allow-always`, `reject-once`, `reject-always`) |
| `optionId` | `answer.outcome.optionId`, once `answered` |
| `resolution` | `cancelled`, when its `status` is `cancelled`, or Agora answered it `cancelled` (a Cancel sent while it was pending) |

| A tool's line | Rule |
| --- | --- |
| Label | The tool's title, without the shell an agent wraps a command in (`bash -lc '…'`). A title that is a bare name or a path becomes the action and the file: "Edit fizzbuzz.js" (`read` Read, `edit` Edit, `delete` Delete, `move` Move, `search` Search, `execute` Run, `fetch` Fetch). |
| Tone | Running (`pending`, `in_progress`): shimmer, coral marker. A permission pending: attention. `failed`: red. |
| Note | "waiting for you"; else the answer when it was not a plain allow-once ("allowed for the session", "rejected", "not answered"); else "failed"; else, for a change, the lines added and removed. |
| Open | At first only while a permission is pending. |

| Plan entry `status` | Shown |
| --- | --- |
| `pending` | an empty circle |
| `in_progress` | a turning circle |
| `completed` | a check, the text struck through |

### Notices

A notice is a quiet line between the messages, red for a loss or a failure. No reason code reaches
the screen.

| `type` | Text |
| --- | --- |
| `session.opened`, `origin` `new`, the Workstream's first | "Session started with {harness}." |
| `session.opened`, `origin` `new`, after another | "New session with {harness}: the agent does not know the history above." |
| `session.opened`, `origin` an anchor | "Session restored with {harness}: the agent remembers the history above." |
| `session.opened`, `origin` an anchor, `catchUp` n | "Session restored with {harness}. The {n} exchanges since its last save go to the agent with your next message." |
| `session.opened`, `origin` `new`, `catchUp` n | "New session with {harness}. The {n} exchanges above go to the agent with your next message." With `catchUp` 0, after another: "New session with {harness}." Either count of one: "the 1 exchange … goes". With `omitted` m, before the final stop: " (the {m} exchanges before them left out for length)". |
| `session.ended`, reason `replaced` | "Another session replaced this one." Any other reason is not shown: the execution's own notice says it. |
| `execution.break` | "The connection to the sandbox was interrupted." Not shown when the next notice of the same execution is its loss or its end, which explains it. |
| `request.failed` | `response_timeout` "The agent did not answer in time.", `deadline_refused` "The sandbox's deadline could not be extended.", `transport_error` "A message could not reach the sandbox.", else "A request to the agent failed." |
| `execution.lost` | `adapter_exited` "The agent's process exited", `claim_missing` "The sandbox disappeared", `claim_conflict` and `instance_changed` "The sandbox was replaced", else "The sandbox was lost"; then ". The history is kept." |
| `execution.failed` | `startup_failed` "The sandbox could not start", `restore_failed` "The saved session could not be restored", `anchor_missing` "The saved session was not found", `credentials_refused` "The agent's credentials were refused", else "The execution could not start"; then "." |
| `execution.ended` | "The sandbox has ended." |

Harnesses are named as people name them: `claude-code` Claude Code, `codex` Codex, `opencode`
OpenCode, `mock` Mock agent; another by its own name.

## The screen

The elements follow assistant-ui's base skin, as its home page shows it: a 3rem bar across, a 16rem
sidebar, a thread column of 42rem, hairline borders, no shadows, 13 px controls and 15 px messages.
The colours are the first Agora's: cream, coral and a warm near-black, with its dark mapping. The
theme follows the system until the user toggles it; the choice is remembered in the browser.

| Area | Element | Component |
| --- | --- | --- |
| Sidebar | The brand: the first Agora's mark, a coral colonnade, thinner in the dark; "Agora" in Newsreader | **ours** |
| Sidebar | **New workstream**: the draft at `/`; **Search**, on the titles | **ours** |
| Sidebar | The list: Today, Yesterday, Previous 7 days, Older, by `changedAt`; a Workstream in `none` left out unless open; a dot for `starting` (coral, pulsing), `ready` (green), `interrupted` (amber), `lost` and `failed` (red) | **ours** |
| Header | Title, or a waiting first message; harness · state label; **Stop** while an execution runs and is not stopped; "reconnecting to the server" while the stream is offline; the theme toggle | **ours** |
| Thread | Container, scrolling, scroll to the bottom | `ThreadPrimitive` |
| Thread | A draft: the mark, and "What shall we work on?" in Newsreader, over the composer | **ours** |
| Thread | User message, on the right in a bubble, with its turn's note | `MessagePrimitive` (**ours**) |
| Thread | Response, bare on the page, its parts grouped by `MessagePrimitive.GroupedParts`, the turn's failure under it, Copy on hover | `MessagePrimitive` (**ours**) |
| Thread | Notice, for `system` messages | **ours** |
| Composer | Input, Send, Cancel; a spinner while a first message waits | `ComposerPrimitive` |
| Composer | The harness picker, inside, when sending starts an execution; else the harness's name | **ours** (Radix menu) |
| Composer | The model picker, with the effort, beside it | **ours** (Radix menu) |
| Composer | The access picker, after the model | **ours** (Radix menu) |
| Composer | The commands, over the composer while it starts with `/` | **ours** |
| Composer | Above it: a refusal; the uncertain turn's banner (**Cancel the turn**, **Stop the sandbox**); why sending is closed | **ours** |

A Workstream opens on its last message, as **Scroll to the bottom** leaves it, whether from the list,
from another Workstream or by its address. It stays there while it catches up, unless the user scrolls.

Registry components kept: `MarkdownText`, `DiffViewer`, and the `surfaces` helpers. Every string is
in English.

## On a phone

The client installs on a phone's home screen: a manifest and a 180 px icon name it Agora and open it
at `/` in a window of its own. It asks iOS for an opaque status bar (`default`), coloured like the
page — the toggled theme's, even against the system's — so that nothing of the page passes under it;
a translucent bar would have iOS 26 blur the page's top. iOS reads these tags once, when the icon is
added: an icon added before them keeps its old frame until it is removed and added again.

iOS 26 colours its status bar and Safari's bars after the page, not the `theme-color`: the fixed or
sticky element it finds at each edge, whose background it reads again as it changes, except one that
covers the whole screen, whose first colour it keeps for good. The screen's frame covers it, and so
does the open list of Workstreams; each edge therefore has an element of its own, in the page's colour:
the header at the top, and on a phone a strip at the bottom, under the home indicator. The theme is set
before the first paint, so the first colour is already the theme's.

The screen covers the whole display and keeps clear of its edges: the composer stays above the home
indicator. A phone's keyboard covers the page without resizing it, so the screen follows the visual
viewport: it fills what the keyboard leaves, and the composer rests on the keyboard, the home
indicator's margin dropped while it is up.

Narrower than 32rem, the composer's pickers give their names up for marks. Each name stays in its
menu and in the button's tooltip; the harness menu shows the marks too.

| Picker | Wide | Narrow |
| --- | --- | --- |
| Harness | Its name | Its mark: Claude Code's, Codex's or OpenCode's; a robot for any other |
| Model | The model · the effort | The model; the effort as one to four bars, by its rank among the efforts offered |
| Access | The key and what is granted | The key, with a coral dot when anything is granted |

Below 40rem the header keeps the title and the state, not the harness, and **Stop** is its icon. On a
touch screen the composer's controls are 36 px high, and the search field's text is 16 px, under
which iOS zooms the page in to type.

A touch screen's keyboard comes up with the focus, over half the thread. There the composer waits to be
touched: it never takes the focus itself, whether on opening, on **Scroll to the bottom** or as a turn
starts. With a mouse or a trackpad, it does.

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
| U2 | A turn saved, in progress, then done | A "queued" note and an empty running response; then running; then complete, its text and reasoning in order. |
| U3 | An uncertain turn | The "uncertain" note; the response incomplete with its explanation; sending closed; Cancel targeting that turn and Stop offered. |
| U4 | A permission pending, answered; another pending when its turn is cancelled | The approval on its tool call, its options with dashed kinds; sending closed, "Answer the permission request above."; then the option answered; then `resolution` `cancelled`. |
| U5 | A tool through its updates, an edit with a diff, a plan | One tool call, merged, with its title, result and error; the diff; the plan's statuses mapped. |
| U6 | A `reset` in the stream | The objects cleared, the complete state applied, no message twice. |
| U7 | A command refused | Its reason shown; the objects unchanged. |
| U8 | The stream cut, then back | Opened again from the last cursor; no change skipped or applied twice. |
| U9 | An execution ended with an anchor, then a message | Create with the pool alone; the view's `continuation` names the anchor; nothing said before sending in its harness, every exchange as text in another; the restored Session's notice follows. |
| U10 | Each notice type | Its text, with its harness; a Session's end not shown unless replaced, nor a break its execution's loss follows; no reason code. |
| U11 | Each Workstream state | Its label, whether sending is open and starts an execution, and why it is not. |
| U12 | A real claude-code history: files written and edited, each after a permission | Each change's line labelled with its action and file, its diff taken from its permission, the lines added and removed; each permission answered. |
| U13 | Real codex and opencode histories: shell commands, some failing, a todo list, reasoning | Commands without their shell; the failures marked; the todo list as entries; the reasoning kept. |
| U14 | Workstreams changed today, yesterday, this week, before, and two with no entry | Grouped by day; those with no entry left out unless open; a search keeps the titles that contain it. |
| U15 | A first message, while its execution starts, opens, or fails | Waits; is written once that execution is `ready` with its Session; is given back if it fails, ends or is lost first. |
| U16 | In a browser, **New workstream** from an open Workstream, then Back | The draft at `/`, the greeting, no message of the other; Back: that Workstream and its messages. |
| U17 | In a browser, two Workstreams switched in the list | Each shows its own messages only; the open one marked in the list. |
| U18 | In a browser, a first message from the draft | Nothing on the server before it; then the message at once, the address `/w/{id}`, the agent's answer, the Workstream in the list. |
| U19 | In a browser, a permission | The card with the agent's options; sending closed with its reason; Allow: the agent goes on, the card gone, sending open again. |
| U20 | In a browser, a reload on a Workstream | The same messages, each once. |
| U21 | In a browser, **Stop** | The state `stopped`, **Stop** gone, sending closed with its reason. |
| U22 | In a browser, the theme toggled, the page reloaded, then another browser | Dark, still dark after the reload; light in the other. |
| U23 | In a browser, a Workstream whose execution ended, then a message | Its harness noted "continues its saved session"; the restored Session's notice; the agent recalls the earlier message. |
| U24 | In a browser, a tool with a diff | Its line labelled with its action and file, noted with the lines added and removed; opened, the diff. |
| U25 | A Session's settings: claude-code's, codex's and opencode's | The model's options without `default`, by name, the current one marked; the effort's likewise; no mode offered. |
| U26 | Commands, then `/re` typed | All listed, then those whose name starts with `re`; choosing one gives `/{name} `. |
| U27 | In a browser, a model and an effort picked in the draft, then a first message | The Create carries them; the picker shows them once the Session is ready. |
| U28 | In a browser, another model picked in an open Workstream | Configure sent; the picker shows the new model once answered. |
| U29 | In a browser, `/` typed in the composer | The Session's commands listed; one chosen: `/{name} ` in the composer; sent: the agent receives it. |
| U30 | A catalogue with a pool kept for the tests; an ended Workstream of that pool; one whose pool is gone with an older image | The pool not offered; the ended Workstream's harness offered first is another; the other's, a pool of its harness. |
| U31 | Offered `github:o/a:write`, `github:o/b:read`, `zai` and `internet`; none granted, then `github:o/a:read`, then `internet` alone | `o/a` with None, Read, Write; `o/b` with None, Read; z.ai and Internet with Off, On; the button "No access", then "a · Read", then "Internet"; nothing offered: no picker. |
| U32 | An access choice: Write for `o/a`, then None for it, with `github:o/b:read` granted | The whole set each time: `github:o/a:write` and `github:o/b:read`, then `github:o/b:read`. |
| U33 | An ended Workstream whose execution had profiles, a message sent | The Create carries its `profiles`; another chosen before sending: those instead. |
| U34 | In a browser, an access picked in the draft, then a first message | The Create carries its `profiles`; the picker shows them once the Session is ready. |
| U35 | In a browser, another access picked in an open Workstream | Scope sent with the whole set; the picker shows it at once, and still once the view has it. |
| U36 | In a browser, a Workstream whose Pod ended without its anchor, then a message | Before sending, "No saved Mock agent session: the 1 exchange above goes to the agent as text."; sent, the new Session's notice says so; the prompt carries the exchange, then the message; the user's message shows the message alone. |
| U37 | In a browser on a phone's screen (390 × 844, touch, a 34 px home indicator), a draft whose pool offers models and efforts, a repository granted; then the same draft on a wide screen | Narrow: the harness as its mark, the model by name with its effort as bars, the key with its dot, no name; no picker's text cut; the composer 34 px above the bottom. Wide: the harness's name, the model · the effort, what is granted. |
| U38 | In a browser, the page's home-screen tags and files; then the theme toggled against the system's | The manifest (Agora, standalone, from `/`) and the 180 px icon served; an opaque status bar asked; the page covering the display; the status bar's colour the page's, then the toggled theme's. |
| U39 | In a browser on a phone's screen, a draft, then a Workstream opened from the list, the theme toggled in each; then the page loaded without its client | At the top and the bottom, the edge element as WebKit finds it is not one covering the screen and has the page's colour, the toggled theme's each time; the list open, the one covering it; the page without its client already in the theme picked. |
| U40 | In a browser on a phone's screen, two Workstreams taller than it: one opened from the list, the other from it, the first by its address; scrolled up, then **Scroll to the bottom**; on another phone, nothing kept and the network slow, the first from the list; then on a wide screen with a mouse | Each opened on its last message, the composer not focused; nor after the button. Wide: the composer focused on opening. |

**To be specified:** pagination of long threads; several operators, and who may read and write a
Workstream; showing protocol elements (`acp`); model selection and slash commands; elements
outside a turn (a `session/load` replay).

References: [ExternalStoreAdapter](https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/runtimes/external-store/external-store-adapter.ts),
[component registry](https://r.assistant-ui.com/registry.json).

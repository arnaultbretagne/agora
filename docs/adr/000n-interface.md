# ADR 000n — Interface

- **Status:** accepted
- **Date:** 2026-09-26

## Context

- Agent Sandbox runs the executions and the gateway holds the credentials: what Agora owns is
  the log of commands and ACP exchanges, and an interface that is a view of that log.
- An Agora turn outlives the browser: the log, kept server-side, is authoritative; the
  interface only displays what the log projects.
- The interface must render what ACP carries: text, reasoning, tool calls with their status,
  permission requests, the forms an agent asks (`elicitation/create`), cancellation.
- Some states are Agora's own: uncertain delivery, Session boundaries, context loss, stop with
  pending cleanup, capability differences between harnesses.

## Decision

1. **assistant-ui** (`@assistant-ui/react` 0.15.x) renders the interface: chat primitives
   (thread, message, composer), without imposed styling.
2. **Wired through `ExternalStoreRuntime`.** Agora supplies the messages and the callbacks —
   send, cancel, permission response. The ACP → messages projection stays with Agora.
3. **Neither AG-UI nor A2A.** A2A connects agents to each other; AG-UI assumes a run driven by
   the client, whereas Agora's log is authoritative.
4. **What waits for the person rides assistant-ui's own seams.** A permission, a question of Agora's,
   an approval, a merge card, and a form of one option, one text or nothing to fill are each the
   `approval` of their part, answered by its `respondToApproval`; any other form is the part's
   `interrupt`, answered by its `resume`. The forms' questions are drawn by assistant-ui's registry
   elements `OptionList` and `QuestionFlow` (Tool UI's), copied into the client and adapted. Decided on
   2026-11-16.

## Why

- Primitives without styling, and a runtime that takes an external store: the interface stays a
  view of Agora's log. The library's own AG-UI and A2A adapters are built on this runtime.
- ACP maps onto its message parts without an intermediate protocol.
- No candidate studied could replace the log itself (below): the log stays Agora's own building
  block, and only the view is borrowed.
- assistant-ui 0.15.23 types a request on a tool call (`approval`: `display` `decision`, `select`,
  `text`, free-form text, dismissal; `interrupt`, for what those modes cannot express) and draws none
  (read in `@assistant-ui/core` 0.3.22): the cards are Agora's, their answers the library's.

## What we tried

Each repository was cloned and its code read (2026-09-23); the findings rest on the code, not
on the projects' documentation.

### acp-ui (formulahendry/acp-ui, v0.1.16)

| Finding | Consequence |
| --- | --- |
| Messages live only in memory; history depends on the agent's `session/load` replay. | No log. |
| The browser holds the ACP connection; no server. | The opposite of Agora's model. |
| A 60 s timeout on every request, `session/prompt` included. | Any realistic coding turn fails. |
| Agent output rendered without sanitization (`v-html`); telemetry on by default. | XSS risk. |

### AionUi (iOfficeAI/AionUi, AionCore backend v0.2.2)

| Finding | Consequence |
| --- | --- |
| The prompt is resent automatically after an error, tested as intended. | Contradicts Agora's no-blind-resend rule. |
| A stale Session is replaced without recording the boundary; turns in progress are marked done at restart. | State lost silently. |
| Only assembled views are stored, never the raw ACP; Claude and Codex bypass ACP. | No faithful log. |
| The open-source build disables authentication; `--remote` allows an admin password reset without authentication. | Unsafe to expose. |
| A locked database forces a single replica; activity collapsing (6 commits in September, 1,400+ in March). | Weak foundation. |

### agentrq (agentrq/agentrq)

| Finding | Consequence |
| --- | --- |
| A task queue and kanban on MCP; no tool calls, no streaming. | Not an ACP chat interface. |
| Its gateway only launches a local stdio agent, without `session/load` or resume; tool calls not kept. | No resume, no faithful history. |
| Delivery by broadcast and a 60 s retry, no turn identity. | A late cancellation cuts off the next turn. |

### assistant-ui's `ElicitationForm` (registry, `elements/elicitation-form`, read 2026-11-16)

| Finding | Consequence |
| --- | --- |
| A form of fields of three kinds — a text, one choice, a toggle —, all shown at once, Accept and Decline. | No list of options and no step per question, which Claude Code's and Codex's questions need: `OptionList` and `QuestionFlow` instead. |

## Consequences

- Adopting assistant-ui means adopting React and a bundler, unlike the previous
  implementation's "no framework" choice.
- The library's editing, regeneration and branching are disabled.
- Agora's own states (uncertain delivery, Session boundaries, stop with pending cleanup) are
  components Agora writes.
- To validate: a spike on `ExternalStoreRuntime` fed by a real ACP log, with a permission, a
  cancellation and a reload in the middle of a turn.
- The copies of `OptionList` and `QuestionFlow` follow the registry by hand; what Agora adds to them —
  an "Other" field per question, a field for a text or a number, Decline, the text in the receipt — is
  said at their top.

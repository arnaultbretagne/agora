# assistant-ui elements and ACP

What each element of the assistant-ui registry ([assistant-ui.com/elements](https://www.assistant-ui.com/elements))
can expect to receive from a harness that speaks ACP.

**Reference: the ACP standard** as pinned by the log (schema of `@agentclientprotocol/sdk` 1.5.1),
stable part only. Not the extensions of any particular implementation.

Agora's `initialize` announces neither file system nor terminal (`fs` and `terminal` set to no):
what an agent can send only to a client that does is marked **No** here.

Each agent announces which parts of the standard it supports (`initialize`, session and prompt
capabilities, configuration options). An "ACP" element appears only if the connected agent provides
the data; the interface hides the rest.

| Verdict | Meaning |
| --- | --- |
| **ACP** | Fed by a stable ACP message. |
| **Agora** | Provided by Agora or the browser, without asking anything of ACP. |
| **Partial** | Part of the element works, the other part has no source. |
| **No** | ACP does not carry what is needed. |

## Table

| Elements | Verdict | Source | Limit |
| --- | --- | --- | --- |
| streaming-text, message-pair, typing-indicator | **ACP** | `agent_message_chunk`; `messageId` delimits messages | — |
| reasoning-panel, reasoning | **ACP** | `agent_thought_chunk` | — |
| thinking-indicator | **ACP** | title of the last in-progress `tool_call` | Duration computed by Agora. |
| tool-call, tool-group, tool-timeline | **ACP** | `tool_call` / `tool_call_update`: kind, title, status, files touched, raw input and output | — |
| tool-error | **ACP** | `failed` status of a tool | No "Retry": ACP does not rerun a single tool. |
| code-diff | **ACP** | `diff` tool content (path, old text, new text) | — |
| terminal-block | **No** | `terminal` tool content and `terminal/*` methods | Agora announces no terminal: a command's output arrives as the tool's text content, shown by the tool call. |
| agent-plan, todo-list | **ACP** | `plan`: steps, priority, status | Three states only; no "failed" step. |
| approval-card | **ACP** | `session/request_permission`, `allow_once`, `allow_always`, `reject_once`, `reject_always` options | assistant-ui spells the kinds with a dash: `allow-once`. |
| elicitation-form | **ACP** | `elicitation`: form described by a schema, or URL | Capability Agora must announce. |
| stopped-run | **ACP** | `session/cancel`, stop reason `cancelled` | "Continue" is a new prompt. |
| guardrail-notice | **ACP** | stop reason `refusal` | No alternatives offered. |
| error-state | **ACP** | prompt error, stop reasons `max_tokens`, `max_turn_requests` | "Retry" is a new prompt. |
| model-picker, model-selector | **ACP** | configuration options, `model` category | No price or capabilities per model. |
| context-display | **ACP** | `usage_update`: context used and size | — |
| message-attachment | **ACP** | prompt `image`, `audio`, `resource`, `resource_link` blocks | Depends on the types the agent accepts. |
| agent-card | **ACP** | `initialize`: the agent's identity and capabilities; available commands | — |
| reasoning-effort | **Partial** | configuration options, `thought_level` category | The budget consumed is not known. |
| cost-meter | **Partial** | `usage_update.cost` | Session total only, not per model. |
| context-breakdown | **Partial** | `usage_update` | Total only, not the breakdown. |
| settings-panel | **Partial** | configuration options (`mode`, `model`, `thought_level`, booleans) | System prompt and temperature only if the agent exposes them. |
| composer | **Partial** | commands (`available_commands_update`), attachments, model | `@file` mentions: the file list comes from the sandbox, not from ACP. No voice. |
| reviewable-diff | **Partial** | `diff` tool content | Decision on the whole tool call, not block by block. |
| permission-grant | **Partial** | `allow_always` option | The scope of the authorization is not described. |
| file-tree | **Partial** | files touched and diffs from tools | Rebuilt by Agora. |
| image-generation | **Partial** | `image` block in the response | The image arrives whole, with no progress. |
| web-search, sources, document-reference | **Partial** | `search` / `fetch` tools, `resource_link` blocks | No structured citations. |
| subagent-list, task-card, agent-handoff | **Partial** | tool calls, if the agent exposes its subagents through them | ACP does not know about subagents. |
| message-actions | **Partial** | — | Copy and rate: yes. Regenerate: no (see regenerate-menu). |
| mcp-server-panel | **Partial** | MCP servers declared by Agora when the session is created | No server state; dynamic connection unstable. |
| thread-list, thread-search, conversation-search, shared-conversation | **Agora** | The Workstream views; their title from `session_info_update` or the first prompt | ACP also has `session/list`, but the log is authoritative. |
| speaker-identity | **Agora** | attribution of exchanges to Sessions | — |
| connection-state, agent-status, loading-state | **Agora** | connection and turn state | — |
| message-timing | **Agora** | frame timestamps | Approximate token throughput. |
| message-queue | **Agora** | client-side queue | To be reconciled with the single-active-turn rule. |
| feedback-dialog | **Agora** | stored by Agora | Nothing goes back to the agent. |
| quote-reply, draft-restore | **Agora** | composer | — |
| directive-text | **Agora** | rendering of commands and mentions in the message | — |
| prompt-library | **Agora** | prompts saved by Agora | — |
| activity-graph | **Agora** | log statistics | — |
| math-block, diagram, mermaid-diagram, shiki-highlighter | **Agora** | Markdown text rendering | — |
| read-aloud | **Agora** | browser speech synthesis | — |
| chat-panel, empty-state, scroll-anchor, conversation-map, day-separator, command-palette, launcher-bubble, mobile-composer, onboarding | **Agora** | interface only | — |
| edit-message, message-branches, regenerate-menu | **No** | — | No editing and no going back. `session/fork` is unstable. |
| suggestions | **No** | — | Agora could generate them separately. |
| voice, voice-conversation | **No** | — | No real-time audio. |
| recommendation-card | **No** | — | The permission is the only agreement provided for. |
| inline-citation, retrieval-chunks, confidence-marker | **No** | — | No citations or confidence level. |
| data-table, chart, number-ticker, spec-sheet, comparison-card, timeline, map-answer, score-breakdown, research-report, job-progress | **No** | — | ACP carries only Markdown, images and resources. A Markdown table remains possible. |
| artifact-card, canvas-split | **No** | — | No artifacts: files go through diffs. |
| trace-waterfall, flow-graph | **No** | — | No spans or execution graph. |
| computer-use, code-runner, web-preview | **No** | — | Outside ACP; a web preview would go through Agent Sandbox. |
| memory-chips, checkpoint-history, background-inbox, schedule-card, quota-banner | **No** | — | — |

## Unstable, to watch

These messages exist in the pinned schema but are still marked unstable:
`plan_update` and `plan_removed` (partial plan), `notice`, `compaction_update`, providers,
dynamic MCP connection, and above all `session/fork`, which would enable branches.

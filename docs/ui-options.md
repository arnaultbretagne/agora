# Interface options — notes for the UI ADR

Study notes from 23 September 2026. This is not a decision: these notes keep
track of the candidates examined and of why they were kept or rejected,
for the upcoming UI ADR.

## Starting split

Agent Sandbox owns execution, the gateway owns credentials (Agent Vault at the
time of these notes, ruled out since, see the gateway ADR). What is left
for Agora is the log of commands and ACP exchanges, and an interface that is a
view of it. Each candidate was assessed for two possible roles: serving as the
interface, or replacing this log.

## Chosen option: assistant-ui

Version examined: `@assistant-ui/react` 0.15.x.

- A library of chat primitives (thread, message, composer) with no imposed styling,
  plus optional styled variants.
- Wired through `ExternalStoreRuntime`: Agora supplies the messages and the
  callbacks (send, cancel, permission response). The interface only displays
  what the log projects. The library's AG-UI and A2A adapters are themselves
  built on this runtime.
- AG-UI and A2A are not used. A2A connects agents to each other. AG-UI assumes
  a client-driven run, whereas an Agora turn outlives the browser and the
  log is authoritative. There is no ACP adapter; the
  ACP → messages projection stays with Agora.
- Good fit with ACP: text and reasoning as message parts,
  `tool_call` and `tool_call_update` as tool parts with a status,
  `session/request_permission` as human approval, `session/cancel` as `onCancel`.
- Still specific to Agora: uncertain delivery, Session boundaries,
  context loss, stop with pending cleanup, capability differences
  between harnesses. The library's editing, regeneration and branching
  must be disabled.
- Cost: `@assistant-ui/core` is framework-independent, but all rendering
  depends on React (DOM, React Native, Ink). Adopting the library means
  adopting React and a bundler, unlike the "no framework" choice of
  the previous implementation.
- Proposed validation: a spike on `ExternalStoreRuntime`, fed by a real ACP
  log, with a permission, a cancellation and a reload in the middle of
  a turn.

## Rejected candidates

Each repository was cloned and its code read. The verdicts below rest on the
code, not on the project's documentation.

### acp-ui (formulahendry/acp-ui)

ACP client in Vue and Tauri, v0.1.16, last commit in May 2026, a single maintainer.

- No storage: messages live only in memory, and the history depends on the
  agent's `session/load` replay.
- No server: the browser holds the ACP connection, the opposite of
  Agora's model.
- A 60 s timeout applies to every request, `session/prompt` included.
  Any realistic coding turn fails.
- The agent's output is rendered without sanitization (`v-html`), hence an XSS
  risk. Telemetry is on by default.
- No TypeScript tests.

### AionUi (iOfficeAI/AionUi, AionCore backend)

The Electron and React interface is popular. The real backend is AionCore, a
Rust server on SQLite created in April 2026 (v0.2.2 at the time of study).

- Contradicts the design's invariants:
  - the prompt is resent automatically after an error, and this is tested as
    intended behaviour;
  - a stale Session is replaced without the boundary being recorded;
  - state is lost on restart, and turns in progress are marked done
    without the user seeing it;
  - only assembled views are stored, never the raw ACP.
- ACP only goes through a local stdio child process. Claude and Codex
  bypass ACP (stream-json and `app-server`).
- The open-source build disables authentication (`--local`). In
  `--remote` mode, an admin password reset is possible without
  authentication. Part of the authentication is closed source.
- A locked database forces a single replica. Activity is collapsing (6 commits
  in September against more than 1,400 in March).

### agentrq (agentrq/agentrq)

Human-in-the-loop task queue built on MCP (Go, Vue). ACP only
goes through a separate gateway.

- It is not an ACP chat interface. The product centres on tasks and
  the kanban. It shows neither tool calls nor streaming.
- The gateway can only launch a local agent over stdio. It does neither
  `session/load` nor resume. The agent's messages are aggregated, and tool
  calls are not kept.
- Delivery relies on broadcasting to every session and on a
  retry every 60 s. There are no delivery states and no turn identity:
  a late cancellation cuts off the next turn.
- It could run alongside Agora as an MCP task board, but would create
  a second history of the same work.

## Provisional conclusion

No candidate replaces the log: they all stumble on uncertain delivery,
resume after a restart and attribution to Sessions. The log remains Agora's
own building block. For the interface, assistant-ui is the option to validate with
the spike described above.

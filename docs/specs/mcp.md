# MCP

Contract to implement: Agora's MCP server, through which an agent reaches Agora's own primitives —
the person's Workstreams, searched and read (`search.md`), and work handed to other agents
(`delegation.md`). Written against agentgateway 1.6.0 and
the MCP TypeScript SDK 1.32, the protocol's version being the one the SDK and the harness agree on.

**An agent reaches Agora as it reaches any host: through the gateway, with its token. The gateway
checks the token and forwards it; Agora checks it again, finds its execution, that execution's
Workstream and person, opens the tools the execution's rights open, and answers within that
person's Workstreams.**

## The path

| Element | Rule |
| --- | --- |
| Address | `https://mcp.agora.internal/mcp`, the server `agora` of the session's `mcpServers` (`credentials.md`, "MCP servers"). The host resolves nowhere: only the gateway's route `agora` knows it. |
| The route | The gateway's route `agora` (`credentials.md`, "Agora's MCP"): the token checked, a grant covering the host, the path and the method; the token the CONNECT carried set as `Authorization: Bearer`, over whatever the sandbox sent; then the server's port 8082. |
| The server | Port 8082, `POST /mcp`, every request proving its caller first ("The caller"): MCP over Streamable HTTP, stateless — no `mcp-session-id`, one JSON answer per message, but a `spawn_agent` call's: an SSE stream, a progress notification every 30 s while Agora holds it (`delegation.md`, "Approval"), then its answer; `GET` and `DELETE` answered 405. Of the cluster's Pods, only the gateway reaches the port; the node reaches it, as it reaches every Pod's ports. Reaching it proves nothing: every message proves its caller. |
| The caller | `Authorization: Bearer` and a grant Agora signed (`credentials.md`, "The gateway"): with its own key, under its key id, EdDSA; `iss` its issuer, `aud` its audience; an `exp`, not past by more than 30 s. Its `sub`, `agora <execution>`: the execution, the Workstream its Create started, that Workstream's owner — the person, a sub-stream's owner being its root's. A message without such a grant: 401 `unauthenticated`; one whose grant names an execution Agora does not know: 401 `unknown_caller`; nothing read either way. `x-agora-execution` grants nothing. A server without the gateway's key — no `GATEWAY_PROXY` — refuses every message. |
| Rights | The execution's own profiles as the log records them (`log.md`, "The Workstream view": `profiles`), not the token's: `agora:read` opens `search` and `read`; `agora:delegate`, `spawn_agent`, `send_message`, `stop_agent`, `list_agents` and `answer_agent`; Agora's own `agora:submit`, given to every delegate (`credentials.md`), `send_message`, toward its delegator alone; a repository's write, `github:owner/repo:write`, `propose_merge` for that repository; `agora:delegate`, `propose_merge` too, for a repository whose write the Workstream gave one of its delegates (`merge.md`, "The proposal"). `tools/list` lists what they open; a call to another tool is refused (`not_allowed`). |
| Reach | The person's Workstreams and their sub-streams, as the person's own search reaches them. Never another person's. `search` and `read`: those Workstreams, another's `unknown_workstream`. `spawn_agent`: a sub-stream of the caller's Workstream. `send_message`, `stop_agent`, `answer_agent`, `list_agents`: the caller's own delegates — its Workstream's sub-streams it started —, and `parent`, its own delegator; any other Workstream `not_a_delegate`. `propose_merge`: a card in the caller's Workstream. |

## Tools

`search`, `read` and `list_agents` are marked read-only (`readOnlyHint`). The parameters of `search` and
`read` are the search's and the read's (`search.md`, "HTTP"); they answer in text, as grep and Read
answer. The four tools of delegation bear the names the harnesses give their own sub-agents' gestures
(`delegation.md`), and `answer_agent` a name after theirs; the server's name tells them apart.
Every execution holds `agora:read` from its Create (`credentials.md`, "Default profiles"): `search`
and `read` are listed to every execution but one a Scope took it from.

| Tool | Parameters | Answer |
| --- | --- | --- |
| `search` | `pattern`, required; `output_mode`: `workstreams_with_matches` by default, `content`, `count`; `ignore_case`; `before`, `after`, `context`, 0 to 50; `head_limit`, 1 to 100, 20 by default; `offset`; `tools`; `workstream`. | `workstreams_with_matches`: for each Workstream, `<id> · <title> · <count> lines` — `1 line` for one —, then, indented by two spaces, its latest matching line, `<line>:<text>`. `content`: `<id>:<line>:<text>` for a match, `<id>-<line>-<text>` for context, `--` between groups that do not touch. `count`: `<id>:<count> · <title>`. When more follow, a last line `(more: offset <next>)`. Nothing found: `(no match)`. |
| `read` | `workstream`, required; `offset`, from 1, 1 by default; `limit`, 1 to 2,000, 2,000 by default. | Each line `<number>` and a tab, then its text; then `(lines <first>–<last> of <total>; next offset <next>)`, or `(lines <first>–<last> of <total>)` at the end. From beyond the end: `(no line from <offset>; <total> lines)`, `1 line` for one. |
| `propose_merge` | `repo`, `owner/name`, and `number`, required. | `proposed <owner/name>#<number>: …`, the card shown to the person (`merge.md`, "The proposal"); refused `not_allowed`, `not_found`, `not_open`, `question_pending`. |
| `spawn_agent` | `instructions`, required: the delegate's first message; `agent_type`, one of Agora's roles (`roles.md`), listed only when Agora holds some: an `enum` of their names, its description naming each with its card's summary; `harness`, a pool's harness, the role's, else the caller's, by default; `model`, `effort`, as that pool offers them; `rights`, profiles, none by default. | `started <id> · <title>`, at once or once approved (`delegation.md`); else a refusal. |
| `send_message` | `to`, required: one of the caller's delegates, or `parent`, the caller's own delegator; `message`, required: the words. Listed to every delegate. | `sent <id> · <title>` to a delegate; `sent` to `parent`; else a refusal. |
| `stop_agent` | `to`, required: one of the caller's delegates. | `stopped <id> · <title>`, or `no turn to stop <id> · <title>`; else a refusal. |
| `list_agents` | None. | One line for each of the caller's delegates, `<id> · <title> · <state>`, the most recently changed first; `no delegate`. |
| `answer_agent` | `to`, required: one of the caller's delegates; `request`, required: the request's number, as Agora's message gives it, a string or an integer; a permission's `option`: the id of the option chosen; a form's `content`: its fields' values by their names, or `decline`, true. | `answered <id> · <title>`, or `declined <id> · <title>` for a form declined; else a refusal (`delegation.md`, "Requests"). |

| Description | What it tells the agent |
| --- | --- |
| `search` | It works like `grep -n` over the person's Workstreams: what the person and the agents wrote, line by line; tool titles too with `tools`. The pattern is a regular expression, PostgreSQL's, `\b` a word's edge; most recently changed Workstreams first. |
| `read` | It works like Read on a file: a Workstream's transcript in numbered lines — its exchanges, each a `you` header, the person's lines, an `agent` header, the agent's lines and its tools — from `offset`, at most `limit` lines and 50 KB. |
| `spawn_agent` | It starts another agent of Agora's, a delegate: not a sub-agent of the caller's own harness, but an agent in an execution of its own — its harness, its model, its rights —, a sub-stream of the caller's Workstream where the person sees it and can write to it. The call answers once it has started, and the delegate's last message comes back later as a message, into the caller's running turn or as its next — no waiting, no polling. Rights beyond the caller's wait for the person's approval. |
| `send_message` | It writes to another agent of Agora's. To one of the caller's delegates, whatever it is doing: its next message. To `parent`, the agent that started the caller: what cannot wait for the end of the turn, a question or news — the turn's last message goes to it by itself, so the result is not sent this way. |
| `stop_agent` | It stops what one of the caller's delegates is doing now. The delegate stays: `send_message` reaches it. |
| `list_agents` | The caller's delegates, and whether each is working or waiting for an answer to a request of its. |
| `answer_agent` | It answers a request one of the caller's delegates waits on — a permission or a form its agent asked —, as Agora's message about it names it: the option chosen, or the form's content, every required field, or its refusal. Only what is the caller's to decide; otherwise the person, who can answer it in the delegate's thread. The first answer counts. |

| Refusal | Answer |
| --- | --- |
| A pattern PostgreSQL cannot compile | A tool error, `invalid_pattern`. |
| A parameter out of its range, or of another type | A tool error, `invalid_query`, naming the parameter. |
| A Workstream that is not the person's, or unknown | A tool error, `unknown_workstream`. |
| A tool the execution's rights do not open | A protocol error, `not_allowed`. |
| `spawn_agent`, `send_message`, `stop_agent` or `answer_agent` refused (`delegation.md`) | A tool error: `depth_exceeded`, `too_many_delegates`, `approval_pending`, `unknown_profile`, `profile_not_offered`, `unknown_harness`, `unknown_agent_type`, `not_a_delegate`, `no_delegator`, `delegate_stopped`, `too_many_exchanges`, `stale_permission` with what is pending, `invalid_permission_option`, `invalid_elicitation_content` with the field and why; `refused` with the person's words; `expired`. |

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| M1 | An execution created naming `agora:read`, then one naming none of Agora's profiles; their `session/new` | `mcpServers` holds `agora`, `https://mcp.agora.internal/mcp`, no headers, once, each time: every execution holds `agora:read` (`credentials.md`, "Default profiles"). |
| M2 | `tools/list` from an execution with `agora:read` | `search` and `read`, each read-only, with the parameters above. |
| M3 | A word said in another of the person's Workstreams and in a sub-stream of it, and in another person's; `search` from an execution of the person's | The two, the most recently changed first, each with its latest matching line; never the other person's. |
| M4 | `read` of one of the person's Workstreams from an offset with a limit; to its end; beyond it; of another person's | Its numbered lines and the next offset; its last lines and no next offset; `(no line from <offset>; <total> lines)`; `unknown_workstream`. |
| M5 | A message to port 8082 with a grant of Agora's naming an execution Agora does not know; naming one without `agora ` before it; then a `GET` | 401 `unknown_caller` each time, nothing read, the same message accepted with the execution's own grant; 405. |
| M6 | An execution without `agora:read` — never given it, or scoped out of it —, listing the tools and calling `search` on port 8082 | No tool listed; `not_allowed`. |
| M7 | `search` with the pattern `(`; with `head_limit` 500 | `invalid_pattern`; `invalid_query` naming `head_limit`. |
| M8 | Through the gateway: an execution with `agora:read`, sending `x-agora-execution` itself or not; one without it — `anthropic`, `internet` —, one from another address, one on another path | The message reaches Agora with the token's own execution, whatever the sandbox sent; 403 at the gateway for the others, nothing reaching Agora. |
| M9 | Live: a turn of Claude Code, of Codex and of opencode, each asked to find a past conversation by a word and quote it | Each calls `search`, then `read`, through the gateway, and quotes the line. |
| M10 | `tools/list` from an execution with `agora:delegate`; from a delegate given no right, as its Session opens, before its instructions; from a delegate holding both | `spawn_agent`, `send_message`, `stop_agent`, `list_agents` and `answer_agent`, `list_agents` alone read-only, each with its parameters — `answer_agent`'s `to` and `request`, required, `option`, `content` and `decline` —, then `search` and `read`, the default `agora:read`'s; `send_message`, with `to` and `message`, then `search` and `read`; the five, each once, then `search` and `read`. |
| M11 | A `spawn_agent` call Agora holds, the client reading the answer | An SSE stream: progress notifications every 30 s, then the answer; every other message, one JSON answer. |
| M12 | `stop_agent`, `list_agents` and `answer_agent` from a delegate given no right; `delegate` and `submit`, the names of an earlier contract, called by an execution with `agora:delegate`; `send_message` to a delegate of its own, from an execution scoped down to `agora:submit` alone | `not_allowed` each time, nothing done; `tools/list` giving `send_message` alone, and `not_a_delegate`, nothing written. |
| M13 | `tools/list` from an execution with `agora:delegate`, Agora holding roles; holding none; Agora's own cards read; a card whose `model` is `default` | `spawn_agent` takes `agent_type`, an `enum` of the roles, its description naming each with its summary; no `agent_type`; `dev`, `judge`, `lead` and `sre`, each with a harness, a summary and its persona, its front matter left out; no model of its own. |
| M14 | Port 8082 of the server, two executions of the person's that may delegate: `spawn_agent` with no `Authorization`; with `x-agora-execution` alone, naming the first; with a grant expired 2 min ago; one with no `exp`; one signed by another key under the same key id, alone and with that header; the first's grant, its `sub` changed to the second; a grant for another audience, from another issuer, under another key id; one not signed; the first's grant in `Proxy-Authorization`; a `GET` with none; then the grant the server signed for the first, as the gateway forwards it | 401 `unauthenticated` each time, no sub-stream written; then `started <id> · <title>`, a sub-stream of the first's Workstream alone. |
| M15 | Through the gateway, an execution with `agora:read`: a message; one with an `Authorization` of the sandbox's own carrying another execution's grant; one with `Authorization: Basic` and an `x-agora-execution` of its own | Each reaches Agora with `Authorization: Bearer` and the token its CONNECT carried, byte for byte, never the sandbox's own; and `x-agora-execution` that token's subject. |

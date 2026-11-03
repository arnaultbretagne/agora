# MCP

Contract to implement: Agora's MCP server, through which an agent reaches Agora's own primitives —
the person's Workstreams, searched and read (`search.md`), and work handed to other agents
(`delegation.md`). Written against agentgateway 1.6.0 and
the MCP TypeScript SDK 1.32, the protocol's version being the one the SDK and the harness agree on.

**An agent reaches Agora as it reaches any host: through the gateway, with its token. The gateway
names the execution that calls; Agora finds its Workstream and its person, opens the tools the
execution's rights open, and answers within that person's Workstreams.**

## The path

| Element | Rule |
| --- | --- |
| Address | `https://mcp.agora.internal/mcp`, the server `agora` of the session's `mcpServers` (`credentials.md`, "MCP servers"). The host resolves nowhere: only the gateway's route `agora` knows it. |
| The route | The gateway's route `agora` (`credentials.md`, "Agora's MCP"): the token checked, a grant covering the host, the path and the method; the token's subject set as `x-agora-execution`, over whatever the sandbox sent; then the server's port 8082. |
| The server | Port 8082, `POST /mcp`: MCP over Streamable HTTP, stateless — no `mcp-session-id`, one JSON answer per message, but a `delegate` call's: an SSE stream, a progress notification every 30 s while Agora holds it (`delegation.md`, "Approval"), then its answer; `GET` and `DELETE` answered 405. Of the cluster's Pods, only the gateway reaches the port; the node reaches it, as it reaches every Pod's ports. |
| The caller | `x-agora-execution`, `agora <execution>`: the execution, the Workstream its Create started, that Workstream's owner — the person, a sub-stream's owner being its root's. A message without it, or naming an execution Agora does not know: 401, nothing read. |
| Rights | The execution's own profiles as the log records them (`log.md`, "The Workstream view": `profiles`), not the token's: `agora:read` opens `search` and `read`; `agora:delegate`, `delegate`; Agora's own `agora:submit`, given to a delegate asked for a result (`credentials.md`), `submit`. `tools/list` lists what they open; a call to another tool is refused (`not_allowed`). |
| Reach | The person's Workstreams and their sub-streams, as the person's own search reaches them, but for the agents' folder, which an agent does not reach. Never another person's. |

## Tools

`search` and `read` are marked read-only (`readOnlyHint`). Their parameters are the search's and the
read's (`search.md`, "HTTP"); they answer in text, as grep and Read answer.

| Tool | Parameters | Answer |
| --- | --- | --- |
| `search` | `pattern`, required; `output_mode`: `workstreams_with_matches` by default, `content`, `count`; `ignore_case`; `before`, `after`, `context`, 0 to 50; `head_limit`, 1 to 100, 20 by default; `offset`; `tools`; `workstream`. | `workstreams_with_matches`: for each Workstream, `<id> · <title> · <count> lines` — `1 line` for one —, then, indented by two spaces, its latest matching line, `<line>:<text>`. `content`: `<id>:<line>:<text>` for a match, `<id>-<line>-<text>` for context, `--` between groups that do not touch. `count`: `<id>:<count> · <title>`. When more follow, a last line `(more: offset <next>)`. Nothing found: `(no match)`. |
| `read` | `workstream`, required; `offset`, from 1, 1 by default; `limit`, 1 to 2,000, 2,000 by default. | Each line `<number>` and a tab, then its text; then `(lines <first>–<last> of <total>; next offset <next>)`, or `(lines <first>–<last> of <total>)` at the end. From beyond the end: `(no line from <offset>; <total> lines)`, `1 line` for one. |
| `delegate` | `instructions`, required: the delegate's first message; `harness`, a pool's harness, the caller's by default; `model`, `effort`, as that pool offers them; `rights`, profiles, none by default; `output_schema`, a JSON Schema whose root is an object; `to`, one of the caller's delegates — with `to`, only `instructions` and `output_schema`. | `started <id> · <title>`, at once or once approved (`delegation.md`); else a refusal. |
| `submit` | The delegation's `output_schema`, as given. Listed only to a delegate asked for a result. | `submitted`; a tool error naming the mismatch otherwise. |

| Description | What it tells the agent |
| --- | --- |
| `search` | It works like `grep -n` over the person's Workstreams: what the person and the agents wrote, line by line; tool titles too with `tools`. The pattern is a regular expression, PostgreSQL's, `\b` a word's edge; most recently changed Workstreams first. |
| `read` | It works like Read on a file: a Workstream's transcript in numbered lines — its exchanges, each a `you` header, the person's lines, an `agent` header, the agent's lines and its tools — from `offset`, at most `limit` lines and 50 KB. |
| `delegate` | It hands work to another agent, which runs on its own as a sub-stream of the caller's Workstream; the call answers once it has started, and its outcome comes back later as a message from Agora — no waiting, no polling. `to` continues a delegate. `output_schema` asks for a result of that shape: to give when the caller will act on fields of it — a verdict, findings, a number —, to leave out when it will read prose. Rights beyond the caller's wait for the person's approval. |
| `submit` | It hands the result to the agent that asked for it: once, when the work is done, in the shape it asked. |

| Refusal | Answer |
| --- | --- |
| A pattern PostgreSQL cannot compile | A tool error, `invalid_pattern`. |
| A parameter out of its range, or of another type | A tool error, `invalid_query`, naming the parameter. |
| A Workstream that is not the person's, or unknown | A tool error, `unknown_workstream`. |
| A tool the execution's rights do not open | A protocol error, `not_allowed`. |
| `delegate` refused (`delegation.md`) | A tool error: `depth_exceeded`, `too_many_delegates`, `approval_pending`, `profile_not_offered`, `unknown_harness`, `invalid_schema`, `not_a_delegate`, `delegate_busy`; `refused` with the person's words; `expired`. |

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| M1 | An execution created with `agora:read`, then one without; their `session/new` | `mcpServers` holds `agora`, `https://mcp.agora.internal/mcp`, no headers; then `[]`. |
| M2 | `tools/list` from an execution with `agora:read` | `search` and `read`, each read-only, with the parameters above. |
| M3 | A word said in another of the person's Workstreams and in a sub-stream of it, and in another person's; `search` from an execution of the person's | The two, the most recently changed first, each with its latest matching line; never the other person's. |
| M4 | `read` of one of the person's Workstreams from an offset with a limit; to its end; beyond it; of another person's | Its numbered lines and the next offset; its last lines and no next offset; `(no line from <offset>; <total> lines)`; `unknown_workstream`. |
| M5 | A message to port 8082 without `x-agora-execution`; naming an execution Agora does not know; naming one without `agora ` before it; then a `GET` | 401 each time, nothing read, the same message accepted once the execution is named as the gateway names it; 405. |
| M6 | An execution without `agora:read` — never given it, or scoped out of it —, listing the tools and calling `search` on port 8082 | No tool listed; `not_allowed`. |
| M7 | `search` with the pattern `(`; with `head_limit` 500 | `invalid_pattern`; `invalid_query` naming `head_limit`. |
| M8 | Through the gateway: an execution with `agora:read`, sending `x-agora-execution` itself or not; one without it — `anthropic`, `internet` —, one from another address, one on another path | The message reaches Agora with the token's own execution, whatever the sandbox sent; 403 at the gateway for the others, nothing reaching Agora. |
| M9 | Live: a turn of Claude Code, of Codex and of opencode, each asked to find a past conversation by a word and quote it | Each calls `search`, then `read`, through the gateway, and quotes the line. |
| M10 | `tools/list` from an execution with `agora:delegate`; from a delegate asked for a result, with `agora:submit` alone, as its Session opens, before its instructions | `delegate`, not read-only, with its parameters; `submit` alone, its input the delegation's schema. |
| M11 | A `delegate` call Agora holds, the client reading the answer | An SSE stream: progress notifications every 30 s, then the answer; every other message, one JSON answer. |

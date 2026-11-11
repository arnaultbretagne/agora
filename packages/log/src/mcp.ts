// Agora's MCP server (docs/specs/mcp.md): the person's Workstreams, searched and read, for the agents the gateway lets
// through. Its port is the gateway's alone; the gateway's route `agora` names the execution that calls, and nothing
// else here says who calls.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { HEAD_LIMIT, OUTPUT_MODES, read, READ_LIMIT, search, type OutputMode, type ReadAnswer, type SearchAnswer } from './search.ts'
import { MAX_LINE } from './acp.ts'
import { object } from './json.ts'
import type { Workstreams } from './workstreams.ts'
import { Refused as DelegationRefused } from './delegation.ts'
import { Refused as MergeRefused } from './merges.ts'
import { GITHUB_WRITE } from '@agora/credentials'

/** The header the gateway sets from the token's subject, over whatever the sandbox sent. */
export const CALLER_HEADER = 'x-agora-execution'
const SUBJECT = /^agora ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A message larger than this is no tool call of ours: `send_message` carries what a line of a prompt can hold. */
const MAX_BODY = MAX_LINE

const SEARCH: Tool = {
  name: 'search',
  description:
    'Search the person’s Workstreams — their conversations with agents, yours included — the way `grep -n` searches files. ' +
    'Each Workstream is a transcript of numbered lines: for each exchange, a `## <n> · <time> · you` header, the person’s lines, ' +
    'a `## <n> · agent` header, then the agent’s lines, and its tools as `[tool: <title>]` lines when `tools` is true. ' +
    'A message not the person’s has a `delegator`, `delegate` or `agora` header, and one sent into a turn a `<who>, during the turn` header among the agent’s lines. ' +
    '`pattern` is a regular expression, PostgreSQL’s, `\\b` being a word’s edge as in ripgrep, matched line by line; case counts unless `ignore_case`. ' +
    'The most recently changed Workstreams come first. `output_mode`: `workstreams_with_matches` (each Workstream, its title, how many lines match, ' +
    'and its latest matching line), `content` (each matching line as `<workstream>:<line>:<text>`, with `before`, `after` or `context` lines around it ' +
    'as `<workstream>-<line>-<text>`), or `count`. Then `read` a Workstream from a line.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'A regular expression, PostgreSQL’s, matched line by line.' },
      output_mode: { type: 'string', enum: [...OUTPUT_MODES], default: 'workstreams_with_matches' },
      ignore_case: { type: 'boolean', description: 'Ignore case, as `grep -i`.' },
      before: { type: 'integer', minimum: 0, maximum: 50, description: 'With `content`: lines before each match, as `grep -B`.' },
      after: { type: 'integer', minimum: 0, maximum: 50, description: 'With `content`: lines after each match, as `grep -A`.' },
      context: { type: 'integer', minimum: 0, maximum: 50, description: 'With `content`: lines around each match, as `grep -C`.' },
      head_limit: { type: 'integer', minimum: 1, maximum: HEAD_LIMIT.max, default: HEAD_LIMIT.default, description: 'At most this many results.' },
      offset: { type: 'integer', minimum: 0, description: 'Results to skip: the offset an earlier answer gave.' },
      tools: { type: 'boolean', description: 'Match the titles of the agents’ tools too.' },
      workstream: { type: 'string', format: 'uuid', description: 'Search this Workstream only.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
}

const READ: Tool = {
  name: 'read',
  description:
    'Read one of the person’s Workstreams the way Read reads a file: its transcript in numbered lines, `<number>` and a tab then the text — ' +
    'for each exchange a header naming who wrote — `you`, `delegator`, `delegate` or `agora` —, their lines, an `agent` header, the agent’s lines and its tools — ' +
    'from `offset`, at most `limit` lines and 50 KB; ' +
    'a line longer than 2,000 characters is cut. The last line gives the next offset when more follow.',
  inputSchema: {
    type: 'object',
    properties: {
      workstream: { type: 'string', format: 'uuid', description: 'The Workstream, as `search` gives it.' },
      offset: { type: 'integer', minimum: 1, default: 1, description: 'The first line to read.' },
      limit: { type: 'integer', minimum: 1, maximum: READ_LIMIT.lines, default: READ_LIMIT.lines, description: 'At most this many lines.' },
    },
    required: ['workstream'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
}

// The four tools of delegation bear the names the harnesses give their own sub-agents' gestures (docs/specs/delegation.md).
const SPAWN_AGENT: Tool = {
  name: 'spawn_agent',
  description:
    'Start another agent of Agora’s, a delegate. It is not a sub-agent of your own harness: it runs in an execution of its own — ' +
    'its harness, its model, its rights — as a sub-stream of your Workstream, where the person sees it and can write to it. ' +
    'The call answers once it has started; its last message comes back to you later as a message, whole — do not wait or poll for it, carry on or end your turn. ' +
    'Rights beyond your own wait for the person’s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      instructions: { type: 'string', description: 'The delegate’s first message: what it has to do, and what you need back.' },
      harness: { type: 'string', description: 'claude-code, codex or opencode; yours by default.' },
      model: { type: 'string', description: 'A model the harness offers; its default otherwise.' },
      effort: { type: 'string', description: 'An effort the harness offers; its default otherwise.' },
      rights: { type: 'array', items: { type: 'string' }, description: 'The delegate’s rights, as profiles — e.g. github:owner/repo:read; none by default.' },
    },
    required: ['instructions'],
    additionalProperties: false,
  },
}

/** Listed to every delegate from its start, toward its delegator: a harness may list its tools once (docs/specs/mcp.md, "The path"). */
const SEND_MESSAGE: Tool = {
  name: 'send_message',
  description:
    'Write to another agent of Agora’s. To one of your delegates, by its id, whatever it is doing: its next message. ' +
    'To `parent`, the agent that started you: what cannot wait for the end of your turn — a question, news. ' +
    'Your turn’s last message goes to it by itself, so do not send your result this way.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The id of one of your delegates, or `parent`.' },
      message: { type: 'string', description: 'The words, whole.' },
    },
    required: ['to', 'message'],
    additionalProperties: false,
  },
}

const STOP_AGENT: Tool = {
  name: 'stop_agent',
  description: 'Stop what one of your delegates is doing now. The delegate stays: `send_message` reaches it, and starts its next turn.',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'string', format: 'uuid', description: 'The id of one of your delegates.' } },
    required: ['to'],
    additionalProperties: false,
  },
}

const LIST_AGENTS: Tool = {
  name: 'list_agents',
  description: 'Your delegates and whether each is working: one line each, `<id> · <title> · <state>` — working, idle, failed or cancelled.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
}

/** Listed to an execution holding a repository's write, for those repositories (docs/specs/merge.md). */
const PROPOSE_MERGE: Tool = {
  name: 'propose_merge',
  description:
    'Ask the person to merge a pull request you wrote: Agora shows them a card with its state as GitHub gives it, and they merge it from there. ' +
    'Propose it once it is ready — reviewed, its checks green; the card waits for them and the call answers at once. ' +
    'Do not wait or poll: what happens comes back to you as a message from Agora. Your repositories with write only.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name' },
      number: { type: 'integer', minimum: 1, description: 'The pull request’s number.' },
    },
    required: ['repo', 'number'],
    additionalProperties: false,
  },
}

/** The tools each right opens (docs/specs/mcp.md, "The path"). */
const RIGHTS: Readonly<Record<string, readonly Tool[]>> = {
  'agora:read': [SEARCH, READ],
  'agora:delegate': [SPAWN_AGENT, SEND_MESSAGE, STOP_AGENT, LIST_AGENTS],
  'agora:submit': [SEND_MESSAGE],
}
const DELEGATION = new Set(['spawn_agent', 'send_message', 'stop_agent', 'list_agents'])

/** What a tool answers instead of its result: the reason, as the HTTP API gives it. */
class Refused extends Error {}

type Args = Readonly<Record<string, unknown>>

function integer(args: Args, name: string, fallback: number, min: number, max: number): number {
  const value = args[name]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Refused(`invalid_query: ${name}`)
  return value
}

function flag(args: Args, name: string): boolean {
  const value = args[name]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new Refused(`invalid_query: ${name}`)
  return value
}

const lines = (n: number) => (n === 1 ? '1 line' : `${String(n)} lines`)

/** docs/specs/mcp.md, "Tools": a search's answer as grep gives its own. */
function searchText(output: OutputMode, answer: SearchAnswer): string {
  const out: string[] = []
  if (output === 'content') {
    let last: { workstream: string; line: number } | null = null
    for (const r of answer.results as readonly { workstream: string; line: number; match: boolean; text: string }[]) {
      if (last !== null && (last.workstream !== r.workstream || r.line !== last.line + 1)) out.push('--')
      const mark = r.match ? ':' : '-'
      out.push(`${r.workstream}${mark}${String(r.line)}${mark}${r.text}`)
      last = { workstream: r.workstream, line: r.line }
    }
  } else if (output === 'count') {
    for (const r of answer.results as readonly { workstream: string; title: string | null; count: number }[]) out.push(`${r.workstream}:${String(r.count)} · ${r.title ?? ''}`)
  } else {
    for (const r of answer.results as readonly { workstream: string; row: { title?: string } | null; count: number; line: number; text: string }[])
      out.push(`${r.workstream} · ${r.row?.title ?? ''} · ${lines(r.count)}`, `  ${String(r.line)}:${r.text}`)
  }
  if (out.length === 0) out.push('(no match)')
  if (answer.next !== null) out.push(`(more: offset ${String(answer.next)})`)
  return out.join('\n')
}

/** docs/specs/mcp.md, "Tools": a read's window as Read gives a file's. */
function readText(answer: ReadAnswer, offset: number): string {
  const first = answer.lines[0]
  const last = answer.lines.at(-1)
  if (first === undefined || last === undefined) return `(no line from ${String(offset)}; ${lines(answer.total)})`
  const range = `lines ${String(first.number)}–${String(last.number)} of ${String(answer.total)}`
  return [...answer.lines.map((l) => `${String(l.number)}\t${l.text}`), answer.next === null ? `(${range})` : `(${range}; next offset ${String(answer.next)})`].join('\n')
}

async function call(workstreams: Workstreams, owner: string, name: string, args: Args): Promise<string> {
  const pool = workstreams.projections.store.projector
  const only = (value: unknown): string => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Refused('invalid_query: workstream')
    return value
  }
  if (name === 'search') {
    const pattern = args.pattern
    if (typeof pattern !== 'string') throw new Refused('invalid_query: pattern')
    if (pattern === '') throw new Refused('invalid_pattern')
    const output = (args.output_mode ?? 'workstreams_with_matches') as OutputMode
    if (!OUTPUT_MODES.includes(output)) throw new Refused('invalid_query: output_mode')
    const workstream = args.workstream === undefined || args.workstream === null ? null : only(args.workstream)
    if (workstream !== null && !(await workstreams.projections.belongs(workstream, [owner]))) throw new Refused('unknown_workstream')
    const context = integer(args, 'context', 0, 0, 50)
    const answer = await search(pool, [owner], {
      pattern,
      ignoreCase: flag(args, 'ignore_case'),
      output,
      before: integer(args, 'before', context, 0, 50),
      after: integer(args, 'after', context, 0, 50),
      tools: flag(args, 'tools'),
      workstream,
      headLimit: integer(args, 'head_limit', HEAD_LIMIT.default, 1, HEAD_LIMIT.max),
      offset: integer(args, 'offset', 0, 0, 1_000_000),
    })
    return searchText(output, answer)
  }
  const workstream = only(args.workstream)
  if (!(await workstreams.projections.belongs(workstream, [owner]))) throw new Refused('unknown_workstream')
  const offset = integer(args, 'offset', 1, 1, 1_000_000_000)
  return readText(await read(pool, workstream, offset, integer(args, 'limit', READ_LIMIT.lines, 1, READ_LIMIT.lines)), offset)
}

function reply(res: ServerResponse, status: number, reason: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify({ reason }))
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new Refused('too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function serve(workstreams: Workstreams, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (new URL(req.url ?? '/', 'http://mcp').pathname !== '/mcp') return reply(res, 404, 'not_found')
  // Stateless: no stream to open, no session to end.
  if (req.method !== 'POST') return reply(res, 405, 'method_not_allowed', { allow: 'POST' })
  const subject = SUBJECT.exec(String(req.headers[CALLER_HEADER] ?? ''))
  const caller = subject === null ? undefined : await workstreams.caller(subject[1]!)
  const owner = caller === undefined ? null : await workstreams.projections.ownerOf(caller.workstream)
  if (caller === undefined || owner === null) return reply(res, 401, 'unknown_caller')
  let message: unknown
  try {
    message = await body(req)
  } catch {
    return reply(res, 400, 'invalid_message')
  }
  const delegations = workstreams.delegations
  // Each tool once: a delegate that may delegate holds `send_message` by both its rights.
  const tools = [
    ...new Set(caller.profiles.flatMap((profile) => (delegations === null && profile !== 'agora:read' ? [] : (RIGHTS[profile] ?? [])))),
    ...(workstreams.merges !== null && caller.profiles.some((p) => GITHUB_WRITE.test(p)) ? [PROPOSE_MERGE] : []),
  ]
  const execution = subject![1]!
  const server = new Server({ name: 'agora', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.name === request.params.name)
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, 'not_allowed')
    const args = request.params.arguments ?? {}
    try {
      if (tool.name === 'propose_merge') return { content: [{ type: 'text', text: await workstreams.merges!.propose({ workstream: caller.workstream, execution, profiles: caller.profiles }, args) }] }
      if (DELEGATION.has(tool.name)) {
        const who = { workstream: caller.workstream, execution, profiles: caller.profiles }
        if (tool.name === 'send_message') return { content: [{ type: 'text', text: await delegations!.send(who, args) }] }
        if (tool.name === 'stop_agent') return { content: [{ type: 'text', text: await delegations!.stop(who, args) }] }
        if (tool.name === 'list_agents') return { content: [{ type: 'text', text: await delegations!.list(who) }] }
        // A held call hears progress, so that no harness gives up first (docs/specs/delegation.md, "Approval").
        const token = request.params._meta?.progressToken
        let progress = 0
        const hold = {
          progress: () => {
            if (token !== undefined) void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: 'waiting for the person’s approval' } })
          },
          aborted: extra.signal,
          toolUseId: typeof request.params._meta?.['claudecode/toolUseId'] === 'string' ? (request.params._meta['claudecode/toolUseId'] as string) : null,
        }
        return { content: [{ type: 'text', text: await delegations!.spawn(who, args, hold) }] }
      }
      return { content: [{ type: 'text', text: await call(workstreams, owner, tool.name, args) }] }
    } catch (error) {
      const reason =
        error instanceof Refused || error instanceof DelegationRefused || error instanceof MergeRefused
          ? error.message
          : error instanceof Error && ['invalid_pattern', 'unknown_workstream'].includes(error.message)
            ? error.message
            : null
      if (reason === null) throw error
      return { content: [{ type: 'text', text: reason }], isError: true }
    }
  })
  // One JSON answer per message, but `spawn_agent`'s: an SSE stream, its progress then its answer (docs/specs/mcp.md, "The path").
  const streaming = object(message)?.method === 'tools/call' && object(object(message)?.params)?.name === 'spawn_agent'
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !streaming })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, message)
}

/** docs/specs/mcp.md: the server on its own port, `POST /mcp`. */
export function createMcpServer(workstreams: Workstreams): HttpServer {
  return createServer((req, res) => {
    serve(workstreams, req, res).catch((error: unknown) => {
      console.error('mcp:', error instanceof Error ? error.message : error)
      if (!res.headersSent) reply(res, 500, 'internal')
      else res.end()
    })
  })
}

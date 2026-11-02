// Agora's MCP server (docs/specs/mcp.md): the person's Workstreams, searched and read, for the agents the gateway lets
// through. Its port is the gateway's alone; the gateway's route `agora` names the execution that calls, and nothing
// else here says who calls.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { HEAD_LIMIT, OUTPUT_MODES, read, READ_LIMIT, search, type OutputMode, type ReadAnswer, type SearchAnswer } from './search.ts'
import { object } from './json.ts'
import type { Workstreams } from './workstreams.ts'
import { Refused as DelegationRefused } from './delegation.ts'

/** The header the gateway sets from the token's subject, over whatever the sandbox sent. */
export const CALLER_HEADER = 'x-agora-execution'
const SUBJECT = /^agora ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A message larger than this is no tool call of ours. */
const MAX_BODY = 1024 * 1024

const SEARCH: Tool = {
  name: 'search',
  description:
    'Search the person’s Workstreams — their conversations with agents, yours included — the way `grep -n` searches files. ' +
    'Each Workstream is a transcript of numbered lines: for each exchange, a `## <n> · <time> · you` header, the person’s lines, ' +
    'a `## <n> · agent` header, then the agent’s lines, and its tools as `[tool: <title>]` lines when `tools` is true. ' +
    'A delegate’s message from its caller has a `caller` header; a report of Agora’s, an `agora` header, its lines never searched. ' +
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
    'for each exchange a header naming who wrote — `you`, `caller` or `agora` —, their lines, an `agent` header, the agent’s lines and its tools — ' +
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

const DELEGATE: Tool = {
  name: 'delegate',
  description:
    'Hand work to another agent, which runs on its own as a sub-stream of your Workstream. The call answers once it has started; ' +
    'its outcome comes back to you later as a message from Agora — do not wait or poll for it, carry on or end your turn. ' +
    '`to` continues one of your delegates with a next message. `output_schema` asks for a result of that shape (a JSON Schema whose root is an object): ' +
    'give one when you will act on fields of the result — a verdict, findings, a number —, leave it out when you will read prose. ' +
    'Rights beyond your own wait for the person’s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      instructions: { type: 'string', description: 'The delegate’s first message, or the next one with `to`.' },
      harness: { type: 'string', description: 'claude-code, codex or opencode; yours by default.' },
      model: { type: 'string', description: 'A model the harness offers; its default otherwise.' },
      effort: { type: 'string', description: 'An effort the harness offers; its default otherwise.' },
      rights: { type: 'array', items: { type: 'string' }, description: 'The delegate’s rights, as profiles — e.g. github:owner/repo:read; none by default.' },
      output_schema: { type: 'object', description: 'A JSON Schema, its root an object: the shape of the result to hand back with `submit`.' },
      to: { type: 'string', format: 'uuid', description: 'One of your delegates, to continue.' },
    },
    required: ['instructions'],
    additionalProperties: false,
  },
}

/** `submit`, its input the schema the delegation asked for (docs/specs/delegation.md, "Typed results"). */
const submitTool = (schema: Record<string, unknown>): Tool => ({
  name: 'submit',
  description: 'Hand your result to the agent that asked for it: once, when the work is done, in the shape it asked.',
  inputSchema: schema as Tool['inputSchema'],
})

/** The tools each right opens (docs/specs/mcp.md, "The path"); `agora:submit`'s depends on the step. */
const RIGHTS: Readonly<Record<string, readonly Tool[]>> = { 'agora:read': [SEARCH, READ], 'agora:delegate': [DELEGATE] }

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
  const tools = caller.profiles.flatMap((profile) => (delegations === null && profile === 'agora:delegate' ? [] : (RIGHTS[profile] ?? [])))
  if (delegations !== null && caller.profiles.includes('agora:submit')) {
    const schema = await delegations.schemaOf(caller.workstream)
    if (schema !== null) tools.push(submitTool(schema))
  }
  const execution = subject![1]!
  const server = new Server({ name: 'agora', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.name === request.params.name)
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, 'not_allowed')
    const args = request.params.arguments ?? {}
    try {
      if (tool.name === 'delegate' || tool.name === 'submit') {
        const who = { workstream: caller.workstream, execution, profiles: caller.profiles }
        if (tool.name === 'submit') return { content: [{ type: 'text', text: await delegations!.submit(who, args) }] }
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
        return { content: [{ type: 'text', text: await delegations!.delegate(who, args, hold) }] }
      }
      return { content: [{ type: 'text', text: await call(workstreams, owner, tool.name, args) }] }
    } catch (error) {
      const reason =
        error instanceof Refused || error instanceof DelegationRefused
          ? error.message
          : error instanceof Error && ['invalid_pattern', 'unknown_workstream'].includes(error.message)
            ? error.message
            : null
      if (reason === null) throw error
      return { content: [{ type: 'text', text: reason }], isError: true }
    }
  })
  // One JSON answer per message, but `delegate`'s: an SSE stream, its progress then its answer (docs/specs/mcp.md, "The path").
  const streaming = object(message)?.method === 'tools/call' && object(object(message)?.params)?.name === 'delegate'
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

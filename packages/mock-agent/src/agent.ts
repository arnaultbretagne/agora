// The lab's ACP agent (docs/specs/executions.md, "The lab"): no model, deterministic behaviours chosen by
// the prompt text, and a REAL native transcript under $HOME that session/resume and session/load
// read back — so an anchor restored into another sandbox is checked by asking what was said before.
//
// JSON-RPC 2.0 over newline-delimited stdio, the ACP transport. Method and field names are those of
// the ACP 1.5.0 schema (@agentclientprotocol/sdk 1.5.0).
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { connect as tlsConnect } from 'node:tls'
import { sessionsDir } from './storage.ts'
import { mockFile } from './file.ts'

type Id = string | number
interface Message {
  jsonrpc?: string
  id?: Id
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}
interface Entry {
  readonly sessionId: string
  readonly ts: string
  readonly role: 'user' | 'agent'
  readonly text: string
}
interface Session {
  readonly id: string
  readonly cwd: string
  readonly history: Entry[]
  /** Its settings' current values, by id (docs/specs/log.md, "Sessions"). */
  readonly settings: Record<string, string>
}

// The settings and commands the mock offers, shaped as claude-code's and codex's: a mode, a model with a
// `default`, an effort. `mock-broken` is listed but refused when chosen, for an answer in error.
const SETTINGS: { id: string; name: string; category: string; values: string[] }[] = [
  { id: 'mode', name: 'Mode', category: 'mode', values: ['default', 'full-access'] },
  { id: 'model', name: 'Model', category: 'model', values: ['default', 'mock-small', 'mock-large', 'mock-broken'] },
  { id: 'effort', name: 'Effort', category: 'thought_level', values: ['default', 'low', 'high'] },
]
const COMMANDS = [
  { name: 'recall', description: 'Repeat what was said before', input: null },
  { name: 'review', description: 'Review the changes', input: { hint: 'what to review' } },
]

const defaults = (): Record<string, string> => Object.fromEntries(SETTINGS.map((s) => [s.id, 'default']))
function configOptions(session: Session): unknown[] {
  return SETTINGS.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    type: 'select',
    currentValue: session.settings[s.id],
    options: s.values.map((value) => ({ value, name: value === 'default' ? 'Default' : value })),
  }))
}
interface Turn {
  cancelled: boolean
  wake: () => void
  /** What it answers a `_session/steering`: `injected` by default. */
  steering: string
  /** The messages taken into the turn and not yet heard. */
  steered: string[]
}

const home = process.env.HOME ?? '/tmp'
const sessions = new Map<string, Session>()
const turns = new Map<string, Turn>()
const outgoing = new Map<Id, (message: Message) => void>()
let initialized = false
let nextOutgoing = 1
/** The id of the prompt being answered, for the behaviours that write its answer themselves. */
let promptId: Id | undefined
let answerTwice = false

function send(message: Message): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function update(sessionId: string, value: Record<string, unknown>): void {
  send({ method: 'session/update', params: { sessionId, update: value } })
}

function say(sessionId: string, text: string): void {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

function request(method: string, params: Record<string, unknown>): Promise<Message> {
  const id = `mock-${String(nextOutgoing++)}`
  return new Promise((resolve) => {
    outgoing.set(id, resolve)
    send({ id, method, params })
  })
}

function transcriptPath(session: Session): string {
  return join(sessionsDir(home, session.cwd), `${session.id}.jsonl`)
}

function remember(session: Session, role: 'user' | 'agent', text: string): void {
  const entry: Entry = { sessionId: session.id, ts: new Date().toISOString(), role, text }
  session.history.push(entry)
  const path = transcriptPath(session)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(entry)}\n`)
}

function readTranscript(path: string): Entry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Entry)
}

// AGORA_MOCK_READ_AT_START=1: like opencode with its database, the transcripts are read once, when
// the agent starts, and never again — what an anchor placed later can only reach through a restart.
const atStart = new Map<string, Entry[]>()
if (process.env.AGORA_MOCK_READ_AT_START === '1') {
  const dir = sessionsDir(home, process.cwd())
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (name.endsWith('.jsonl')) atStart.set(name.slice(0, -'.jsonl'.length), readTranscript(join(dir, name)))
  }
  // Outside the native directory: the lab's tests wait for it, as a pool Pod has long been running.
  mkdirSync(join(home, '.mock-agent'), { recursive: true })
  writeFileSync(join(home, '.mock-agent', 'read-at-start'), String(process.pid))
}

function readSession(sessionId: string, cwd: string): Session | null {
  const session: Session = { id: sessionId, cwd, history: [], settings: defaults() }
  if (process.env.AGORA_MOCK_READ_AT_START === '1') {
    const history = atStart.get(sessionId)
    if (history === undefined) return null
    session.history.push(...history)
    return session
  }
  const path = transcriptPath(session)
  if (!existsSync(path)) return null
  session.history.push(...readTranscript(path))
  return session
}

/**
 * A tool of Agora's MCP server called as a harness calls it (docs/specs/mcp.md), at AGORA_MOCK_MCP — the lab has no
 * gateway —, the execution named as the gateway names it: its token's `sub`, which the bridge writes in
 * ~/.agora/access.json. One JSON answer, or an SSE stream whose last event is the answer.
 */
async function callAgora(name: string, args: Record<string, unknown>, turn: Turn): Promise<{ text: string; isError: boolean }> {
  const url = process.env.AGORA_MOCK_MCP
  if (url === undefined || url === '') return { text: 'AGORA_MOCK_MCP missing', isError: true }
  let sub: string
  try {
    sub = String((JSON.parse(readFileSync(join(home, '.agora', 'access.json'), 'utf8')) as { sub?: unknown }).sub ?? '')
  } catch {
    return { text: 'no access file', isError: true }
  }
  const aborted = new AbortController()
  turn.wake = () => aborted.abort()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-agora-execution': sub },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: aborted.signal,
    })
    const body = await response.text()
    const last = String(response.headers.get('content-type')).includes('text/event-stream')
      ? (body
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5))
          .at(-1) ?? '')
      : body
    const message = JSON.parse(last) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }
    if (message.error) return { text: String(message.error.message), isError: true }
    return { text: (message.result?.content ?? []).map((c) => c.text ?? '').join('\n'), isError: message.result?.isError === true }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}

/** What was sent into the turn since it last spoke, said as heard. */
function hear(session: Session, turn: Turn): void {
  for (const text of turn.steered.splice(0)) {
    remember(session, 'agent', `Heard: ${text}.`)
    say(session.id, `Heard: ${text}.\n`)
  }
}

/** Waits up to `ms`, returning early (with true) when the turn is cancelled. */
function pause(turn: Turn, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (turn.cancelled) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    turn.wake = () => {
      clearTimeout(timer)
      resolve(true)
    }
  })
}

interface Block {
  type?: string
  text?: string
  _meta?: Record<string, unknown>
  mimeType?: string
  data?: string
  resource?: { uri?: string; mimeType?: string; text?: string }
}

/** What a block other than text holds, as the agent would read it: an image's size, a file's length. */
function describe(block: Block): string | null {
  if (block.type === 'image') {
    const bytes = Buffer.from(block.data ?? '', 'base64')
    const size = dimensions(bytes)
    // The start of its SHA-256: what shows the bytes that reached the agent (Agora's docs/specs/files.md, B4).
    return `an image, ${String(block.mimeType)}${size ? `, ${size}` : ''}, ${String(bytes.length)} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`
  }
  if (block.type === 'resource') return `${String(block.resource?.uri)}, ${String(block.resource?.mimeType)}, ${String(block.resource?.text?.length ?? 0)} characters`
  return block.type === 'text' ? null : `a ${String(block.type)} block`
}

/** A prompt's text, Agora's line saying who writes left aside: what a command is read from. */
function words(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.type === 'text' && block._meta?.['agora.bretagne.dev/from'] === undefined)
    .map((block) => block.text ?? '')
    .join('\n')
}

/** A PNG's or a JPEG's width × height, from its header. */
function dimensions(b: Buffer): string | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return `${String(b.readUInt32BE(16))} × ${String(b.readUInt32BE(20))}`
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    // A start of frame, but the Huffman, arithmetic and JPEG-LS tables that share its range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return `${String(b.readUInt16BE(i + 7))} × ${String(b.readUInt16BE(i + 5))}`
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

async function prompt(session: Session, text: string, turn: Turn): Promise<string> {
  const [command, argument] = text.trim().split(/\s+/, 2)
  const n = Math.max(1, Math.min(3600, Number(argument ?? '5') || 5))

  switch (command) {
    // The agent changes a setting itself, and says so (docs/specs/log.md, L51).
    case '/config': {
      const [id, value] = (argument ?? '').split('=')
      if (id && value) session.settings[id] = value
      update(session.id, { sessionUpdate: 'config_option_update', configOptions: configOptions(session) })
      say(session.id, `Setting ${String(id)} is now ${String(value)}.`)
      return 'end_turn'
    }
    case '/commands': {
      update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: [...COMMANDS, { name: 'compact', description: 'Compact the context', input: null }] })
      say(session.id, 'Commands changed.')
      return 'end_turn'
    }
    // The context in use, as a real agent reports it after a turn (docs/specs/log.md, L66): `/usage used/size`.
    case '/usage': {
      const [used, size] = (argument ?? '').split('/').map(Number)
      update(session.id, { sessionUpdate: 'usage_update', used, size, cost: { amount: 0.42, currency: 'USD' } })
      say(session.id, `Context: ${String(used)} of ${String(size)}.`)
      return 'end_turn'
    }
    case '/sleep': {
      for (let i = 1; i <= n; i++) {
        if (await pause(turn, 1000)) return 'cancelled'
        hear(session, turn)
        say(session.id, `… second ${String(i)}/${String(n)}\n`)
      }
      remember(session, 'agent', `Slept ${String(n)} s.`)
      say(session.id, `Slept ${String(n)} s.`)
      return 'end_turn'
    }
    case '/silence': {
      if (await pause(turn, n * 1000)) return 'cancelled'
      remember(session, 'agent', `Done, after ${String(n)} s of silence.`)
      say(session.id, `Done, after ${String(n)} s of silence.`)
      return 'end_turn'
    }
    case '/permission': {
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Write demo.txt', kind: 'edit', status: 'pending' })
      const answer = await Promise.race([
        request('session/request_permission', {
          sessionId: session.id,
          toolCall: { toolCallId, title: 'Write demo.txt', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        }),
        new Promise<null>((resolve) => {
          turn.wake = () => resolve(null)
        }),
      ])
      if (answer === null || turn.cancelled) {
        update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
        return 'cancelled'
      }
      const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome
      const choice = outcome?.outcome === 'selected' ? String(outcome.optionId) : String(outcome?.outcome ?? 'erreur')
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: choice === 'allow-once' ? 'completed' : 'failed' })
      remember(session, 'agent', `Permission: ${choice}.`)
      say(session.id, `Permission: ${choice}.`)
      // `/permission 3`: the turn goes on that long once answered, as an agent with more to do.
      if (argument !== undefined) {
        if (await pause(turn, n * 1000)) return 'cancelled'
        hear(session, turn)
      }
      return 'end_turn'
    }
    // A running tool (docs/specs/log.md, L110): `pending`, then `in_progress`, open that many seconds, then closed as
    // asked; then the turn goes on, a second unless told: `/tool-open 2 failed 4`.
    case '/tool-open': {
      const [seconds, ending, after] = text.trim().split(/\s+/).slice(1)
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'A long command', kind: 'execute', status: 'pending' })
      if (await pause(turn, 300)) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
      if (await pause(turn, Number(seconds) * 1000)) {
        update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
        return 'cancelled'
      }
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: ending === 'failed' ? 'failed' : 'completed' })
      if (await pause(turn, Number(after ?? 1) * 1000)) return 'cancelled'
      hear(session, turn)
      remember(session, 'agent', 'Command done.')
      say(session.id, 'Command done.')
      return 'end_turn'
    }
    // A permission asked while a tool runs, the tool closing while it is pending; the turn goes on 2 s once answered (L114).
    case '/tool-permission': {
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'A long command', kind: 'execute', status: 'in_progress' })
      if (await pause(turn, 1000)) return 'cancelled'
      const asked = request('session/request_permission', {
        sessionId: session.id,
        toolCall: { toolCallId: `outil-${randomUUID().slice(0, 8)}`, title: 'Write demo.txt', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }],
      })
      if (await pause(turn, 300)) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
      await Promise.race([asked, new Promise((resolve) => (turn.wake = () => resolve(null)))])
      if (turn.cancelled || (await pause(turn, 2000))) return 'cancelled'
      hear(session, turn)
      say(session.id, 'Permission settled.')
      return 'end_turn'
    }
    // Tools in a row (docs/specs/assistant-ui.md, "Folded tools"): two, a text, two more, one asking a
    // permission, one running that many seconds, a text.
    case '/tool-run': {
      const tool = (title: string, kind: string, status: string, content?: unknown[]): string => {
        const toolCallId = `outil-${randomUUID().slice(0, 8)}`
        update(session.id, { sessionUpdate: 'tool_call', toolCallId, title, kind, status, ...(content ? { content } : {}) })
        return toolCallId
      }
      const change = [{ type: 'diff', path: `${session.cwd}/demo.txt`, oldText: 'before\n', newText: 'after\n' }]
      say(session.id, 'Looking first.')
      tool('Read demo.txt', 'read', 'completed')
      tool('A failing command', 'execute', 'failed')
      say(session.id, 'Now the change.')
      tool('Edit demo.txt', 'edit', 'completed', change)
      tool('Search demo', 'search', 'completed')
      const write = tool('Write demo.txt', 'edit', 'pending', change)
      const asked = request('session/request_permission', {
        sessionId: session.id,
        toolCall: { toolCallId: write, title: 'Write demo.txt', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }],
      })
      await Promise.race([asked, new Promise((resolve) => (turn.wake = () => resolve(null)))])
      if (turn.cancelled) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: write, status: 'completed' })
      const long = tool('A long command', 'execute', 'in_progress')
      if (await pause(turn, n * 1000)) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: long, status: 'completed' })
      remember(session, 'agent', 'All done.')
      say(session.id, 'All done.')
      return 'end_turn'
    }
    // How `_session/steering` is answered during this turn (docs/specs/log.md, L111, L112, L116): `/steering <answer> <seconds>`.
    case '/steering': {
      const [answer, seconds] = text.trim().split(/\s+/).slice(1)
      turn.steering = String(answer)
      if (await pause(turn, Number(seconds) * 1000)) return 'cancelled'
      hear(session, turn)
      remember(session, 'agent', 'Steered or not.')
      say(session.id, 'Steered or not.')
      return 'end_turn'
    }
    // Speaks after its turn's answer (docs/specs/log.md, L120), as Claude Code does once a background task ends.
    case '/late': {
      setTimeout(() => {
        const toolCallId = `outil-${randomUUID().slice(0, 8)}`
        update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Read the output', kind: 'read', status: 'completed' })
        say(session.id, 'Said after the answer.')
      }, 500)
      say(session.id, 'Before the answer.')
      return 'end_turn'
    }
    // A turn that ends as it would have, a `session/cancel` or not (docs/specs/log.md, L118).
    case '/stubborn': {
      await new Promise((resolve) => setTimeout(resolve, n * 1000))
      say(session.id, 'Done all the same.')
      return 'end_turn'
    }
    // The agent dies during a turn (docs/specs/log.md, L117): the adapter exits after that many seconds.
    case '/die': {
      if (await pause(turn, n * 1000)) return 'cancelled'
      process.exit(3)
    }
    case '/tool': {
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Edit demo.txt',
        kind: 'edit',
        status: 'in_progress',
        content: [{ type: 'diff', path: `${session.cwd}/demo.txt`, oldText: 'before\n', newText: 'after\n' }],
      })
      if (await pause(turn, 500)) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
      remember(session, 'agent', 'Tool done.')
      say(session.id, 'Tool done.')
      return 'end_turn'
    }
    // A file a tool returns, as Claude Code's `Read` gives an image: in the tool's content and in its raw
    // output, `/file <bytes> <seed>` (Agora's docs/specs/files.md, B1).
    case '/file': {
      const [, size, seed] = text.trim().split(/\s+/)
      const data = mockFile(Math.max(1, Math.min(6 * 1024 * 1024, Number(size) || 1)), Number(seed) || 0).toString('base64')
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Read image.png', kind: 'read', status: 'pending' })
      update(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }],
        rawOutput: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
      })
      remember(session, 'agent', 'File read.')
      say(session.id, 'File read.')
      return 'end_turn'
    }
    // The prompt answered with an error of the agent's, its process going on (docs/specs/delegation.md, D27).
    case '/turn-error': {
      fail(promptId, -32000, 'the model refused')
      return 'end_turn'
    }
    // One message of N characters (docs/specs/delegation.md, D19, U65).
    case '/words': {
      say(session.id, 'word '.repeat(Math.ceil(Number(argument) / 5)).slice(0, Number(argument)))
      return 'end_turn'
    }
    case '/big': {
      const kib = Math.min(n, 4096)
      for (let i = 0; i < kib; i++) say(session.id, `${String(i).padStart(5, '0')} ${'x'.repeat(1017)}\n`)
      remember(session, 'agent', `${String(kib)} KiB sent.`)
      return 'end_turn'
    }
    case '/raw': {
      // Lines written byte for byte as given (base64 of newline-separated lines), invalid UTF-8
      // included: what the log must keep or refuse.
      const bytes = Buffer.from(argument ?? '', 'base64')
      for (let start = 0; start < bytes.length; ) {
        const newline = bytes.indexOf(0x0a, start)
        const end = newline < 0 ? bytes.length : newline
        if (end > start) process.stdout.write(Buffer.concat([bytes.subarray(start, end), Buffer.from('\n')]))
        start = end + 1
      }
      return 'end_turn'
    }
    case '/invalid-then-valid': {
      // An answer to this very prompt whose body is invalid, then, a moment later, the valid one.
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 42 } })}\n`)
      if (await pause(turn, 1000)) return 'cancelled'
      return 'end_turn'
    }
    case '/answer-twice': {
      answerTwice = true
      return 'end_turn'
    }
    // What claude-agent-acp answers when the Claude Code process under it dies: an internal error,
    // the adapter itself still running.
    case '/fail':
      throw new Error('mock-agent: /fail asked, the agent process exited')
    case '/crash': {
      process.stderr.write('mock-agent: /crash asked, exiting with code 3\n')
      process.exit(3)
    }
    case '/fetch': {
      // /fetch [METHOD] URL [BODY…]
      const words = text.trim().split(/\s+/).slice(1)
      const method = /^[A-Z]+$/.test(words[0] ?? '') ? (words.shift() as string) : 'GET'
      const reply = await fetchOut(method, words.shift() ?? 'https://api.anthropic.com/v1/models', words.join(' '))
      remember(session, 'agent', reply)
      say(session.id, reply)
      return 'end_turn'
    }
    case '/spawn_agent':
    case '/send_message':
    case '/stop_agent':
    case '/list_agents': {
      // /<tool> {json}: a call to one of Agora's delegation tools, as a harness makes one (docs/specs/delegation.md): its
      // tool line, the call to Agora's MCP server, then its answer on the line and in a message.
      const name = text.trim().split(/\s/)[0]!.slice(1)
      const args = JSON.parse(text.trim().slice(name.length + 1).trim() || '{}') as Record<string, unknown>
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput: args })
      const answer = await callAgora(name, args, turn)
      if (turn.cancelled) return 'cancelled'
      update(session.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: answer.isError ? 'failed' : 'completed',
        rawOutput: answer.text,
        content: [{ type: 'content', content: { type: 'text', text: answer.text } }],
      })
      const said = `${{ spawn_agent: 'Delegated', send_message: 'Sent', stop_agent: 'Stopped', list_agents: 'Listed' }[name] ?? name}: ${answer.text}`
      remember(session, 'agent', said)
      say(session.id, said)
      return 'end_turn'
    }
    case '/propose_merge': {
      // /propose_merge {json}: a `propose_merge` call (docs/specs/merge.md), as `/spawn_agent` makes its own.
      const args = JSON.parse(text.trim().slice('/propose_merge'.length).trim() || '{}') as Record<string, unknown>
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'propose_merge', kind: 'other', status: 'in_progress', rawInput: args })
      const answer = await callAgora('propose_merge', args, turn)
      if (turn.cancelled) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: answer.isError ? 'failed' : 'completed', rawOutput: answer.text, content: [{ type: 'content', content: { type: 'text', text: answer.text } }] })
      remember(session, 'agent', `Proposed: ${answer.text}`)
      say(session.id, `Proposed: ${answer.text}`)
      return 'end_turn'
    }
    case '/recall': {
      const said = session.history.filter((entry) => entry.role === 'user').map((entry) => `"${entry.text}"`)
      const text = `You told me, in order: ${said.join(', ')}.`
      remember(session, 'agent', text)
      say(session.id, text)
      return 'end_turn'
    }
    default: {
      const users = session.history.filter((entry) => entry.role === 'user')
      const previous = users.at(-2)
      const reply = `Echo #${String(users.length)}: ${text}.${previous === undefined ? '' : ` Before, you told me "${previous.text}".`}`
      remember(session, 'agent', reply)
      say(session.id, reply)
      return 'end_turn'
    }
  }
}

/**
 * A request through HTTPS_PROXY, the way a real harness goes out (docs/specs/credentials.md): CONNECT to
 * the proxy, then TLS trusted by the system store plus NODE_EXTRA_CA_CERTS. Answers with what came back.
 */
async function fetchOut(method: string, address: string, requestBody: string): Promise<string> {
  let target: URL
  try {
    target = new URL(address)
  } catch {
    return `invalid URL: ${address}`
  }
  if (target.protocol !== 'https:') return 'https:// only'
  const proxy = process.env.HTTPS_PROXY
  if (proxy === undefined || proxy === '') return 'HTTPS_PROXY missing'
  const authority = `${target.hostname}:${target.port === '' ? '443' : target.port}`
  try {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const connect = httpRequest(proxy, { method: 'CONNECT', path: authority, headers: { host: authority } })
      connect.once('connect', (response, tunnel) => {
        if (response.statusCode === 200) return resolve(tunnel)
        tunnel.destroy()
        reject(new Error(`CONNECT ${authority} refused by the proxy: ${String(response.statusCode)}`))
      })
      connect.once('error', reject)
      connect.setTimeout(15_000, () => connect.destroy(new Error('CONNECT unanswered')))
      connect.end()
    })
    const secure = tlsConnect({ socket, servername: target.hostname })
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve)
      secure.once('error', reject)
    })
    const payload = Buffer.from(requestBody)
    const requestHead = `${method} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: */*\r\nUser-Agent: agora-mock\r\nConnection: close\r\n`
    secure.write(`${requestHead}${payload.length > 0 ? `Content-Type: application/json\r\nContent-Length: ${String(payload.length)}\r\n` : ''}\r\n`)
    if (payload.length > 0) secure.write(payload)
    const chunks: Buffer[] = []
    for await (const chunk of secure) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const [head = '', body = ''] = raw.split('\r\n\r\n', 2)
    return `${head.split('\r\n')[0] ?? '?'} — ${body.slice(0, 300)}`
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

function fail(id: Id | undefined, code: number, message: string): void {
  if (id !== undefined) send({ id, error: { code, message } })
}

async function handle(message: Message): Promise<void> {
  if (message.method === undefined) {
    // A response to one of our requests (session/request_permission).
    if (message.id !== undefined) outgoing.get(message.id)?.(message)
    if (message.id !== undefined) outgoing.delete(message.id)
    return
  }
  if (message.method !== 'initialize' && !initialized) return fail(message.id, -32603, 'Not initialized')
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      if (initialized) return fail(message.id, -32603, 'Already initialized')
      initialized = true
      const delay = Number(process.env.AGORA_MOCK_INITIALIZE_DELAY_MS ?? 0)
      if (delay > 0) {
        mkdirSync(join(home, '.mock-agent'), { recursive: true })
        appendFileSync(join(home, '.mock-agent', 'initialize-requests'), `${String(message.id)}\n`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      // An answer whose body the schema refuses, for the log's validation (docs/specs/log.md, L41).
      if (process.env.AGORA_MOCK_INITIALIZE_INVALID === '1') return send({ id: message.id, result: { protocolVersion: 'one' } })
      return send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {} },
          },
          agentInfo: { name: 'agora-mock-agent', title: 'The lab\'s mock agent', version: '1.0.0' },
          authMethods: [],
          // AGORA_MOCK_NO_STEERING=1: as opencode, no message into a running turn.
          ...(process.env.AGORA_MOCK_NO_STEERING === '1' ? {} : { _meta: { steering: { supported: true } } }),
        },
      })
    }
    case 'session/new': {
      const session: Session = { id: randomUUID(), cwd: String(params.cwd ?? '/home/harness/work'), history: [], settings: defaults() }
      sessions.set(session.id, session)
      send({ id: message.id, result: { sessionId: session.id, configOptions: configOptions(session) } })
      return update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS })
    }
    case 'session/set_config_option': {
      const session = sessions.get(String(params.sessionId))
      if (session === undefined) return fail(message.id, -32002, `unknown session: ${String(params.sessionId)}`)
      const setting = SETTINGS.find((s) => s.id === params.configId)
      if (setting === undefined || typeof params.value !== 'string' || !setting.values.includes(params.value))
        return fail(message.id, -32602, `invalid setting: ${String(params.configId)}=${String(params.value)}`)
      // AGORA_MOCK_SILENT_SETTINGS=1: an agent that never answers a change of setting.
      if (process.env.AGORA_MOCK_SILENT_SETTINGS === '1') return
      // Answered after a while, as an agent that reloads its model does: the change can be seen pending.
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (params.value === 'mock-broken') return fail(message.id, -32603, 'this model cannot be used')
      session.settings[setting.id] = params.value
      return send({ id: message.id, result: { configOptions: configOptions(session) } })
    }
    case 'session/load':
    case 'session/resume': {
      const session = readSession(String(params.sessionId), String(params.cwd ?? '/home/harness/work'))
      if (session === null) return fail(message.id, -32002, `session inconnue : ${String(params.sessionId)}`)
      sessions.set(session.id, session)
      if (message.method === 'session/load') {
        for (const entry of session.history) {
          update(session.id, {
            sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: entry.text },
          })
        }
      }
      send({ id: message.id, result: { configOptions: configOptions(session) } })
      return update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS })
    }
    case 'session/prompt': {
      const session = sessions.get(String(params.sessionId))
      if (session === undefined) return fail(message.id, -32002, `session inconnue : ${String(params.sessionId)}`)
      if (turns.has(session.id)) return fail(message.id, -32603, 'a turn is already in progress')
      const blocks = Array.isArray(params.prompt) ? (params.prompt as Block[]) : []
      const received = blocks.map(describe).filter((d) => d !== null)
      if (received.length > 0) say(session.id, `Received ${received.join('; ')}.\n\n`)
      const text = words(blocks)
      remember(session, 'user', text)
      const turn: Turn = { cancelled: false, wake: () => {}, steering: 'injected', steered: [] }
      turns.set(session.id, turn)
      try {
        promptId = message.id
        const stopReason = await prompt(session, text, turn)
        send({ id: message.id, result: { stopReason } })
        if (answerTwice) send({ id: message.id, result: { stopReason } })
        answerTwice = false
      } finally {
        turns.delete(session.id)
      }
      return
    }
    case 'session/cancel': {
      const turn = turns.get(String(params.sessionId))
      if (turn !== undefined) {
        turn.cancelled = true
        turn.wake()
      }
      return
    }
    // A message for the running turn, as claude-agent-acp and codex-acp take one: `promptRequired` with no turn running.
    case '_session/steering': {
      if (process.env.AGORA_MOCK_NO_STEERING === '1') return fail(message.id, -32601, `unknown method: ${message.method}`)
      const session = sessions.get(String(params.sessionId))
      if (session === undefined) return fail(message.id, -32002, `session inconnue : ${String(params.sessionId)}`)
      const turn = turns.get(session.id)
      if (turn === undefined) return send({ id: message.id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } })
      if (turn.steering === 'error') return fail(message.id, -32000, 'steering refused')
      if (turn.steering === 'silent') return
      if (turn.steering === 'promptRequired') return send({ id: message.id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } })
      if (turn.steering === 'failed') return send({ id: message.id, result: { outcome: 'failed', message: 'steering failed' } })
      const text = words(Array.isArray(params.prompt) ? (params.prompt as Block[]) : [])
      remember(session, 'user', text)
      turn.steered.push(text)
      // `late`: answered after a while, for a restart in between (docs/specs/log.md, L116).
      if (turn.steering === 'late') await new Promise((resolve) => setTimeout(resolve, 2500))
      return send({ id: message.id, result: { outcome: 'injected' } })
    }
    default:
      return fail(message.id, -32601, `unknown method: ${message.method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let message: Message
  try {
    message = JSON.parse(line) as Message
  } catch {
    return send({ id: null as unknown as Id, error: { code: -32700, message: 'JSON invalide' } })
  }
  handle(message).catch((error: unknown) => fail(message.id, -32603, error instanceof Error ? error.message : String(error)))
})
process.stdin.on('end', () => process.exit(0))

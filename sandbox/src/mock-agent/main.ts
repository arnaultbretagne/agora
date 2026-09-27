// The lab's ACP agent (sandbox-backend.md, "Le banc"): no model, deterministic behaviours chosen by
// the prompt text, and a REAL native transcript under $HOME that session/resume and session/load
// read back — so an anchor restored into another sandbox is checked by asking what was said before.
//
// JSON-RPC 2.0 over newline-delimited stdio, the ACP transport. Method and field names are those of
// the ACP 1.5.0 schema (@agentclientprotocol/sdk 1.5.0).
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { mockLayout } from '../shared/transcript.ts'

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
}
interface Turn {
  cancelled: boolean
  wake: () => void
}

const home = process.env.HOME ?? '/tmp'
const sessions = new Map<string, Session>()
const turns = new Map<string, Turn>()
const outgoing = new Map<Id, (message: Message) => void>()
let initialized = false
let nextOutgoing = 1

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
  return mockLayout(home, session.cwd).pathFor(session.id)
}

function remember(session: Session, role: 'user' | 'agent', text: string): void {
  const entry: Entry = { sessionId: session.id, ts: new Date().toISOString(), role, text }
  session.history.push(entry)
  const path = transcriptPath(session)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(entry)}\n`)
}

function readSession(sessionId: string, cwd: string): Session | null {
  const session: Session = { id: sessionId, cwd, history: [] }
  const path = transcriptPath(session)
  if (!existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    session.history.push(JSON.parse(line) as Entry)
  }
  return session
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

async function prompt(session: Session, text: string, turn: Turn): Promise<string> {
  const [command, argument] = text.trim().split(/\s+/, 2)
  const n = Math.max(1, Math.min(3600, Number(argument ?? '5') || 5))

  switch (command) {
    case '/sleep': {
      for (let i = 1; i <= n; i++) {
        if (await pause(turn, 1000)) return 'cancelled'
        say(session.id, `… seconde ${String(i)}/${String(n)}\n`)
      }
      remember(session, 'agent', `J'ai dormi ${String(n)} s.`)
      say(session.id, `J'ai dormi ${String(n)} s.`)
      return 'end_turn'
    }
    case '/silence': {
      if (await pause(turn, n * 1000)) return 'cancelled'
      remember(session, 'agent', `Fini, après ${String(n)} s de silence.`)
      say(session.id, `Fini, après ${String(n)} s de silence.`)
      return 'end_turn'
    }
    case '/permission': {
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Écrire demo.txt', kind: 'edit', status: 'pending' })
      const answer = await Promise.race([
        request('session/request_permission', {
          sessionId: session.id,
          toolCall: { toolCallId, title: 'Écrire demo.txt', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'allow-once', name: 'Autoriser', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Refuser', kind: 'reject_once' },
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
      remember(session, 'agent', `Permission : ${choice}.`)
      say(session.id, `Permission : ${choice}.`)
      return 'end_turn'
    }
    case '/tool': {
      const toolCallId = `outil-${randomUUID().slice(0, 8)}`
      update(session.id, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Modifier demo.txt',
        kind: 'edit',
        status: 'in_progress',
        content: [{ type: 'diff', path: `${session.cwd}/demo.txt`, oldText: 'avant\n', newText: 'après\n' }],
      })
      if (await pause(turn, 500)) return 'cancelled'
      update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
      remember(session, 'agent', 'Outil terminé.')
      say(session.id, 'Outil terminé.')
      return 'end_turn'
    }
    case '/big': {
      const kib = Math.min(n, 4096)
      for (let i = 0; i < kib; i++) say(session.id, `${String(i).padStart(5, '0')} ${'x'.repeat(1017)}\n`)
      remember(session, 'agent', `${String(kib)} Kio envoyés.`)
      return 'end_turn'
    }
    case '/crash': {
      process.stderr.write('mock-agent : /crash demandé, sortie code 3\n')
      process.exit(3)
    }
    case '/recall': {
      const said = session.history.filter((entry) => entry.role === 'user').map((entry) => `« ${entry.text} »`)
      const text = `Tu m'as dit, dans l'ordre : ${said.join(', ')}.`
      remember(session, 'agent', text)
      say(session.id, text)
      return 'end_turn'
    }
    default: {
      const users = session.history.filter((entry) => entry.role === 'user')
      const previous = users.at(-2)
      const reply = `Écho n°${String(users.length)} : ${text}.${previous === undefined ? '' : ` Avant, tu m'avais dit « ${previous.text} ».`}`
      remember(session, 'agent', reply)
      say(session.id, reply)
      return 'end_turn'
    }
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
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      if (initialized) return fail(message.id, -32603, 'Already initialized')
      initialized = true
      return send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: { resume: {} },
          },
          agentInfo: { name: 'agora-mock-agent', title: 'Agent mock du banc', version: '1.0.0' },
          authMethods: [],
        },
      })
    }
    case 'session/new': {
      const session: Session = { id: randomUUID(), cwd: String(params.cwd ?? '/home/harness/work'), history: [] }
      sessions.set(session.id, session)
      return send({ id: message.id, result: { sessionId: session.id } })
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
      return send({ id: message.id, result: {} })
    }
    case 'session/prompt': {
      const session = sessions.get(String(params.sessionId))
      if (session === undefined) return fail(message.id, -32002, `session inconnue : ${String(params.sessionId)}`)
      if (turns.has(session.id)) return fail(message.id, -32603, 'un tour est déjà en cours')
      const blocks = Array.isArray(params.prompt) ? (params.prompt as { type?: string; text?: string }[]) : []
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
      remember(session, 'user', text)
      const turn: Turn = { cancelled: false, wake: () => {} }
      turns.set(session.id, turn)
      try {
        const stopReason = await prompt(session, text, turn)
        send({ id: message.id, result: { stopReason } })
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
    default:
      return fail(message.id, -32601, `méthode inconnue : ${message.method}`)
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

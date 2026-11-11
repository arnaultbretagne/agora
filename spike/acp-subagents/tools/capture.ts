// Spike only: an ACP client that talks to a harness bridge the way Agora does (one WebSocket, one raw
// line per message), declares or not `clientCapabilities.subagents`, runs the scenario's prompts and
// writes every raw line, both directions, with its time, to a JSONL file.
//   node capture.ts <scenario.json> <pod ip> <pod name> <bridge private pem> <gateway credentials json> <out.jsonl> [anchor.json]
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { createPrivateKey } from 'node:crypto'
import WebSocket from 'ws'
import { mintBridgeToken } from '../../../packages/harness-bridge/src/token.ts'

interface Step {
  prompt: string
  /** Cancel: the parent session, or the first announced child that advertises `cancel`. */
  cancel?: { target: 'parent' | 'child'; afterMs: number; from?: 'prompt' | 'child' }
  /** How long to keep listening once the prompt is answered (output outside a turn). */
  lingerMs?: number
  timeoutMs?: number
  /** Answer permission requests: allow (default) or wait this long before answering. */
  permissionDelayMs?: number
}
interface SessionPlan {
  label: string
  open?: { method: 'session/resume' | 'session/load'; sessionOf: string }
  config?: [string, string][]
  steps: Step[]
}
interface Scenario {
  name: string
  subagents: boolean
  sessions: SessionPlan[]
}

const [scenarioFile, ip, podName, bridgeKeyFile, credsFile, out, anchorFile] = process.argv.slice(2) as string[]
const scenario = JSON.parse(readFileSync(scenarioFile!, 'utf8')) as Scenario
const bridgeKey = createPrivateKey(readFileSync(bridgeKeyFile!))
const token = (): string => mintBridgeToken(bridgeKey, podName!)
const base = `http://${ip}:8080`
const started = Date.now()
writeFileSync(out!, '')
let seq = 0
let label = 'setup'
const record = (dir: 'out' | 'in', line: string): void => {
  appendFileSync(out!, `${JSON.stringify({ seq: ++seq, t: Date.now() - started, at: new Date().toISOString(), dir, label, line })}\n`)
}
const log = (message: string): void => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function put(path: string, body: string): Promise<void> {
  const response = await fetch(`${base}${path}`, { method: 'PUT', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body })
  const text = await response.text()
  if (!response.ok) throw new Error(`PUT ${path}: ${String(response.status)} ${text.slice(0, 200)}`)
  log(`PUT ${path}: ${String(response.status)} ${path === '/credentials' ? '(outbound described)' : text.slice(0, 120)}`)
}

await put('/credentials', readFileSync(credsFile!, 'utf8'))
if (anchorFile) await put('/anchor', readFileSync(anchorFile, 'utf8'))

const ws = new WebSocket(`ws://${ip}:8080/acp`, { headers: { authorization: `Bearer ${token()}` }, maxPayload: 16 * 1024 * 1024 })
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve())
  ws.once('error', reject)
})
log('connected')

let nextId = 1
const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; method: string }>()
type Listener = (message: Record<string, unknown>) => void
const listeners = new Set<Listener>()
/** child session id → its parent and whether it advertises cancel. */
const children = new Map<string, { parent: string; cancel: boolean; firstAt: number }>()
const cancelled = new Set<string>()
const openPermissions = new Map<unknown, { session: string; timer: NodeJS.Timeout | null }>()
let permissionDelayMs = 1500

function send(message: Record<string, unknown>): void {
  const line = JSON.stringify(message)
  record('out', line)
  ws.send(line)
}
function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve, method })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', method, params })
}
function answerPermission(id: unknown, session: string, params: Record<string, unknown>): void {
  if (!openPermissions.has(id)) return
  openPermissions.delete(id)
  if (cancelled.has(session)) {
    send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
    log(`permission ${String(id)} of ${session}: answered cancelled`)
    return
  }
  const options = (params.options as { optionId: string; kind: string }[] | undefined) ?? []
  const choice = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always') ?? options[0]
  send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: choice?.optionId } } })
  log(`permission ${String(id)} of ${session}: answered ${String(choice?.optionId)}`)
}

ws.on('message', (data) => {
  const line = data.toString()
  record('in', line)
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line) as Record<string, unknown>
  } catch {
    log('unparsable line')
    return
  }
  if ('id' in message && !('method' in message)) {
    const entry = pending.get(message.id as number)
    if (entry) {
      pending.delete(message.id as number)
      entry.resolve(message)
    }
    return
  }
  const params = (message.params ?? {}) as Record<string, unknown>
  if (message.method === 'session/update') {
    const update = (params.update ?? {}) as Record<string, unknown>
    if (update.sessionUpdate === 'subagent_update' && typeof update.sessionId === 'string') {
      const known = children.get(update.sessionId)
      const caps = update.capabilities as Record<string, unknown> | null | undefined
      const cancel = caps === undefined ? (known?.cancel ?? false) : caps !== null && caps.cancel != null
      if (!known) log(`child announced: ${update.sessionId} under ${String(params.sessionId)} "${String(update.title ?? '')}"`)
      children.set(update.sessionId, { parent: String(params.sessionId), cancel, firstAt: known?.firstAt ?? Date.now() })
      if (update.state !== undefined) log(`child ${update.sessionId}: state ${JSON.stringify(update.state)}`)
    }
  }
  if ('id' in message && typeof message.method === 'string') {
    if (message.method === 'session/request_permission') {
      const session = String(params.sessionId)
      log(`permission request ${String(message.id)} from ${session}${children.has(session) ? ' (a child)' : ''}`)
      const timer = setTimeout(() => answerPermission(message.id, session, params), permissionDelayMs)
      openPermissions.set(message.id, { session, timer })
    } else {
      log(`agent request ${message.method}: answered method not found`)
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  for (const listener of listeners) listener(message)
})
ws.on('close', (code, reason) => log(`socket closed ${String(code)} ${reason.toString()}`))

function optionValues(option: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const o of (option.options as Record<string, unknown>[] | undefined) ?? []) {
    if (Array.isArray(o.options)) for (const g of o.options as Record<string, unknown>[]) values.push(String(g.value))
    else values.push(String(o.value))
  }
  return values
}

label = 'initialize'
const clientCapabilities: Record<string, unknown> = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
if (scenario.subagents) clientCapabilities.subagents = {}
const init = await request('initialize', { protocolVersion: 1, clientCapabilities, clientInfo: { name: 'agora', version: '1' } })
log(`initialize answered: protocolVersion ${JSON.stringify((init.result as Record<string, unknown> | undefined)?.protocolVersion)}`)

const opened = new Map<string, string>()
for (const plan of scenario.sessions) {
  label = plan.label
  let sessionId: string
  let configOptions: Record<string, unknown>[] = []
  if (plan.open) {
    const target = plan.open.sessionOf.startsWith('id:') ? plan.open.sessionOf.slice(3) : opened.get(plan.open.sessionOf)
    if (!target) throw new Error(`no session for ${plan.open.sessionOf}`)
    const answer = await request(plan.open.method, { sessionId: target, cwd: '/home/harness/work', mcpServers: [] })
    if (answer.error) {
      log(`${plan.open.method} failed: ${JSON.stringify(answer.error).slice(0, 300)}`)
      continue
    }
    sessionId = target
    configOptions = ((answer.result as Record<string, unknown>).configOptions as Record<string, unknown>[] | undefined) ?? []
  } else {
    const answer = await request('session/new', { cwd: '/home/harness/work', mcpServers: [] })
    if (answer.error) throw new Error(`session/new failed: ${JSON.stringify(answer.error)}`)
    const result = answer.result as Record<string, unknown>
    sessionId = String(result.sessionId)
    configOptions = (result.configOptions as Record<string, unknown>[] | undefined) ?? []
  }
  opened.set(plan.label, sessionId)
  log(`${plan.label}: session ${sessionId}`)
  for (const [id, wanted] of plan.config ?? []) {
    const option = configOptions.find((o) => o.id === id)
    if (!option) {
      log(`config ${id}: not offered`)
      continue
    }
    const values = optionValues(option)
    const value = values.find((v) => v === wanted) ?? values.find((v) => v.toLowerCase().includes(wanted.toLowerCase()))
    if (!value) {
      log(`config ${id}: no value like ${wanted} among ${values.join(', ')}`)
      continue
    }
    if (option.currentValue === value) continue
    const answer = await request('session/set_config_option', { sessionId, configId: id, value })
    log(`config ${id}=${value}: ${answer.error ? JSON.stringify(answer.error) : 'ok'}`)
  }
  for (const [index, step] of plan.steps.entries()) {
    label = `${plan.label}#${String(index + 1)}`
    permissionDelayMs = step.permissionDelayMs ?? 1500
    const before = new Set(children.keys())
    const promptAt = Date.now()
    let cancelTimer: NodeJS.Timeout | null = null
    let childWatcher: Listener | null = null
    if (step.cancel?.target === 'parent' && step.cancel.from !== 'child') {
      cancelTimer = setTimeout(() => {
        log(`session/cancel on the parent ${sessionId}`)
        cancelled.add(sessionId)
        notify('session/cancel', { sessionId })
      }, step.cancel.afterMs)
    } else if (step.cancel) {
      const cancel = step.cancel
      childWatcher = () => {
        if (cancelTimer) return
        const child = [...children.entries()].find(([id, c]) => !before.has(id) && (cancel.target === 'parent' || c.cancel))
        if (!child) return
        cancelTimer = setTimeout(() => {
          const target = cancel.target === 'parent' ? sessionId : child[0]
          log(`session/cancel on ${cancel.target === 'parent' ? 'the parent' : 'the child'} ${target}`)
          cancelled.add(target)
          notify('session/cancel', { sessionId: target })
          for (const [id, p] of openPermissions) if (p.session === target) { if (p.timer) clearTimeout(p.timer); openPermissions.set(id, { ...p, timer: null }); answerPermission(id, target, {}) }
        }, cancel.afterMs)
      }
      listeners.add(childWatcher)
    }
    const answer = await Promise.race([
      request('session/prompt', { sessionId, prompt: [{ type: 'text', text: step.prompt }] }),
      sleep(step.timeoutMs ?? 240_000).then(() => null),
    ])
    if (cancelTimer) clearTimeout(cancelTimer)
    if (childWatcher) listeners.delete(childWatcher)
    if (answer === null) {
      log(`${label}: no answer within the timeout; cancelling`)
      notify('session/cancel', { sessionId })
      await sleep(5000)
    } else {
      const result = answer.result as Record<string, unknown> | undefined
      log(`${label}: answered in ${String(Date.now() - promptAt)} ms, ${answer.error ? `error ${JSON.stringify(answer.error).slice(0, 200)}` : `stopReason ${String(result?.stopReason)}`}`)
    }
    if (step.lingerMs) {
      log(`${label}: listening ${String(step.lingerMs)} ms after the answer`)
      await sleep(step.lingerMs)
    }
  }
}
label = 'end'
log(`done: ${String(seq)} lines, ${String(children.size)} children announced`)
ws.close()
await sleep(500)
process.exit(0)

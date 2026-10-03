// Plays acceptance cases of docs/specs/executions.md (E…, E30 on opencode), docs/specs/log.md (L…) and
// docs/specs/credentials.md (C1–C4, C8–C16) against the DEPLOYED lab, with real Kata sandboxes destroyed by
// Agent Sandbox at their deadline. C3 is a real, billed prompt: on haiku, one short answer. C4
// writes a dated file to GITHUB_A. C8–C13 look into the Pods and the gateway through KUBECTL
// (default `kubectl`), as the operator: a warm Pod has no execution to speak for it.
// Usage: node apps/lab/scripts/live-cases.ts http://<lab>:8080 [case IDs…] (the receiver is on port 8081).
// Each check's output is evidence for docs/reliability (docs/reliability/README.md).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { canonical, fold, type Entry, type State, type Turn } from '@agora/log'

const base = process.argv[2] ?? 'http://127.0.0.1:8080'
const receiver = base.replace(/:8080$/, ':8081')
const only = new Set(process.argv.slice(3).map((id) => id.toUpperCase()))
type Json = Record<string, any>

async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  })
  const text = await response.text()
  // Plain JSON: the runner compares numbers, and needs no integer beyond 2^53.
  return { status: response.status, ...((text === '' ? {} : JSON.parse(text)) as Json) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, find: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await Promise.resolve()
      .then(find)
      .catch(() => undefined)
    if (found !== undefined && found !== null && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(250)
  }
}

/** The mechanics' view of an execution: claim, deadline, Pod, launch type, connection. */
const view = async (execution: string) => ((await api('GET', '/api/executions')).executions as Json[]).find((v) => v.execution === execution)
const anchorText = async (id: string) => (await fetch(`${base}/api/anchors/${id}/content`)).text()

/** A Workstream of the lab, read through its entries and the log's own fold. */
class Workstream {
  readonly id = randomUUID()
  execution = ''
  session = ''
  async entries(): Promise<Entry[]> {
    return ((await (await fetch(`${base}/api/workstreams/${this.id}/entries`)).json()) as Entry[]) ?? []
  }
  async state(): Promise<State> {
    return fold(await this.entries())
  }
  command(kind: string, target: Json = {}, body: Json = {}, id = randomUUID()): Promise<Json> {
    return api('POST', `/api/workstreams/${this.id}/commands`, { id, kind, target, body })
  }
  /** Creates the Workstream and its execution; resolves once its Session is open. */
  async open(pool: string, body: Json = {}): Promise<{ ms: number }> {
    const started = Date.now()
    if (this.execution === '') await api('POST', '/api/workstreams', { id: this.id, owner: randomUUID() })
    const created = await this.command('Create', {}, { pool, ...body })
    if (created.status !== 200) throw new Error(`Create refused: ${JSON.stringify(created)}`)
    this.execution = String(created.execution)
    const e = await until('Session open', async () => {
      const current = (await this.state()).current
      return current?.id === this.execution && current.session && current.connection ? current : null
    }, 120_000)
    this.session = e.session!
    return { ms: Date.now() - started }
  }
  write(text: string): Promise<Json> {
    return this.command('Write', { execution: this.execution, session: this.session }, { prompt: [{ type: 'text', text }] })
  }
  async turn(status: string | string[], timeoutMs = 60_000): Promise<Turn> {
    const wanted = Array.isArray(status) ? status : [status]
    return until(`turn ${wanted.join('|')}`, async () => {
      const latest = [...(await this.state()).turns.values()].at(-1)
      return latest && wanted.includes(latest.status) ? latest : undefined
    }, timeoutMs)
  }
  stop(): Promise<Json> {
    return this.command('Stop', { execution: this.execution })
  }
  async said(): Promise<string> {
    return (await this.entries())
      .filter((x) => x.kind === 'acp' && x.direction === 'in' && x.method === 'session/update')
      .map((x) => (x.content.params as Json)?.update)
      .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
      .map((u) => String(u.content?.text ?? ''))
      .join('')
  }
  ended(timeoutMs: number): Promise<Entry> {
    return until('execution.ended', async () => (await this.entries()).find((x) => x.kind === 'execution.ended' && x.execution === this.execution), timeoutMs)
  }
}

const results: { id: string; label: string; ok: boolean; detail: string }[] = []
async function check(id: string, label: string, body: () => Promise<string>): Promise<void> {
  if (only.size > 0 && !only.has(id)) return
  const started = Date.now()
  try {
    const detail = await body()
    results.push({ id, label, ok: true, detail })
    console.log(`✔ ${id.padEnd(3)} ${label} — ${detail} (${String(Math.round((Date.now() - started) / 1000))} s)`)
  } catch (error) {
    results.push({ id, label, ok: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`✖ ${id.padEnd(3)} ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// Short leases in the lab: a stopped sandbox is destroyed at its deadline, at most a lease later.
const SHORT = { limits: { leaseSeconds: 60 } }
const active = async () => ((await api('GET', '/api/executions')).executions as Json[]).length

// ---------------------------------------------------------------- setup

const pools = (await api('GET', '/api/pools')).pools as Json[]
const mock = pools.find((p) => p.harness === 'mock')!.name as string
const claude = pools.find((p) => p.harness === 'claude-code')?.name as string | undefined
const opencode = pools.find((p) => p.harness === 'opencode')?.name as string | undefined
await until('room under the quota', async () => (await active()) <= 2, 660_000)
await until('warm pool full', async () => ((await api('GET', '/api/pools')).pools as Json[]).find((p) => p.name === mock)?.readyReplicas === 2, 120_000)
console.log(`pools: ${pools.map((p) => `${p.name as string} (${p.harness as string})`).join(', ')}`)

const a = new Workstream()

await check('E1', 'Create from a warm pool', async () => {
  const { ms } = await a.open(mock)
  const launch = await until('launchType', async () => (await view(a.execution))?.launchType, 10_000)
  assert(launch === 'warm', `launch ${String(launch)}`)
  const initialize = (await a.entries()).find((x) => x.kind === 'acp' && x.direction === 'in' && x.correlated_method === 'initialize')
  assert(initialize !== undefined, 'no initialize answered before ready')
  return `ready in ${String(ms)} ms, launch ${String(launch)}, initialize answered by ${String((initialize.content.result as Json)?.agentInfo?.name)}`
})

await check('E2', 'Create beyond the warm pool', async () => {
  // A has taken one of the two warm sandboxes; three claims at once outrun what the pool holds.
  const started = Date.now()
  const opened = [new Workstream(), new Workstream(), new Workstream()]
  const timings = await Promise.all(opened.map(async (w) => {
    await w.open(mock, SHORT)
    const launch = await until('launchType', async () => (await view(w.execution))?.launchType, 10_000)
    return { launch: String(launch), ms: Date.now() - started }
  }))
  for (const w of opened) await w.stop()
  const slow = timings.filter((t) => t.ms > 1500)
  assert(slow.length >= 1, `everything was already ready: ${JSON.stringify(timings)}`)
  return timings.map((t) => `${t.launch} ${String(t.ms)} ms`).join('; ')
})

await check('E3', 'Create replayed with the same command id', async () => {
  const w = new Workstream()
  await api('POST', '/api/workstreams', { id: w.id, owner: randomUUID() })
  const id = randomUUID()
  const [first, second] = await Promise.all([w.command('Create', {}, { pool: mock, ...SHORT }, id), w.command('Create', {}, { pool: mock, ...SHORT }, id)])
  // The replay is read back from the database: the same members, maybe in another order.
  assert(first.status === 200 && canonical(first) === canonical(second), JSON.stringify({ first, second }))
  w.execution = String(first.execution)
  const claims = ((await api('GET', '/api/executions')).executions as Json[]).filter((v) => v.execution === w.execution).length
  assert(claims === 1 && (await w.state()).executions.size === 1, `${String(claims)} claims`)
  await until('opened', async () => (await w.state()).current?.session, 120_000)
  await w.stop()
  return `the same answer twice, execution ${w.execution.slice(0, 8)}…, a single claim`
})

await check('E4', 'Pool not in the catalogue, quota', async () => {
  const w = new Workstream()
  await api('POST', '/api/workstreams', { id: w.id, owner: randomUUID() })
  const outside = await w.command('Create', {}, { pool: 'no-such-pool' })
  assert(outside.status === 409 && outside.reason === 'unknown_pool', JSON.stringify(outside))
  let refused: Json | null = null
  const opened: Workstream[] = []
  for (let i = 0; i < 8 && refused === null; i++) {
    const x = new Workstream()
    await api('POST', '/api/workstreams', { id: x.id, owner: randomUUID() })
    const answer = await x.command('Create', {}, { pool: mock, ...SHORT })
    if (answer.reason === 'quota') refused = answer
    else {
      x.execution = String(answer.execution)
      opened.push(x)
    }
  }
  assert(refused !== null, 'never refused')
  for (const x of opened) await until('stopped', async () => (await x.stop()).status === 200, 120_000).catch(() => undefined)
  return `"${String(outside.reason)}"; "${String(refused.reason)}"`
})

await check('L9', 'Write during a turn', async () => {
  assert((await a.write('/sleep 8')).status === 200, 'Write refused')
  await a.turn('in_progress', 10_000)
  const refused = await a.write('too early')
  assert(refused.status === 409 && refused.reason === 'turn_active', JSON.stringify(refused))
  return `"${String(refused.reason)}"`
})

await check('L12', 'Cancel on an uncertain turn still running', async () => {
  const running = await a.turn('in_progress', 10_000)
  const cut = await api('POST', `/api/lab/executions/${a.execution}/drop-bridge`, { pauseSeconds: 2 })
  assert(cut.accepted === true, JSON.stringify(cut))
  const turn = await a.turn('uncertain', 15_000)
  assert(turn.id === running.id, 'another turn')
  await until('reconnected', async () => (await a.state()).current?.connection, 30_000)
  assert((await a.command('Cancel', { execution: a.execution, turn: turn.id })).status === 200, 'Cancel refused')
  const ended = await a.turn('cancelled', 30_000)
  assert(ended.id === turn.id, 'another turn')
  assert((await a.write('after the cancel')).status === 200, 'Write refused after the cancel')
  await a.turn('done', 30_000)
  const cancels = (await a.entries()).filter((x) => x.kind === 'acp' && x.direction === 'out' && x.method === 'session/cancel')
  assert(cancels.length === 1, `${String(cancels.length)} session/cancel`)
  return 'uncertain after the cut, one session/cancel, cancelled, then a Write accepted'
})

let lost = ''
await check('E27', 'Agora away while the adapter writes', async () => {
  assert((await a.write('/silence 1')).status === 200, 'Write refused')
  await a.turn('in_progress', 10_000)
  const cut = await api('POST', `/api/lab/executions/${a.execution}/drop-bridge`, { pauseSeconds: 10 })
  assert(cut.accepted === true, JSON.stringify(cut))
  await a.turn('uncertain', 15_000)
  await a.turn('done', 60_000)
  // The adapter keeps writing while Agora is away: the pipe holds what is unread, then blocks it.
  const before = (await a.entries()).length
  assert((await a.write('/big 3600')).status === 200, 'Write refused')
  await until('first chunk', async () => (await a.entries()).slice(before).some((x) => x.kind === 'acp' && x.method === 'session/update'), 10_000)
  const away = await api('POST', `/api/lab/executions/${a.execution}/drop-bridge`, { pauseSeconds: 10 })
  assert(away.accepted === true, JSON.stringify(away))
  await a.turn('done', 120_000)
  const numbered = (await a.entries()).slice(before)
    .filter((x) => x.kind === 'acp' && x.method === 'session/update')
    .map((x) => String((x.content.params as Json)?.update?.content?.text))
    .filter((text) => /^\d{5} /.test(text))
  // Lines already sent into the cut connection may be lost (the relay's rule); what was still unread
  // arrives complete: in order, without a repeat, one gap at most, at the cut, and the end.
  const indexes = numbered.map((text) => Number(text.slice(0, 5)))
  assert(indexes.every((n, i) => i === 0 || n > indexes[i - 1]!), 'output out of order or repeated')
  const gaps = indexes.flatMap((n, i) => (i > 0 && n !== indexes[i - 1]! + 1 ? [{ from: indexes[i - 1]! + 1, to: n - 1 }] : []))
  assert(indexes[0] === 0 && indexes.at(-1) === 3599 && gaps.length <= 1, `gaps ${JSON.stringify(gaps)}, ${String(indexes.length)}/3600`)
  const gap = gaps[0]
  lost = gap === undefined ? 'none lost' : `${String(gap.to - gap.from + 1)} lines in flight lost at the cut (${String(gap.from)}–${String(gap.to)})`
  return `output written while Agora was away arrived in order, short and large; ${lost}`
})

async function restartLab(mode: 'clean' | 'kill'): Promise<void> {
  await api('POST', '/api/lab/restart', { mode }).catch(() => undefined)
  await until('lab down', async () => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true), 30_000).catch(() => true)
  await until('lab back', async () => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false), 180_000)
}

for (const [id, mode] of [['L17', 'clean'], ['L18', 'kill']] as const) {
  await check(id, `Agora ${mode === 'clean' ? 'stopped cleanly' : 'killed'} during a dispatched turn`, async () => {
    assert((await a.write('/sleep 20')).status === 200, 'Write refused')
    const turn = await a.turn('in_progress', 10_000)
    const connection = (await a.state()).current!.connection!
    await restartLab(mode)
    const broken = await until('the break', async () => (await a.entries()).find((x) => x.kind === 'execution.break' && x.content.connection === connection), 60_000)
    assert(broken.content.clean === (mode === 'clean'), `break clean=${String(broken.content.clean)}`)
    const status = (await a.state()).turns.get(turn.id)?.status
    assert(status === (mode === 'clean' ? 'in_progress' : 'uncertain'), `turn ${String(status)}`)
    await a.turn('done', 60_000)
    const entries = await a.entries()
    const prompts = entries.filter((x) => x.kind === 'acp' && x.direction === 'out' && x.method === 'session/prompt' && x.position === turn.requestPosition)
    const markers = entries.filter((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === turn.requestPosition)
    const initialize = entries.filter((x) => x.kind === 'acp' && x.direction === 'out' && x.method === 'initialize' && x.execution === a.execution)
    assert(prompts.length === 1 && markers.length === 1 && initialize.length === 1, JSON.stringify({ prompts: prompts.length, markers: markers.length, initialize: initialize.length }))
    return `break clean=${String(broken.content.clean)}, turn ${String(status)} then done; one dispatch, one initialize`
  })
}

await a.stop()
await until('room under the quota', async () => (await active()) <= 2, 240_000)

// The deadline cases wait on real destructions by Agent Sandbox: they run side by side.
let anchorToRestore = ''
const parallel: Promise<void>[] = []
parallel.push((async () => {
  const w = new Workstream()
  let granted = ''
  await check('E12', 'Deadline during a turn', async () => {
    await w.open(mock, SHORT)
    assert((await w.write('/sleep 45')).status === 200, 'Write refused')
    const turn = await w.turn('in_progress', 10_000)
    const admitted = (await view(w.execution))!.shutdownTime as string
    const later = await until('re-armed', async () => {
      const x = await view(w.execution)
      return x !== undefined && x.shutdownTime !== admitted ? (x.shutdownTime as string) : undefined
    }, 40_000)
    const cap = Date.parse(turn.startedAt!) + 3600 * 1000
    assert(Date.parse(later) <= cap && Date.parse(later) > Date.parse(admitted), 'not moved forward under the cap')
    await w.turn('done', 60_000)
    granted = (await view(w.execution))!.shutdownTime as string
    return `deadline ${admitted} → ${later} during the turn`
  })
  await check('E13', 'End of turn', async () => {
    await sleep(25_000)
    const x = await view(w.execution)
    assert(x?.shutdownTime === granted, `moved outside a turn: ${String(x?.shutdownTime)}`)
    return `deadline ${granted} set at the end of the turn, unchanged 25 s later`
  })
  await check('E14', 'Deadline reached between two turns', async () => {
    const end = await w.ended(150_000)
    assert(typeof end.content.anchor === 'string', JSON.stringify(end.content))
    return `destroyed by Agent Sandbox; anchor ${String(end.content.anchor)} pushed by the Pod`
  })
})())
parallel.push(check('E15', 'Turn too long', async () => {
  const w = new Workstream()
  await w.open(mock, { limits: { turnCapSeconds: 30 } })
  assert((await w.write('/sleep 120')).status === 200, 'Write refused')
  const end = await w.ended(150_000)
  const turn = [...(await w.state()).turns.values()].at(-1)!
  assert(typeof end.content.anchor === 'string' && turn.status === 'failed', JSON.stringify({ end: end.content, turn: turn.status }))
  return `destroyed with the turn in progress, turn ${turn.status}; anchor ${String(end.content.anchor)}`
}))
parallel.push(check('E16', 'Stop', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  assert((await w.write('mirabelle')).status === 200, 'Write refused')
  await w.turn('done', 30_000)
  const before = (await view(w.execution))!.shutdownTime
  assert((await w.stop()).status === 200, 'Stop refused')
  const end = await w.ended(150_000)
  assert((await view(w.execution)) === undefined, 'still followed')
  assert(typeof end.content.anchor === 'string', JSON.stringify(end.content))
  assert((await anchorText(String(end.content.anchor))).includes('mirabelle'), 'anchor without mirabelle')
  anchorToRestore = String(end.content.anchor)
  return `stopped, destroyed at the deadline ${String(before)}; anchor ${anchorToRestore}`
}))
parallel.push(check('E17', 'Stop during a turn', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  assert((await w.write('/sleep 120')).status === 200, 'Write refused')
  await w.turn('in_progress', 10_000)
  assert((await w.stop()).status === 200, 'Stop refused')
  await w.turn('cancelled', 30_000)
  const end = await w.ended(150_000)
  assert(typeof end.content.anchor === 'string', JSON.stringify(end.content))
  return `turn cancelled, destroyed at the deadline, anchor ${String(end.content.anchor)}`
}))
await Promise.all(parallel)

await check('E18', 'Restore an anchor', async () => {
  const w = new Workstream()
  const { ms } = await w.open(mock, { anchor: anchorToRestore, ...SHORT })
  const opened = (await w.entries()).findLast((x) => x.kind === 'session.opened')!
  assert(opened.content.origin === anchorToRestore, `origin ${String(opened.content.origin)}`)
  assert((await w.write('/recall')).status === 200, 'Write refused')
  await w.turn('done', 30_000)
  assert((await w.said()).includes('mirabelle'), 'amnesiac')
  await w.stop()
  return `ready in ${String(ms)} ms, a new Session on ACP session ${String(opened.content.acpId).slice(0, 8)}…, the agent remembers "mirabelle"`
})

await check('E19', 'Adapter died', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  assert((await w.write('before the fall')).status === 200, 'Write refused')
  await w.turn('done', 30_000)
  assert((await w.write('/crash')).status === 200, 'Write refused')
  const lost = await until('lost', async () => (await w.entries()).find((x) => x.kind === 'execution.lost'), 20_000)
  const shutdown = (await view(w.execution))?.shutdownTime
  const end = await w.ended(150_000)
  assert(lost.content.reason === 'adapter_exited' && typeof end.content.anchor === 'string', JSON.stringify({ lost: lost.content, end: end.content }))
  assert((await anchorText(String(end.content.anchor))).includes('before the fall'), 'empty anchor')
  return `lost (adapter_exited), deadline left at ${String(shutdown)}; anchor ${String(end.content.anchor)} pushed despite the dead adapter`
})

await check('E20', 'Tokens refused', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  const probe = await api('POST', `/api/lab/executions/${w.execution}/probe-auth`)
  const rows = probe.results as Json[]
  const bad = rows.slice(0, -1).filter((r) => r.info !== 401 || r.acp !== 401)
  assert(bad.length === 0 && rows.at(-1)!.info === 200 && rows.at(-1)!.acp === 101, JSON.stringify(rows))
  await w.stop()
  return rows.map((r) => `${String(r.case)} ${String(r.info)}/${String(r.acp)}`).join('; ')
})

await check('E21', 'Anchor push without a valid projected token', async () => {
  const body = JSON.stringify({ format: 'agora-anchor/1', harness: 'mock', files: [], stable: true })
  const before = ((await api('GET', '/api/anchors')).anchors as Json[]).length
  const statuses: number[] = []
  for (const headers of [{}, { authorization: 'Bearer not-a-token' }] as Record<string, string>[]) {
    statuses.push((await fetch(`${receiver}/anchors`, { method: 'POST', body, headers })).status)
  }
  const after = ((await api('GET', '/api/anchors')).anchors as Json[]).length
  assert(statuses.every((status) => status === 401) && after === before, JSON.stringify({ statuses, before, after }))
  return `no token ${String(statuses[0])}, fake token ${String(statuses[1])}; nothing stored`
})

await check('E22', 'Real harness (claude-code)', async () => {
  if (claude === undefined) throw new Error('no claude-code pool')
  const w = new Workstream()
  const { ms } = await w.open(claude, SHORT)
  const init = (await w.entries()).find((x) => x.kind === 'acp' && x.direction === 'in' && x.correlated_method === 'initialize')!
  assert((await w.write('Just answer: ok')).status === 200, 'Write refused')
  const answered = await w.turn(['done', 'failed'], 120_000).catch(() => null)
  if (answered === null) {
    const turn = await w.turn(['in_progress', 'uncertain'], 5_000)
    await w.command('Cancel', { execution: w.execution, turn: turn.id })
  }
  await w.stop()
  const end = await w.ended(180_000)
  let restored = 'no anchor to restore'
  if (typeof end.content.anchor === 'string') {
    const back = new Workstream()
    await back.open(claude, { anchor: end.content.anchor, ...SHORT })
    const opened = (await back.entries()).findLast((x) => x.kind === 'session.opened')!
    restored = `restored by ${opened.content.origin === end.content.anchor ? 'session/resume' : '?'} (ACP session ${String(opened.content.acpId).slice(0, 8)}…)`
    await back.stop()
  }
  const info = (init.content.result as Json)?.agentInfo
  return `ready in ${String(ms)} ms, ${String(info?.name)}@${String(info?.version)}, prompt: ${answered === null ? 'no answer in 120 s, cancelled' : answered.status}; ${restored}`
})

await check('E30', 'Real harness (opencode)', async () => {
  if (opencode === undefined) throw new Error('no opencode pool')
  const w = new Workstream()
  const { ms } = await w.open(opencode, SHORT)
  const init = (await w.entries()).find((x) => x.kind === 'acp' && x.direction === 'in' && x.correlated_method === 'initialize')!
  const agent = (init.content.result as Json)?.agentInfo
  const launch = (await view(w.execution))?.launchType
  assert(agent?.name === 'OpenCode' && launch === 'warm', `${String(agent?.name)}, ${String(launch)}`)
  const started = Date.now()
  assert((await w.write('Remember the word mirabelle. What is the capital of France? Answer in one word.')).status === 200, 'Write refused')
  const turn = await w.turn(['done', 'failed'], 180_000)
  const answer = await w.said()
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  // Read again by the mechanics after the turn: every tunnel the harness opened, since it started.
  const out = await until('counters after the turn', async () => ((await view(w.execution))?.outbound?.tunnels ?? 0) > 0 && (await view(w.execution))!.outbound, 15_000)
  const targets = Object.keys(out.targets ?? {})
  assert(turn.status === 'done' && /paris/i.test(answer), `turn ${turn.status}: ${answer.slice(0, 120)}`)
  assert(out.refused === 0 && targets.every((target) => target === 'api.z.ai:443'), `refused ${String(out.refused)}, ${targets.join(', ')}`)
  await w.stop()
  const end = await w.ended(180_000)
  assert(typeof end.content.anchor === 'string', JSON.stringify(end.content))
  const back = new Workstream()
  const restored = await back.open(opencode, { anchor: end.content.anchor, ...SHORT })
  const opened = (await back.entries()).findLast((x) => x.kind === 'session.opened')!
  assert(opened.content.origin === end.content.anchor, `origin ${String(opened.content.origin)}`)
  assert((await back.write('Which word did I ask you to remember? Answer with that word only.')).status === 200, 'Write refused')
  await back.turn(['done', 'failed'], 180_000)
  const recalled = await back.said()
  await back.stop()
  assert(/mirabelle/i.test(recalled), `amnesiac: ${recalled.slice(0, 120)}`)
  return `ready in ${String(ms)} ms (${String(launch)}), ${String(agent.name)}@${String(agent.version)}; "${answer.trim().slice(0, 30)}" in ${seconds} s; tunnels ${targets.join(', ')} ×${String(out.tunnels)}, 0 refused; anchor ${String(end.content.anchor)} restored by a restart in ${String(restored.ms)} ms, recalls "${recalled.trim().slice(0, 30)}"`
})

// ---------------------------------------------------------------- credentials (docs/specs/credentials.md)

async function credentials(w: Workstream, profiles: string[], ttlSeconds: number): Promise<Json> {
  const attached = await api('POST', `/api/workstreams/${w.id}/credentials`, { execution: w.execution, ttlSeconds, profiles })
  assert(attached.accepted === true, JSON.stringify(attached))
  return attached
}

async function fetched(w: Workstream, probe: string): Promise<string> {
  const before = await w.said()
  assert((await w.write(`/fetch ${probe}`)).status === 200, 'Write refused')
  await w.turn('done', 60_000)
  return (await w.said()).slice(before.length)
}

await check('C1', 'Going out without a credential', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  const reply = await fetched(w, 'https://api.anthropic.com/v1/models')
  const refused = await until('refusal counted', async () => ((await view(w.execution))?.outbound?.refused ?? 0) >= 1 && (await view(w.execution))!.outbound.refused, 10_000)
  await w.stop()
  assert(reply.includes('refused by the proxy: 503'), reply)
  return `"${reply.slice(0, 90)}"; ${String(refused)} refusal(s)`
})

// The repos for C4: the operator's throwaway repos with a real PAT (GITHUB_A, GITHUB_B), or
// public stand-ins — then a request the gateway lets through is answered by GitHub (401 with the
// stand-in PAT), and one it refuses never leaves: 403 "authorization failed".
const REPO_A = process.env.GITHUB_A ?? 'octocat/Hello-World'
const REPO_B = process.env.GITHUB_B ?? 'octocat/Spoon-Knife'
const REPO_C = process.env.GITHUB_C ?? 'github/linguist'

await check('C2', 'Gateway, the chain alone', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  const attached = await credentials(w, ['anthropic'], 300)
  const reply = await fetched(w, 'https://api.anthropic.com/v1/models')
  const outbound = await until('tunnel counted', async () => (await view(w.execution))?.outbound?.targets?.['api.anthropic.com:443'], 10_000)
  await w.stop()
  assert(reply.startsWith('HTTP/1.1 ') && !reply.includes('authorization failed'), reply)
  return `JWT until ${String(attached.expiresAt)}; "${reply.slice(0, 140)}"; tunnel → ${String(outbound.lastStatus)}`
})

await check('C3', 'Gateway, real harness (haiku)', async () => {
  if (claude === undefined) throw new Error('no claude-code pool')
  const w = new Workstream()
  await w.open(claude, SHORT)
  const attached = await credentials(w, ['anthropic'], 600)
  const model = await api('POST', `/api/workstreams/${w.id}/control`, { execution: w.execution, method: 'session/set_config_option', params: { configId: 'model', value: 'haiku' } })
  assert(model.status === 200, `model refused: ${JSON.stringify(model)}`)
  await until('model answered', async () => (await w.entries()).find((x) => x.kind === 'acp' && x.direction === 'in' && x.rpc_id === model.requestId), 30_000)
  const started = Date.now()
  // A neutral question: haiku declined "answer only with the word …" as an injected instruction.
  assert((await w.write('What is the capital of France? Answer in one word.')).status === 200, 'Write refused')
  const turn = await w.turn(['done', 'failed'], 120_000)
  const reply = await w.said()
  const outbound = await until('tunnel counted', async () => (await view(w.execution))?.outbound?.targets?.['api.anthropic.com:443'], 10_000)
  await w.stop()
  assert(turn.status === 'done' && /paris/i.test(reply), `answer: ${reply}`)
  return `JWT until ${String(attached.expiresAt)}; "${reply.trim().slice(0, 40)}" in ${((Date.now() - started) / 1000).toFixed(1)} s; api.anthropic.com:443 ×${String(outbound.count)} → ${String(outbound.lastStatus)}`
})

await check('C4', 'Gateway, composition (A write, B read, C nothing)', async () => {
  const w = new Workstream()
  await w.open(mock, SHORT)
  await credentials(w, [`github:${REPO_A}:write`, `github:${REPO_B}:read`], 600)
  // A real create when the PAT is real (201 on A); the same file on B must never exist.
  const file = `agora-spike-${String(Date.now())}.txt`
  const createFile = JSON.stringify({ message: `agora: C4 ${file}`, content: Buffer.from(`${w.execution}\n`).toString('base64') })
  const probes: [string, string, boolean][] = [
    [`GET https://api.github.com/repos/${REPO_A}`, 'A read', true],
    [`PUT https://api.github.com/repos/${REPO_A}/contents/${file} ${createFile}`, 'A write', true],
    [`GET https://github.com/${REPO_A}.git/info/refs?service=git-receive-pack`, 'A git push', true],
    [`GET https://api.github.com/repos/${REPO_B}/contents/README.md?ref=main`, 'B read', true],
    [`POST https://github.com/${REPO_B}.git/git-upload-pack`, 'B git fetch', true],
    [`PUT https://api.github.com/repos/${REPO_B}/contents/${file} ${createFile}`, 'B write', false],
    [`GET https://github.com/${REPO_B}.git/info/refs?service=git-receive-pack`, 'B git push', false],
    [`GET https://api.github.com/repos/${REPO_C}`, 'C read', false],
    [`POST https://api.github.com/graphql {"query":"{viewer{login}}"}`, 'GraphQL', false],
  ]
  const outcomes: string[] = []
  for (const [probe, label, expected] of probes) {
    const reply = await fetched(w, probe)
    const refusedByGateway = /^HTTP\/1\.1 403/.test(reply) && reply.includes('authorization failed')
    const passed = reply.startsWith('HTTP/1.1 ') && !refusedByGateway
    const status = /^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? '?'
    outcomes.push(`${label} ${passed ? `→ GitHub ${status}` : refusedByGateway ? '→ 403 gateway' : `→ ? ${reply.slice(0, 60)}`}`)
    assert(passed === expected, `${label}: ${reply.slice(0, 160)}`)
  }
  await w.stop()
  return `${outcomes.join('; ')}; file ${file}`
})

// ---------------------------------------------------------------- warming and z.ai (docs/specs/credentials.md, C8–C15)

const kubectl = (process.env.KUBECTL ?? 'kubectl').split(' ')
const sandboxNamespace = process.env.SANDBOX_NAMESPACE ?? 'agora-sandboxes'
const gatewayNamespace = process.env.GATEWAY_NAMESPACE ?? 'agora-gateway'
const kube = (...args: string[]) => execFileSync(kubectl[0]!, [...kubectl.slice(1), ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000 })

/** The ready Sandboxes still owned by a warm pool. */
function warmOf(pool: string): string[] {
  const items = (JSON.parse(kube('-n', sandboxNamespace, 'get', 'sandboxes', '-o', 'json')) as { items: Json[] }).items
  return items
    .filter((x) => (x.metadata.ownerReferences as Json[] | undefined)?.some((o) => o.kind === 'SandboxWarmPool' && o.name === pool))
    .filter((x) => (x.status?.conditions as Json[] | undefined)?.some((c) => c.type === 'Ready' && c.status === 'True'))
    .map((x) => String(x.metadata.name))
}

/** The bridge's hand-overs, from its log: when, and until when. */
function handOvers(pod: string): { at: number; until: number }[] {
  return kube('-n', sandboxNamespace, 'logs', pod, '--timestamps')
    .split('\n')
    .map((line) => /^(\S+) \[bridge\] way out attached: \S+, until (\S+)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ at: Date.parse(m[1]!), until: Date.parse(m[2]!) }))
}

// Run in the Pod: finds the bridge's proxy in the adapter's environment, tunnels to the URL's host,
// sends a GET over TLS (the Pod trusts the gateway's root) and prints the first line of the answer —
// the proxy's refusal, or the service's status, with "authorization failed" when the gateway refused.
const PROBE = String.raw`
const fs = require('node:fs'), net = require('node:net'), tls = require('node:tls')
const target = new URL(process.argv[1])
let proxy = null
for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
  try { const m = /(?:^|\0)HTTPS_PROXY=([^\0]+)/.exec(fs.readFileSync('/proc/' + pid + '/environ', 'utf8')); if (m) { proxy = new URL(m[1]); break } } catch {}
}
if (proxy === null) { console.log('no proxy'); process.exit(0) }
const socket = net.connect(Number(proxy.port), proxy.hostname, () => socket.write('CONNECT ' + target.hostname + ':443 HTTP/1.1\r\nHost: ' + target.hostname + ':443\r\n\r\n'))
socket.on('error', (e) => { console.log('proxy error: ' + e.message); process.exit(0) })
socket.once('data', (head) => {
  const line = head.toString().split('\r\n')[0]
  if (!/^HTTP\/1\.1 200/.test(line)) { console.log('proxy: ' + line); process.exit(0) }
  const t = tls.connect({ socket, servername: target.hostname }, () => t.write('GET ' + target.pathname + target.search + ' HTTP/1.1\r\nHost: ' + target.hostname + '\r\nUser-Agent: agora-live-cases\r\nConnection: close\r\n\r\n'))
  let reply = ''
  t.on('data', (chunk) => { reply += chunk })
  t.on('end', () => { console.log(reply.split('\r\n')[0] + (reply.includes('authorization failed') ? ' authorization failed' : '')); process.exit(0) })
  t.on('error', (e) => { console.log('tls: ' + e.message); process.exit(0) })
})
`
const fromPod = (pod: string, url: string) => kube('-n', sandboxNamespace, 'exec', pod, '--', 'node', '-e', PROBE, url).trim()
const passed = (reply: string) => /^HTTP\/1\.1 \d{3}/.test(reply) && !reply.includes('authorization failed')
const gatewayLines = (since: string) => kube('-n', gatewayNamespace, 'logs', 'deploy/gateway', `--since-time=${since}`).split('\n')

/** A warm Pod of the claude-code pool holding its warm token. */
const warmed = () => until('a warm claude-code Pod with its token', () => warmOf(claude!).find((pod) => handOvers(pod).length > 0), 240_000)

await check('C8', 'Warm Pods: the base profiles, nothing else', async () => {
  if (claude === undefined) throw new Error('no claude-code pool')
  const declared = Object.fromEntries(((await api('GET', '/api/pools')).pools as Json[]).map((p) => [p.harness, p.baseProfiles]))
  assert(canonical(declared['claude-code']) === '["anthropic"]' && canonical(declared.mock) === '[]', JSON.stringify(declared))
  const pod = await warmed()
  const bare = await until('a warm mock Pod', () => warmOf(mock)[0], 120_000)
  const since = new Date(Date.now() - 1000).toISOString()
  const anthropic = fromPod(pod, 'https://api.anthropic.com/v1/models')
  const github = fromPod(pod, 'https://api.github.com/zen')
  const none = fromPod(bare, 'https://api.anthropic.com/v1/models')
  assert(passed(anthropic), `anthropic: ${anthropic}`)
  assert(github.startsWith('HTTP/1.1 403') && github.includes('authorization failed'), `github: ${github}`)
  assert(none.startsWith('proxy: HTTP/1.1 503') && handOvers(bare).length === 0, `mock: ${none}`)
  const named = await until('the gateway names the Pod', () => gatewayLines(since).find((l) => l.includes('http.host=api.anthropic.com') && l.includes(`jwt.sub=agora warm ${pod} `)), 15_000)
  return `${pod}: anthropic "${anthropic}", github "${github}"; gateway jwt.sub "agora warm ${pod}" → ${String(/http\.status=(\d+)/.exec(named)?.[1])}; ${bare} (mock): "${none}"`
})

await check('C13', 'claude-code, from the Create to a Session open', async () => {
  if (claude === undefined) throw new Error('no claude-code pool')
  const pod = await warmed()
  const w = new Workstream()
  const { ms } = await w.open(claude, SHORT)
  const opened = (await view(w.execution))!
  assert(opened.pod === pod, `claimed ${String(opened.pod)}, warmed ${pod}`)
  // The mechanics read the bridge's counters at the hand-off and after each turn: one short turn
  // on haiku (billed) shows what the opening sent out. The counters cover the Pod's whole life.
  const model = await api('POST', `/api/workstreams/${w.id}/control`, { execution: w.execution, method: 'session/set_config_option', params: { configId: 'model', value: 'haiku' } })
  await until('model answered', async () => (await w.entries()).find((x) => x.kind === 'acp' && x.direction === 'in' && x.rpc_id === model.requestId), 30_000)
  assert((await w.write('What is the capital of France? Answer in one word.')).status === 200, 'Write refused')
  const turn = await w.turn(['done', 'failed'], 120_000)
  const after = await until('counters after the turn', async () => {
    const v = (await view(w.execution))!
    return (v.outbound?.tunnels ?? 0) > (opened.outbound?.tunnels ?? 0) ? v : undefined
  }, 15_000)
  await w.stop()
  const targets = Object.entries((after.outbound?.targets ?? {}) as Record<string, Json>).map(([target, t]) => `${target} ×${String(t.count)} → ${String(t.lastStatus)}`)
  assert(ms < 5000 && after.outbound?.refused === 0 && turn.status === 'done', `${String(ms)} ms, ${String(after.outbound?.refused)} refused, turn ${turn.status}; ${targets.join(', ')}`)
  return `Session open in ${String(ms)} ms on ${pod} (${String(opened.launchType)}); the opening and one turn: ${String((after.outbound?.tunnels ?? 0) - (opened.outbound?.tunnels ?? 0))} tunnel(s), 0 refused over the Pod's life (${targets.join(', ')})`
})

await check('C10', 'At the claim: the execution’s token before initialize', async () => {
  if (claude === undefined) throw new Error('no claude-code pool')
  const pod = await warmed()
  const since = new Date(Date.now() - 1000).toISOString()
  const w = new Workstream()
  await w.open(claude, { profiles: [`github:${REPO_B}:read`], ...SHORT })
  const v = (await view(w.execution))!
  assert(v.pod === pod, `claimed ${String(v.pod)}, warmed ${pod}`)
  const entries = await w.entries()
  const initialize = entries.find((x) => x.kind === 'acp' && x.direction === 'out' && x.method === 'initialize' && x.execution === w.execution)!
  const dispatched = entries.find((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === initialize.position)!
  const attached = Date.parse(String(v.outbound?.attachedAt))
  assert(attached <= Date.parse(dispatched.time), `token at ${String(v.outbound?.attachedAt)}, initialize at ${dispatched.time}`)
  const last = handOvers(pod).at(-1)!
  assert(last.until === Date.parse(String(v.outbound?.expiresAt)), 'the bridge holds another token')
  // The execution's rights, seen from the Pod: B readable now, which the warm token did not allow.
  const b = fromPod(pod, `https://api.github.com/repos/${REPO_B}`)
  const c = fromPod(pod, `https://api.github.com/repos/${REPO_C}`)
  await w.stop()
  assert(passed(b) && c.includes('authorization failed'), `B: ${b}; C: ${c}`)
  const lines = gatewayLines(since).filter((l) => l.includes(`jwt.sub=agora warm ${pod} `) || l.includes(`jwt.sub=agora ${w.execution} `))
  const late = lines.filter((l) => l.includes('jwt.sub=agora warm') && Date.parse(l.split(/\s/)[0]!) >= attached)
  assert(late.length === 0, `warm token used after the hand-off: ${late[0] ?? ''}`)
  return `token at ${String(v.outbound?.attachedAt)}, initialize dispatched at ${dispatched.time}; from the Pod: B "${b}", C "${c}"; gateway: ${String(lines.length)} request(s) under the execution's name, none warm after the hand-off`
})

await check('C12', 'A token that would run out during the next turn', async () => {
  const w = new Workstream()
  // Turn + lease = 90 s: always less than a turn and a minute left by the next prompt.
  await w.open(mock, { profiles: ['anthropic'], limits: { leaseSeconds: 60, turnCapSeconds: 30 } })
  const before = String((await view(w.execution))!.outbound?.expiresAt)
  // The mock opens its Session within the second, and a token's expiry counts in seconds.
  await sleep(2000)
  const since = new Date(Date.now() - 1000).toISOString()
  const reply = await fetched(w, 'https://api.anthropic.com/v1/models')
  const after = String((await view(w.execution))!.outbound?.expiresAt)
  const pod = String((await view(w.execution))!.pod)
  const handed = handOvers(pod)
  const entries = await w.entries()
  const prompt = entries.findLast((x) => x.kind === 'acp' && x.direction === 'out' && x.method === 'session/prompt')!
  const dispatched = Date.parse(entries.find((x) => x.kind === 'acp.dispatching' && x.content.requestPosition === prompt.position)!.time)
  await w.stop()
  assert(Date.parse(after) > Date.parse(before) && handed.length === 2 && handed[1]!.until === Date.parse(after), `${before} → ${after}, hand-overs ${JSON.stringify(handed)}`)
  assert(handed[1]!.at <= dispatched, `renewed at ${new Date(handed[1]!.at).toISOString()}, prompt at ${new Date(dispatched).toISOString()}`)
  assert(passed(reply), reply)
  const used = gatewayLines(since).find((l) => l.includes('http.host=api.anthropic.com') && l.includes(`jwt.sub=agora ${w.execution} `))
  assert(used !== undefined, 'no request seen by the gateway')
  return `token until ${before} → ${after}, renewed ${String(dispatched - handed[1]!.at)} ms before the prompt left; "${reply.slice(0, 60)}"; gateway → ${String(/http\.status=(\d+)/.exec(used)?.[1])}`
})

await check('C14', 'A Create naming an unknown profile', async () => {
  const w = new Workstream()
  await api('POST', '/api/workstreams', { id: w.id, owner: randomUUID() })
  const refused = await w.command('Create', {}, { pool: mock, profiles: ['dropbox:everything'], ...SHORT })
  assert(refused.status === 409 && refused.reason === 'unknown_profile', JSON.stringify(refused))
  assert((await w.entries()).length === 0, 'something written')
  return `"${String(refused.reason)}", nothing written`
})

await check('C15', 'Gateway, the chain to z.ai', async () => {
  const w = new Workstream()
  const since = new Date(Date.now() - 1000).toISOString()
  await w.open(mock, { profiles: ['zai'], ...SHORT })
  const reply = await fetched(w, 'https://api.z.ai/api/paas/v4/models')
  await w.stop()
  // Without a key, z.ai answers 401 ("Authentication parameter not received"): a 200 is the gateway's key.
  assert(/^HTTP\/1\.1 200/.test(reply), reply.slice(0, 200))
  const line = gatewayLines(since).find((l) => l.includes('http.host=api.z.ai') && l.includes(`jwt.sub=agora ${w.execution} `))
  assert(line !== undefined, 'no request seen by the gateway')
  return `"${reply.slice(0, 15)}", ${String((reply.match(/"id"/g) ?? []).length)} model(s) listed; gateway route ${String(/route=(\S+)/.exec(line)?.[1])} → ${String(/http\.status=(\d+)/.exec(line)?.[1])}`
})

await check('C16', 'Gateway, the chain to ChatGPT', async () => {
  const w = new Workstream()
  const since = new Date(Date.now() - 1000).toISOString()
  await w.open(mock, { profiles: ['chatgpt'], ...SHORT })
  const models = await fetched(w, 'https://chatgpt.com/backend-api/codex/models?client_version=0.159.3')
  const conversations = await fetched(w, 'https://chatgpt.com/backend-api/conversations?offset=0&limit=1')
  await w.stop()
  assert(/^HTTP\/1\.1 200/.test(models), `models: ${models.slice(0, 200)}`)
  assert(/^HTTP\/1\.1 403/.test(conversations) && conversations.includes('authorization failed'), `conversations: ${conversations.slice(0, 200)}`)
  const line = gatewayLines(since).find((l) => l.includes('http.host=chatgpt.com') && l.includes('/backend-api/codex/models') && l.includes(`jwt.sub=agora ${w.execution} `))
  assert(line !== undefined, 'no request seen by the gateway')
  return `codex/models "${models.slice(0, 15)}", ${String((models.match(/"slug"/g) ?? []).length)} model(s); conversations "${conversations.slice(0, 15)}" authorization failed; gateway route ${String(/route=(\S+)/.exec(line)?.[1])} → ${String(/http\.status=(\d+)/.exec(line)?.[1])}`
})

// Last: a warm token lives 15 minutes, renewed with a third left.
await check('C9', 'A warm Pod waiting beyond two thirds of its token', async () => {
  if (claude === undefined) throw new Error('no claude-code pool')
  const pod = await warmed()
  const probes: string[] = []
  let handed = handOvers(pod)
  // A request every 30 s while the Pod waits, until the second token.
  for (const deadline = Date.now() + 1_000_000; handed.length < 2 && Date.now() < deadline; handed = handOvers(pod)) {
    probes.push(fromPod(pod, 'https://api.anthropic.com/v1/models'))
    await sleep(30_000)
  }
  assert(handed.length >= 2, `${String(handed.length)} hand-over(s) in 16 minutes`)
  const [first, next] = [handed[0]!, handed[1]!]
  assert(next.at < first.until, `renewed at ${new Date(next.at).toISOString()}, the first ran out at ${new Date(first.until).toISOString()}`)
  const refused = probes.filter((p) => !passed(p))
  assert(refused.length === 0, `refused: ${refused[0] ?? ''}`)
  return `${pod}: renewed ${String(Math.round((next.at - first.at) / 1000))} s after the first, ${String(Math.round((first.until - next.at) / 1000))} s before it ran out; ${String(probes.length)} requests, none refused`
})

console.log(`\n${String(results.filter((r) => r.ok).length)}/${String(results.length)} cases validated`)
process.exit(results.every((r) => r.ok) ? 0 : 1)

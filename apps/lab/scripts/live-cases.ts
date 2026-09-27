// Plays every case of docs/executions.md ("Les cas à valider") against the DEPLOYED lab, with real
// Kata sandboxes destroyed by Agent Sandbox at their deadline.
// Usage: node apps/lab/scripts/live-cases.ts http://<lab>:8080 [cas…] (the receiver is on port 8081).
// From g4, the lab Pod IP is reachable directly (its policy admits the host); the page at
// agora-lab.bretagne.dev offers the same cases by hand, behind Pocket-ID.
import { WebSocket } from 'ws'

const base = process.argv[2] ?? 'http://127.0.0.1:8080'
const receiver = base.replace(/:8080$/, ':8081')
const only = new Set(process.argv.slice(3).map(Number))
type Json = Record<string, any>

async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  })
  return { status: response.status, ...((await response.json()) as Json) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, find: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await find()
    if (found !== undefined && found !== null && found !== false) return found
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`)
    await sleep(250)
  }
}

async function snapshot(): Promise<{ executions: Json[]; history: Json[]; logs: Json[] }> {
  return (await api('GET', '/api/executions')) as any
}
const execution = async (name: string) => (await snapshot()).executions.find((s) => s.name === name)
const ended = (name: string, timeoutMs: number) => until(`fin de ${name}`, async () => (await snapshot()).history.find((h) => h.name === name), timeoutMs)
const anchorText = async (id: string) => (await fetch(`${base}/api/anchors/${id}/content`)).text()

class Consumer {
  readonly messages: Json[] = []
  readonly socket: WebSocket
  closed: number | null = null
  constructor(name: string, after?: number) {
    this.socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/executions/${name}/acp${after === undefined ? '' : `?after=${String(after)}`}`)
    this.socket.on('message', (data) => this.messages.push(JSON.parse(data.toString()) as Json))
    this.socket.on('close', (code) => (this.closed = code))
    this.socket.on('error', () => {})
  }
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
  }
  acp(): Json[] {
    return this.messages.flatMap((m) => (typeof m.acp === 'string' ? [JSON.parse(m.acp)] : typeof m.local === 'string' ? [JSON.parse(m.local)] : []))
  }
  lastSeq(): number {
    return Math.max(0, ...this.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq as number))
  }
  send(message: Json): void {
    this.socket.send(JSON.stringify(message))
  }
  response(id: unknown, timeoutMs = 30_000): Promise<Json> {
    return until(`réponse ${JSON.stringify(id)}`, () => this.acp().find((m) => m.id === id && m.method === undefined), timeoutMs)
  }
  async session(): Promise<string> {
    const attached = await until('attached', () => this.messages.find((m) => m.event?.type === 'attached'), 10_000)
    const cwd = attached.event.execution.bridge.workspace ?? '/home/harness/work'
    this.send({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: { cwd, mcpServers: [] } })
    return (await this.response('new', 60_000)).result.sessionId as string
  }
  prompt(id: number | string, sessionId: string, text: string): void {
    this.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
  }
  close(): void {
    this.socket.close()
  }
}

async function consumer(name: string, after?: number): Promise<Consumer> {
  const client = new Consumer(name, after)
  await client.opened()
  return client
}

// Short leases in the lab: a stopped sandbox is destroyed at its deadline, at most a lease later.
const SHORT = { limits: { leaseSeconds: 60 } }

async function create(pool: string, extra: Json = {}): Promise<{ name: string; ms: number }> {
  const started = Date.now()
  const created = await api('POST', '/api/executions', { requestId: crypto.randomUUID(), pool, ...extra })
  if (created.accepted !== true) throw new Error(`création refusée : ${JSON.stringify(created)}`)
  const name = created.name as string
  await until(`${name} prêt`, async () => (await execution(name))?.state === 'prêt', 120_000)
  return { name, ms: Date.now() - started }
}

const results: { n: number; label: string; ok: boolean; detail: string }[] = []
async function check(n: number, label: string, body: () => Promise<string>): Promise<void> {
  if (only.size > 0 && !only.has(n)) return
  const started = Date.now()
  try {
    const detail = await body()
    results.push({ n, label, ok: true, detail: `${detail} (${String(Math.round((Date.now() - started) / 1000))} s)` })
    console.log(`✔ ${String(n).padStart(2)} ${label} — ${detail}`)
  } catch (error) {
    results.push({ n, label, ok: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`✖ ${String(n).padStart(2)} ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// ---------------------------------------------------------------- setup

const pools = (await api('GET', '/api/pools')).pools as Json[]
const mock = pools.find((p) => p.harness === 'mock')!.name as string
const claude = pools.find((p) => p.harness === 'claude-code')?.name as string | undefined
for (const s of (await snapshot()).executions) await api('POST', `/api/executions/${s.name as string}/stop`)
// Stopped sandboxes stay until their deadline (up to a lease later); only the quota matters here.
await until('place sous le quota', async () => (await snapshot()).executions.length <= 2, 660_000)
await until('stock chaud plein', async () => ((await api('GET', '/api/pools')).pools as Json[]).find((p) => p.name === mock)?.readyReplicas === 2, 120_000)
console.log(`pools : ${pools.map((p) => `${p.name as string} (${p.harness as string})`).join(', ')}`)

let a = ''

await check(1, 'Créer depuis un pool chaud', async () => {
  const created = await create(mock)
  a = created.name
  const launch = await until('launchType', async () => (await execution(a))?.launchType, 10_000)
  assert(launch === 'warm', `lancement ${String(launch)}`)
  return `${a} prêt en ${String(created.ms)} ms, lancement ${String(launch)}`
})

await check(2, 'Créer au-delà du stock chaud, et 3 : deux fois le même identifiant', async () => {
  // A has taken one of the two warm sandboxes; three claims at once outrun what the pool holds.
  const requestId = crypto.randomUUID()
  const started = Date.now()
  const answers = await Promise.all([
    api('POST', '/api/executions', { requestId, pool: mock, ...SHORT }),
    api('POST', '/api/executions', { requestId, pool: mock, ...SHORT }),
    api('POST', '/api/executions', { requestId: crypto.randomUUID(), pool: mock, ...SHORT }),
    api('POST', '/api/executions', { requestId: crypto.randomUUID(), pool: mock, ...SHORT }),
  ])
  assert(answers[0]!.name === answers[1]!.name, `deux noms pour un identifiant : ${String(answers[0]!.name)} / ${String(answers[1]!.name)}`)
  const names = [answers[0]!.name as string, answers[2]!.name as string, answers[3]!.name as string]
  const timings = await Promise.all(names.map(async (name) => {
    await until(`${name} prêt`, async () => (await execution(name))?.state === 'prêt', 120_000)
    const ms = Date.now() - started
    return `${name} ${String(await until('launchType', async () => (await execution(name))?.launchType, 10_000))} ${String(ms)} ms`
  }))
  const claims = (await snapshot()).executions.filter((s) => s.requestId === requestId).length
  assert(claims === 1, `${String(claims)} exécutions pour un identifiant`)
  assert(timings.some((t) => t.includes('cold')), `aucun lancement froid : ${timings.join(', ')}`)
  return `même identifiant → ${String(answers[0]!.name)} deux fois, un seul claim ; ${timings.join(' ; ')}`
})

await check(4, 'Pool hors catalogue, quota', async () => {
  const outside = await api('POST', '/api/executions', { requestId: crypto.randomUUID(), pool: 'pool-inexistant' })
  assert(outside.accepted === false && outside.status === 400, JSON.stringify(outside))
  let refusedAnswer: Json | null = null
  for (let i = 0; i < 8 && refusedAnswer === null; i++) {
    const answer = await api('POST', '/api/executions', { requestId: crypto.randomUUID(), pool: mock, ...SHORT })
    if (answer.status === 429) refusedAnswer = answer
  }
  assert(refusedAnswer !== null, 'jamais refusé')
  for (const s of (await snapshot()).executions) if (s.name !== a) await api('POST', `/api/executions/${s.name as string}/stop`)
  return `« ${String(outside.reason)} » ; « ${String(refusedAnswer.reason)} »`
})

let client!: Consumer
let sessionA = ''
await check(5, 'Relais : initialize, session/new, prompt', async () => {
  client = await consumer(a)
  client.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } })
  const init = await client.response(0)
  sessionA = await client.session()
  await until('session sur le claim', async () => (await execution(a))?.sessionId === sessionA, 10_000)
  client.prompt(1, sessionA, 'mirabelle')
  const done = await client.response(1)
  assert(done.result?.stopReason === 'end_turn', JSON.stringify(done))
  const seqs = client.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq as number)
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), 'positions non croissantes')
  return `initialize local (${String(init.result.agentInfo.name)}), session ${sessionA.slice(0, 8)}…, fin end_turn, positions ${String(seqs[0])}→${String(seqs.at(-1))}`
})

await check(6, 'Second prompt pendant un tour', async () => {
  client.prompt(2, sessionA, '/sleep 8')
  await until('en tour', async () => (await execution(a))?.state === 'en tour', 10_000)
  client.prompt(3, sessionA, 'trop tôt')
  const refused = await client.response(3)
  assert(String(refused.error?.message).includes('un tour est déjà en cours'), JSON.stringify(refused))
  return `« ${String(refused.error.message)} »`
})

await check(7, 'Annuler un tour', async () => {
  client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionA } })
  const done = await client.response(2)
  assert(done.result?.stopReason === 'cancelled', JSON.stringify(done))
  await until('prêt', async () => (await execution(a))?.state === 'prêt', 10_000)
  return 'stopReason cancelled, exécution prête'
})

await check(8, 'Permission, consommateur parti puis revenu', async () => {
  client.prompt(4, sessionA, '/permission')
  const asked = await until('permission', () => client.acp().find((m) => m.method === 'session/request_permission'), 10_000)
  const seen = client.lastSeq()
  client.close()
  await sleep(2000)
  client = await consumer(a, seen - 1)
  const replayed = await until('permission rejouée', () => client.acp().find((m) => m.method === 'session/request_permission'), 10_000)
  assert(replayed.id === asked.id, 'autre demande')
  client.send({ jsonrpc: '2.0', id: replayed.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  const done = await client.response(4)
  assert(done.result?.stopReason === 'end_turn', JSON.stringify(done))
  return `demande ${String(asked.id)} rejouée après reconnexion, réponse acceptée, tour clos`
})

await check(9, 'Consommateur déconnecté pendant un tour', async () => {
  client.prompt(5, sessionA, '/sleep 5')
  await until('en tour', async () => (await execution(a))?.state === 'en tour', 10_000)
  const seen = client.lastSeq()
  client.close()
  await sleep(7000)
  client = await consumer(a, seen)
  const done = await client.response(5)
  const replay = client.messages.find((m) => m.event?.type === 'replay')
  assert(done.result?.stopReason === 'end_turn' && replay?.event.gap === false, JSON.stringify(replay))
  return `${String(replay.event.count)} trames rejouées depuis ${String(replay.event.from)}, sans trou, fin du tour reçue`
})

await check(10, 'Connexion au bridge coupée pendant un tour', async () => {
  client.prompt(6, sessionA, '/sleep 6')
  await until('en tour', async () => (await execution(a))?.state === 'en tour', 10_000)
  await sleep(1000)
  const cut = await api('POST', `/api/lab/executions/${a}/drop-bridge`)
  assert(cut.accepted === true, JSON.stringify(cut))
  const done = await client.response(6)
  const log = (await snapshot()).logs.find((l) => l.execution === a && String(l.message).startsWith('bridge rejoint'))
  assert(done.result?.stopReason === 'end_turn' && log !== undefined && !String(log.message).includes('TROU'), JSON.stringify(log))
  return `« ${String(log.message)} », tour clos`
})

await check(11, 'Back-end redémarré pendant un tour', async () => {
  client.prompt(7, sessionA, '/sleep 20')
  await until('en tour', async () => (await execution(a))?.state === 'en tour', 10_000)
  const seen = client.lastSeq()
  await api('POST', '/api/lab/restart')
  await until('banc tombé', async () => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true), 30_000).catch(() => true)
  await until('banc revenu', async () => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false), 120_000)
  const logs = (await snapshot()).logs
  const found = await until('tour retrouvé', async () => {
    const s = await execution(a)
    return s?.state === 'en tour' || s?.lastTurn !== null ? s : undefined
  }, 30_000)
  const closed = await until('tour clos', async () => {
    const s = await execution(a)
    return s?.state === 'prêt' && String(s.lastTurn?.outcome).includes('end_turn') ? s : undefined
  }, 60_000)
  client = await consumer(a, seen)
  const done = await client.response(7)
  assert(done.result?.stopReason === 'end_turn', JSON.stringify(done))
  return `au redémarrage : « ${String(logs.at(-1)?.message)} », état ${String(found.state)}, puis ${String(closed.lastTurn.outcome)} ; le consommateur récupère la fin`
})

// The sandboxes stopped in case 4 count against the quota until Agent Sandbox destroys them.
await until('sandboxes du cas 4 détruits', async () => (await snapshot()).executions.length <= 2, 180_000)

// The deadline cases wait on real destructions by Agent Sandbox: they run side by side.
let anchorToRestore = ''
const parallel: Promise<void>[] = []
parallel.push((async () => {
  let name = ''
  let patchesAtEnd = 0
  let grantedAt = ''
  await check(12, 'Échéance pendant un tour', async () => {
    name = (await create(mock, SHORT)).name
    const c = await consumer(name)
    const s = await c.session()
    c.prompt(1, s, '/sleep 45')
    await until('en tour', async () => (await execution(name))?.state === 'en tour', 10_000)
    const admitted = (await execution(name))!
    const later = await until('ré-armé', async () => {
      const x = await execution(name)
      return x !== undefined && x.shutdownTime !== admitted.shutdownTime ? x : undefined
    }, 40_000)
    const cap = Date.parse(admitted.turn.startedAt) + admitted.limits.turnCapSeconds * 1000
    assert(Date.parse(later.shutdownTime) <= cap, 'au-delà de la limite du tour')
    await c.response(1, 60_000)
    const done = await until('fin du tour vue', async () => {
      const x = await execution(name)
      return x?.turn === null && x.renewing === false ? x : undefined
    }, 10_000)
    patchesAtEnd = done.renewals
    grantedAt = done.shutdownTime
    return `échéance ${String(admitted.shutdownTime)} → ${String(later.shutdownTime)} pendant le tour`
  })
  await check(13, 'Fin de tour', async () => {
    await sleep(25_000)
    const x = await execution(name)
    assert(x !== undefined && x.shutdownTime === grantedAt && x.renewals === patchesAtEnd, `ré-armé hors tour : ${JSON.stringify(x)}`)
    return `échéance ${grantedAt} fixée à la fin du tour, inchangée 25 s plus tard`
  })
  await check(14, 'Échéance atteinte entre deux tours', async () => {
    const end = await ended(name, 90_000)
    assert(end.reason === 'échéance après le dernier tour' && end.anchor !== null, JSON.stringify(end))
    return `détruit par Agent Sandbox ; anchor ${String(end.anchor.id)} poussé par le Pod (${String(end.anchor.files.length)} fichier(s), ${String(end.anchor.byteLength)} o)`
  })
})())
parallel.push(check(15, 'Tour trop long', async () => {
  const { name } = await create(mock, { limits: { turnCapSeconds: 30 } })
  const c = await consumer(name)
  const s = await c.session()
  c.prompt(1, s, '/sleep 120')
  const end = await ended(name, 120_000)
  assert(String(end.reason).startsWith('tour en cours') && end.anchor !== null, JSON.stringify(end))
  return `détruit à début + 30 s ; anchor ${String(end.anchor.id)} (${String(end.anchor.byteLength)} o)`
}))
parallel.push(check(16, 'Arrêter', async () => {
  const { name } = await create(mock, SHORT)
  const c = await consumer(name)
  const s = await c.session()
  c.prompt(1, s, 'mirabelle')
  await c.response(1)
  const stopped = await api('POST', `/api/executions/${name}/stop`)
  assert(stopped.accepted === true, JSON.stringify(stopped))
  const state = (await execution(name))?.state
  const end = await ended(name, 120_000)
  assert(end.reason === 'arrêt demandé' && end.anchor !== null, JSON.stringify(end))
  assert((await anchorText(end.anchor.id as string)).includes('mirabelle'), 'anchor sans mirabelle')
  anchorToRestore = end.anchor.id as string
  return `état ${String(state)}, détruit à l'échéance ${String(stopped.shutdownTime)} ; anchor ${anchorToRestore}`
}))
parallel.push(check(17, 'Arrêter pendant un tour', async () => {
  const { name } = await create(mock, SHORT)
  const c = await consumer(name)
  const s = await c.session()
  c.prompt(1, s, 'avant')
  await c.response(1)
  c.prompt(2, s, '/sleep 120')
  await until('en tour', async () => (await execution(name))?.state === 'en tour', 10_000)
  await api('POST', `/api/executions/${name}/stop`)
  const cancelled = await c.response(2)
  const end = await ended(name, 120_000)
  assert(cancelled.result?.stopReason === 'cancelled' && end.anchor !== null, JSON.stringify({ cancelled, end }))
  return `tour annulé (cancelled), détruit à l'échéance, anchor ${String(end.anchor.id)}`
}))
await Promise.all(parallel)
await api('POST', `/api/executions/${a}/stop`)

await check(18, 'Restaurer un anchor', async () => {
  const { name, ms } = await create(mock, { anchorId: anchorToRestore, ...SHORT })
  const restored = await until('restauré', async () => {
    const s = await execution(name)
    return s?.restored === true ? s : undefined
  }, 60_000)
  const c = await consumer(name)
  c.prompt(1, restored.sessionId, '/recall')
  await c.response(1)
  assert(JSON.stringify(c.acp()).includes('mirabelle'), 'amnésique')
  await api('POST', `/api/executions/${name}/stop`)
  return `${name} prêt en ${String(ms)} ms, session ${String(restored.sessionId).slice(0, 8)}… reprise, l'agent se souvient de « mirabelle »`
})

await check(19, 'Adaptateur mort', async () => {
  const { name } = await create(mock, SHORT)
  const c = await consumer(name)
  const s = await c.session()
  c.prompt(1, s, 'avant la chute')
  await c.response(1)
  c.prompt(2, s, '/crash')
  await until('perdu', async () => (await execution(name))?.state === 'perdu', 20_000)
  const end = await ended(name, 120_000)
  assert(String(end.reason).startsWith('perdu') && end.anchor !== null, JSON.stringify(end))
  assert((await anchorText(end.anchor.id as string)).includes('avant la chute'), 'anchor vide')
  return `perdu, plus de renouvellement ; détruit à l'échéance, anchor ${String(end.anchor.id)} poussé malgré l'adaptateur mort`
})

await check(20, 'Jetons refusés', async () => {
  const { name } = await create(mock, SHORT)
  const probe = await api('POST', `/api/lab/executions/${name}/probe-auth`)
  const rows = probe.results as Json[]
  const bad = rows.slice(0, -1).filter((r) => r.info !== 401 || r.acp !== 401)
  assert(bad.length === 0 && rows.at(-1)!.info === 200 && rows.at(-1)!.acp === 101, JSON.stringify(rows))
  await api('POST', `/api/executions/${name}/stop`)
  return rows.map((r) => `${String(r.case)} ${String(r.info)}/${String(r.acp)}`).join(' ; ')
})

await check(21, 'Poussée d’anchor sans jeton projeté valide', async () => {
  const body = JSON.stringify({ format: 'agora-anchor/1', harness: 'mock', files: [], stable: true })
  const statuses: number[] = []
  for (const headers of [{}, { authorization: 'Bearer pas-un-jeton' }] as Record<string, string>[]) {
    statuses.push((await fetch(`${receiver}/anchors`, { method: 'POST', body, headers })).status)
  }
  assert(statuses.every((status) => status === 401), JSON.stringify(statuses))
  return `sans jeton ${String(statuses[0])}, jeton faux ${String(statuses[1])}`
})

await check(22, 'Harness réel (claude-code)', async () => {
  if (claude === undefined) throw new Error('pas de pool claude-code')
  const { name, ms } = await create(claude, SHORT)
  const c = await consumer(name)
  c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } })
  const init = await c.response(0)
  const s = await c.session()
  c.prompt(1, s, 'Réponds juste : ok')
  const answer = await c.response(1, 120_000).catch(() => null)
  if (answer === null) c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: s } })
  await api('POST', `/api/executions/${name}/stop`)
  const end = await ended(name, 150_000)
  let restoredNote = 'pas d’anchor à restaurer'
  if (end.anchor !== null) {
    const back = await create(claude, { anchorId: end.anchor.id, ...SHORT })
    const r = await until('restauré', async () => {
      const x = await execution(back.name)
      return x?.restored === true || x?.state === 'erreur' ? x : undefined
    }, 60_000)
    restoredNote = r.restored === true ? `restauré dans ${back.name} par session/resume (session ${String(r.sessionId).slice(0, 8)}…)` : `restauration : ${String(r.reason)}`
    await api('POST', `/api/executions/${back.name}/stop`)
  }
  const outcome = answer === null ? 'pas de réponse en 120 s, annulé' : answer.error !== undefined ? `erreur « ${String(answer.error.message).slice(0, 100)} »` : `fin ${String(answer.result?.stopReason)}`
  return `prêt en ${String(ms)} ms, ${String(init.result.agentInfo?.name)}@${String(init.result.agentInfo?.version)}, prompt : ${outcome} ; anchor ${end.anchor === null ? `absent (${String(end.anchorError)})` : `${String(end.anchor.byteLength)} o poussé`} ; ${restoredNote}`
})

client?.close()
console.log(`\n${String(results.filter((r) => r.ok).length)}/${String(results.length)} cas validés`)
process.exit(results.every((r) => r.ok) ? 0 : 1)

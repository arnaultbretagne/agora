// The executions contract (docs/executions.md), against real bridges running the mock agent and an
// in-memory Kubernetes API whose controller destroys claims at their deadline.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { AnchorStore } from '../src/anchors.ts'
import { createAnchorReceiver, createApi } from '../src/http.ts'
import { ANNOTATION, ExecutionManager, type Limits } from '../src/manager.ts'
import { FakeKube, NAMESPACE } from './fake-kube.ts'
import { Collector, keys } from '@agora/testkit'

const { privateKey, publicKey } = keys()
const cleanups: (() => Promise<void>)[] = []
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

interface Lab {
  readonly kube: FakeKube
  readonly manager: ExecutionManager
  readonly anchors: AnchorStore
  readonly base: string
  readonly receiver: string
}

async function listen(server: ReturnType<typeof createApi>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function lab(options: { kube?: FakeKube; anchors?: AnchorStore; defaults?: Partial<Limits>; maxActive?: number; renewSeconds?: number } = {}): Promise<Lab> {
  const kube = options.kube ?? new FakeKube(publicKey)
  if (options.kube === undefined) cleanups.push(() => kube.closeAll())
  const anchors = options.anchors ?? new AnchorStore(mkdtempSync(join(tmpdir(), 'anchors-')))
  const manager = new ExecutionManager({
    kube,
    anchors,
    signingKey: privateKey,
    defaults: { leaseSeconds: 30, turnCapSeconds: 3600, ...options.defaults },
    renewSeconds: options.renewSeconds ?? 60,
    maxActive: options.maxActive ?? 4,
    bridgePort: 8080,
    bridgeAddress: kube.address,
    tickMs: 200,
    log: () => {},
  })
  await manager.start()
  cleanups.push(() => manager.stop())
  const base = await listen(createApi({ manager, anchors, lab: true, onRestart: () => {} }))
  const receiver = await listen(createAnchorReceiver({ manager, namespace: NAMESPACE, verify: (token) => kube.reviewToken(token) }))
  kube.anchorUrl = `http://${receiver}/anchors`
  return { kube, manager, anchors, base, receiver }
}

async function post(target: Lab, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://${target.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, ...((await response.json()) as Record<string, unknown>) }
}

async function until<T>(find: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found !== undefined && found !== null && found !== false) return found
    if (Date.now() > deadline) throw new Error('délai dépassé')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function view(target: Lab, name: string) {
  return target.manager.snapshot().executions.find((execution) => execution.name === name)
}

function ending(target: Lab, name: string, timeoutMs = 15_000) {
  return until(() => target.manager.snapshot().history.find((entry) => entry.name === name), timeoutMs)
}

async function ready(target: Lab, pool = 'mock-test', extra: Record<string, unknown> = {}): Promise<string> {
  const created = await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool, ...extra })
  assert.equal(created.accepted, true, JSON.stringify(created))
  const name = created.name as string
  await until(() => view(target, name)?.state === 'prêt')
  return name
}

async function consumer(target: Lab, name: string, after?: number): Promise<Collector> {
  const client = new Collector(`ws://${target.base}/api/executions/${name}/acp${after === undefined ? '' : `?after=${String(after)}`}`)
  await client.opened()
  return client
}

/** The consumer opens its session in the workspace the bridge announced, as the lab page does. */
async function session(client: Collector): Promise<string> {
  const attached = await client.until(() => client.messages.find((m) => (m.event as { type?: string } | undefined)?.type === 'attached'))
  const cwd = (attached.event as { execution: { bridge: { workspace: string } } }).execution.bridge.workspace
  client.send({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: { cwd, mcpServers: [] } })
  return ((await client.response('new')).result as { sessionId: string }).sessionId
}

function prompt(client: Collector, id: number, sessionId: string, text: string): void {
  client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
}

function deadlinesOf(target: Lab, name: string): { shutdownTime: string; at: number }[] {
  return target.kube.deadlines.filter((entry) => entry.name === name)
}

describe('executions', () => {
  it('creates idempotently, refuses what the catalogue, the bounds and the quota do not allow', async () => {
    const target = await lab({ maxActive: 2 })
    const requestId = crypto.randomUUID()
    const [first, second] = await Promise.all([
      post(target, '/api/executions', { requestId, pool: 'mock-test' }),
      post(target, '/api/executions', { requestId, pool: 'mock-test' }),
    ])
    assert.equal(first!.name, second!.name)
    assert.equal(target.kube.claims.size, 1)
    assert.match((await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'pool-inexistant' })).reason as string, /hors catalogue/)
    assert.match((await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test', limits: { turnCapSeconds: 5 } })).reason as string, /hors bornes/)
    await ready(target)
    assert.equal((await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test' })).status, 429)
  })

  it('answers initialize locally, records the session, and follows a turn on the claim', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    client.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } })
    assert.equal(((await client.response(0)).result as { agentInfo: { name: string } }).agentInfo.name, 'agora-mock-agent')
    const sessionId = await session(client)
    await until(() => target.kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.sessionId] === sessionId)

    prompt(client, 2, sessionId, '/sleep 1')
    await until(() => target.kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn])
    prompt(client, 3, sessionId, 'trop tôt')
    assert.match(String(((await client.response(3)).error as { message: string }).message), /un tour est déjà en cours/)
    assert.deepEqual((await client.response(2)).result, { stopReason: 'end_turn' })
    await until(() => target.kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn] === undefined)
    assert.equal(view(target, name)?.state, 'prêt')
  })

  it('refuses the prompt when its deadline cannot be accepted', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    target.kube.failPatches = true
    prompt(client, 2, sessionId, 'bonjour')
    const answer = await client.response(2)
    target.kube.failPatches = false
    assert.match(String((answer.error as { message: string }).message), /échéance non acceptée/)
    assert.equal(view(target, name)?.turn, null)
  })

  it('re-arms only during a turn, then grants one lease after its end and nothing more', async () => {
    const target = await lab({ renewSeconds: 1 })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    const before = deadlinesOf(target, name).length
    prompt(client, 2, sessionId, '/sleep 3')
    await client.response(2)
    const during = deadlinesOf(target, name).slice(before)
    // Admission, at least one renewal, and the grant at the end of the turn.
    assert.ok(during.length >= 3, JSON.stringify(during))
    const granted = during.at(-1)!
    assert.ok(Math.abs(Date.parse(granted.shutdownTime) - (granted.at + 30_000)) < 1500)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    assert.equal(deadlinesOf(target, name).length, before + during.length, 'renouvelé hors tour')
  })

  it('caps a turn at its maximum: the infrastructure destroys it, the Pod pushes its anchor', async () => {
    const target = await lab({ defaults: { turnCapSeconds: 2 }, renewSeconds: 1 })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/sleep 60')
    const end = await ending(target, name)
    assert.match(end.reason, /tour en cours à l’échéance/)
    assert.notEqual(end.anchor, null, String(end.anchorError))
    const bundle = new TextDecoder().decode((await target.anchors.bundle(end.anchor!.id))!)
    assert.match(bundle, /agora-anchor\/1/)
  })

  it('lets the lease run out after a turn: destroyed by the infrastructure, anchor received', async () => {
    const target = await lab({ defaults: { leaseSeconds: 4 } })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'mirabelle')
    await client.response(2)
    const end = await ending(target, name)
    assert.equal(end.reason, 'échéance après le dernier tour')
    assert.equal(end.anchor?.sessionId, sessionId)
    assert.deepEqual(end.anchor?.files.map((file) => file.path), [`${sessionId}.jsonl`])
  })

  it('stops by no longer renewing, cancels a turn in flight, and never deletes', async () => {
    const target = await lab({ defaults: { leaseSeconds: 4 } })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'avant')
    await client.response(2)
    prompt(client, 3, sessionId, '/sleep 60')
    await until(() => view(target, name)?.state === 'en tour')
    const patches = deadlinesOf(target, name).length
    const stopped = await post(target, `/api/executions/${name}/stop`)
    assert.equal(stopped.accepted, true)
    assert.deepEqual((await client.response(3)).result, { stopReason: 'cancelled' })
    assert.equal(view(target, name)?.state, 'arrêté')
    assert.match((await post(target, `/api/executions/${name}/stop`)).reason as string, /déjà demandé/)
    const end = await ending(target, name)
    assert.equal(deadlinesOf(target, name).length, patches, 'renouvelé après l’arrêt')
    assert.equal(end.reason, 'arrêt demandé')
    assert.match(new TextDecoder().decode((await target.anchors.bundle(end.anchor!.id))!), /YXZhbnQ|avant/)
  })

  it('restores an anchor into a new execution that remembers', async () => {
    const target = await lab({ defaults: { leaseSeconds: 4 } })
    const source = await ready(target)
    const client = await consumer(target, source)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'quetsche')
    await client.response(2)
    await post(target, `/api/executions/${source}/stop`)
    const anchorId = (await ending(target, source)).anchor!.id
    assert.match((await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'claude-test', anchorId })).reason as string, /harness/)

    const restored = await ready(target, 'mock-test', { anchorId, limits: { leaseSeconds: 60 } })
    await until(() => view(target, restored)?.restored)
    assert.equal(view(target, restored)?.sessionId, sessionId)
    const back = await consumer(target, restored)
    prompt(back, 5, sessionId, '/recall')
    await back.response(5)
    assert.ok(back.acp().some((message) => JSON.stringify(message).includes('quetsche')))
  })

  it('replays what a consumer missed, including a permission request, after its last position', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/permission')
    const permission = await client.until(() => client.acp().find((message) => message.method === 'session/request_permission'))
    const seen = Math.max(...client.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq as number))
    client.close()
    const back = await consumer(target, name, seen - 1)
    const replayed = await back.until(() => back.acp().find((message) => message.method === 'session/request_permission'))
    assert.equal(replayed.id, permission.id)
    back.send({ jsonrpc: '2.0', id: replayed.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    assert.deepEqual((await back.response(2)).result, { stopReason: 'end_turn' })
  })

  it('reconnects to the bridge after a cut, and closes the turn from the replay', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/sleep 3')
    await until(() => view(target, name)?.state === 'en tour')
    assert.equal((await post(target, `/api/lab/executions/${name}/drop-bridge`)).accepted, true)
    assert.deepEqual((await client.response(2)).result, { stopReason: 'end_turn' })
    await until(() => view(target, name)?.state === 'prêt')
  })

  it('finds a turn in flight after its own restart, from the claim alone', async () => {
    const kube = new FakeKube(publicKey)
    cleanups.push(() => kube.closeAll())
    const anchors = new AnchorStore(mkdtempSync(join(tmpdir(), 'anchors-')))
    const first = await lab({ kube, anchors })
    const name = await ready(first)
    const client = await consumer(first, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/sleep 2')
    await until(() => kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn])
    await first.manager.stop()
    const second = await lab({ kube, anchors })
    await until(() => view(second, name)?.state === 'en tour')
    await until(() => view(second, name)?.state === 'prêt', 8000)
    assert.match(String(view(second, name)?.lastTurn?.outcome), /end_turn/)
  })

  it('stops renewing an execution whose adapter died; its anchor still leaves with the Pod', async () => {
    const target = await lab({ defaults: { leaseSeconds: 4 } })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'avant la chute')
    await client.response(2)
    prompt(client, 3, sessionId, '/crash')
    await until(() => view(target, name)?.state === 'perdu')
    const end = await ending(target, name)
    assert.match(end.reason, /perdu/)
    assert.notEqual(end.anchor, null, String(end.anchorError))
  })

  it('declares an execution lost when its Pod was replaced', async () => {
    const target = await lab()
    const name = await ready(target)
    await target.kube.replacePod(view(target, name)!.pod!)
    await until(() => view(target, name)?.state === 'perdu')
    assert.match(String(view(target, name)?.reason), /processus remplacé/)
  })

  it('refuses an anchor pushed without a valid projected token', async () => {
    const target = await lab()
    const body = JSON.stringify({ format: 'agora-anchor/1', harness: 'mock', files: [], stable: true })
    for (const headers of [{}, { authorization: 'Bearer faux' }] as Record<string, string>[]) {
      const response = await fetch(`http://${target.receiver}/anchors`, { method: 'POST', body, headers })
      assert.equal(response.status, 401)
    }
    assert.equal((await fetch(`http://${target.receiver}/anchors`, { method: 'POST', body, headers: { authorization: 'Bearer pod:inconnu' } })).status, 404)
    assert.deepEqual(await target.anchors.list(), [])
  })

  it('forgets a claim that disappears without any push', async () => {
    const target = await lab({ defaults: { leaseSeconds: 1 } })
    const created = await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'pool-inexistant-ailleurs' })
    assert.equal(created.accepted, false)
    const claim = await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test' })
    const end = await ending(target, claim.name as string)
    assert.equal(end.anchor, null)
    assert.match(String(end.anchorError), /aucun fichier natif|aucun anchor/)
  })

  it('probes the bridge with bad tokens', async () => {
    const target = await lab()
    const name = await ready(target)
    const probe = await post(target, `/api/lab/executions/${name}/probe-auth`)
    const results = probe.results as { case: string; info: number; acp: number }[]
    for (const result of results.slice(0, -1)) assert.deepEqual([result.info, result.acp], [401, 401], result.case)
    assert.deepEqual([results.at(-1)!.info, results.at(-1)!.acp], [200, 101])
    await until(() => view(target, name)?.state === 'prêt')
  })
})

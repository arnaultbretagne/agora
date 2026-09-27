// The back-end contract (sandbox-backend.md), against real bridges running the mock agent and an
// in-memory Kubernetes API.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { AnchorStore } from '../src/backend/anchors.ts'
import { createApi } from '../src/backend/http.ts'
import { ANNOTATION, SandboxManager, type Limits, type ManagerEvent } from '../src/backend/manager.ts'
import { FakeKube } from './fake-kube.ts'
import { Collector, keys } from './helpers.ts'

const { privateKey, publicKey } = keys()
const cleanups: (() => Promise<void>)[] = []
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

interface Lab {
  readonly kube: FakeKube
  readonly manager: SandboxManager
  readonly anchors: AnchorStore
  readonly base: string
  readonly events: ManagerEvent[]
}

async function lab(options: { kube?: FakeKube; anchors?: AnchorStore; defaults?: Partial<Limits>; maxActive?: number } = {}): Promise<Lab> {
  const kube = options.kube ?? new FakeKube(publicKey)
  const anchors = options.anchors ?? new AnchorStore(mkdtempSync(join(tmpdir(), 'anchors-')))
  const manager = new SandboxManager({
    kube,
    anchors,
    signingKey: privateKey,
    defaults: { leaseSeconds: 600, idleSeconds: 3600, turnCapSeconds: 3600, ...options.defaults },
    renewSeconds: 60,
    maxActive: options.maxActive ?? 4,
    startupTimeoutSeconds: 300,
    stopTurnWaitMs: 5000,
    bridgePort: 8080,
    bridgeAddress: kube.address,
    tickMs: 200,
    log: () => {},
  })
  const events: ManagerEvent[] = []
  manager.subscribe((event) => events.push(event))
  await manager.start()
  const server = createApi({ manager, anchors, lab: true, onRestart: () => {} })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `127.0.0.1:${String((server.address() as AddressInfo).port)}`
  cleanups.push(async () => {
    await manager.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  if (options.kube === undefined) cleanups.push(() => kube.closeAll())
  return { kube, manager, anchors, base, events }
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
  return target.manager.snapshot().sandboxes.find((sandbox) => sandbox.name === name)
}

async function ready(target: Lab, pool = 'mock-test', extra: Record<string, unknown> = {}): Promise<string> {
  const created = await post(target, '/api/sandboxes', { requestId: crypto.randomUUID(), pool, ...extra })
  assert.equal(created.accepted, true, JSON.stringify(created))
  const name = created.name as string
  await until(() => view(target, name)?.state === 'prêt')
  return name
}

async function consumer(target: Lab, name: string, after?: number): Promise<Collector> {
  const client = new Collector(`ws://${target.base}/api/sandboxes/${name}/acp${after === undefined ? '' : `?after=${String(after)}`}`)
  await client.opened()
  return client
}

/** The consumer opens its session in the workspace the bridge announced, as the lab page does. */
async function session(client: Collector): Promise<string> {
  const attached = await client.until(() => client.messages.find((m) => (m.event as { type?: string } | undefined)?.type === 'attached'))
  const cwd = (attached.event as { sandbox: { bridge: { workspace: string } } }).sandbox.bridge.workspace
  client.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd, mcpServers: [] } })
  return ((await client.response(1)).result as { sessionId: string }).sessionId
}

function prompt(client: Collector, id: number, sessionId: string, text: string): void {
  client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })
}

describe('back-end', () => {
  it('creates idempotently, refuses what the catalogue and the quota do not allow', async () => {
    const target = await lab({ maxActive: 2 })
    const requestId = crypto.randomUUID()
    const [first, second] = await Promise.all([
      post(target, '/api/sandboxes', { requestId, pool: 'mock-test' }),
      post(target, '/api/sandboxes', { requestId, pool: 'mock-test' }),
    ])
    assert.equal(first!.name, second!.name)
    assert.equal(target.kube.claims.size, 1)

    const outside = await post(target, '/api/sandboxes', { requestId: crypto.randomUUID(), pool: 'pool-inexistant' })
    assert.equal(outside.accepted, false)
    assert.match(outside.reason as string, /hors catalogue/)

    const bounds = await post(target, '/api/sandboxes', { requestId: crypto.randomUUID(), pool: 'mock-test', limits: { idleSeconds: 5 } })
    assert.match(bounds.reason as string, /hors bornes/)

    await ready(target)
    const over = await post(target, '/api/sandboxes', { requestId: crypto.randomUUID(), pool: 'mock-test' })
    assert.equal(over.status, 429)
  })

  it('answers initialize locally, records the session and follows a turn on the claim', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    client.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } })
    const init = await client.response(0)
    assert.equal((init.result as { agentInfo: { name: string } }).agentInfo.name, 'agora-mock-agent')

    const sessionId = await session(client)
    await until(() => target.kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.sessionId] === sessionId)

    prompt(client, 2, sessionId, '/sleep 1')
    await until(() => target.kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn])
    assert.equal(view(target, name)?.state, 'en tour')

    prompt(client, 3, sessionId, 'trop tôt')
    const refused = await client.response(3)
    assert.match(String((refused.error as { message: string }).message), /un tour est déjà en cours/)

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

  it('cancels a turn, and stopping during one cancels, captures, then deletes', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'mirabelle')
    await client.response(2)
    prompt(client, 3, sessionId, '/sleep 30')
    await until(() => view(target, name)?.state === 'en tour')
    client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    assert.deepEqual((await client.response(3)).result, { stopReason: 'cancelled' })

    prompt(client, 4, sessionId, '/sleep 30')
    await until(() => view(target, name)?.state === 'en tour')
    const stopped = await post(target, `/api/sandboxes/${name}/stop`)
    assert.equal(stopped.accepted, true)
    assert.equal(stopped.reason, 'arrêt demandé')
    const anchor = stopped.anchor as { id: string; sessionId: string }
    assert.equal(anchor.sessionId, sessionId)
    assert.equal(view(target, name), undefined)
    const bytes = new TextDecoder().decode((await target.anchors.bytes(anchor.id))!)
    assert.match(bytes, /mirabelle/)
    await until(() => !target.kube.claims.has(name))
  })

  it('restores an anchor into a new sandbox that remembers', async () => {
    const target = await lab()
    const source = await ready(target)
    const client = await consumer(target, source)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'quetsche')
    await client.response(2)
    const stopped = await post(target, `/api/sandboxes/${source}/stop`)
    const anchorId = (stopped.anchor as { id: string }).id

    const mismatched = await post(target, '/api/sandboxes', { requestId: crypto.randomUUID(), pool: 'claude-test', anchorId })
    assert.match(mismatched.reason as string, /harness/)

    const restored = await ready(target, 'mock-test', { anchorId })
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
    assert.equal((await post(target, `/api/lab/sandboxes/${name}/drop-bridge`)).accepted, true)
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
    assert.equal(kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn], undefined)
  })

  it('deletes after inactivity or a too-long turn, anchor first', async () => {
    const target = await lab({ defaults: { idleSeconds: 1, turnCapSeconds: 2 } })
    const idle = await ready(target)
    const client = await consumer(target, idle)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'une ligne')
    await client.response(2)
    const removal = await until(() => target.manager.snapshot().history.find((entry) => entry.name === idle), 8000)
    assert.equal(removal.reason, 'inactivité')
    assert.notEqual(removal.anchor, null)

    const long = await ready(target)
    const other = await consumer(target, long)
    const otherSession = await session(other)
    prompt(other, 2, otherSession, '/sleep 60')
    const capped = await until(() => target.manager.snapshot().history.find((entry) => entry.name === long), 10_000)
    assert.equal(capped.reason, 'tour trop long')
    assert.notEqual(capped.anchor, null)
  })

  it('declares a sandbox lost when its adapter dies or its Pod is replaced', async () => {
    const target = await lab()
    const crashed = await ready(target)
    const client = await consumer(target, crashed)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'avant la chute')
    await client.response(2)
    prompt(client, 3, sessionId, '/crash')
    const lost = await until(() => target.manager.snapshot().history.find((entry) => entry.name === crashed))
    assert.equal(lost.reason, 'adaptateur perdu')
    assert.notEqual(lost.anchor, null, String(lost.anchorError))

    const replaced = await ready(target)
    assert.equal((await post(target, `/api/lab/sandboxes/${replaced}/delete-pod`)).accepted, true)
    const gone = await until(() => target.manager.snapshot().history.find((entry) => entry.name === replaced), 10_000)
    assert.equal(gone.reason, 'processus remplacé')
  })

  it('forgets a sandbox the infrastructure deleted, without an anchor', async () => {
    const target = await lab()
    const name = await ready(target)
    target.kube.expire(name)
    const removal = await until(() => target.manager.snapshot().history.find((entry) => entry.name === name))
    assert.equal(removal.anchor, null)
    assert.match(removal.reason, /hors du back-end/)
  })

  it('probes the bridge with bad tokens', async () => {
    const target = await lab()
    const name = await ready(target)
    const probe = await post(target, `/api/lab/sandboxes/${name}/probe-auth`)
    const results = probe.results as { case: string; info: number; acp: number }[]
    for (const result of results.slice(0, -1)) assert.deepEqual([result.info, result.acp], [401, 401], result.case)
    assert.deepEqual([results.at(-1)!.info, results.at(-1)!.acp], [200, 101])
    await until(() => view(target, name)?.state === 'prêt')
  })
})

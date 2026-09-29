// The executions contract (docs/specs/executions.md), against real bridges running the mock agent and an
// in-memory Kubernetes API whose controller destroys claims at their deadline.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { AnchorStore } from '../src/anchors.ts'
import { createAnchorReceiver, createApi, type CredentialSource } from '../src/http.ts'
import { ANNOTATION, ExecutionManager, type Limits } from '../src/manager.ts'
import { FakeKube, NAMESPACE } from './fake-kube.ts'
import { Collector, keys, mockBridge } from '@agora/testkit'

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

async function lab(options: { kube?: FakeKube; anchors?: AnchorStore; defaults?: Partial<Limits>; maxActive?: number; renewSeconds?: number; credentials?: CredentialSource } = {}): Promise<Lab> {
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
  const base = await listen(createApi({ manager, anchors, lab: true, onRestart: () => {}, ...(options.credentials === undefined ? {} : { credentials: options.credentials }) }))
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
    if (Date.now() > deadline) throw new Error('timed out')
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
  await until(() => view(target, name)?.state === 'ready')
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
    assert.match((await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'no-such-pool' })).reason as string, /not in the catalogue/)
    assert.match((await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test', limits: { turnCapSeconds: 5 } })).reason as string, /out of bounds/)
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
    assert.ok(!('seq' in JSON.parse(target.kube.claims.get(name)!.metadata.annotations![ANNOTATION.turn]!)))
    prompt(client, 3, sessionId, 'too early')
    assert.match(String(((await client.response(3)).error as { message: string }).message), /a turn is already in progress/)
    assert.deepEqual((await client.response(2)).result, { stopReason: 'end_turn' })
    await until(() => target.kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn] === undefined)
    assert.equal(view(target, name)?.state, 'ready')
  })

  it('refuses the prompt when its deadline cannot be accepted', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    target.kube.failPatches = true
    prompt(client, 2, sessionId, 'hello')
    const answer = await client.response(2)
    target.kube.failPatches = false
    assert.match(String((answer.error as { message: string }).message), /deadline not accepted/)
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
    assert.equal(deadlinesOf(target, name).length, before + during.length, 'renewed outside a turn')
  })

  it('caps a turn at its maximum: the infrastructure destroys it, the Pod pushes its anchor', async () => {
    const target = await lab({ defaults: { turnCapSeconds: 2 }, renewSeconds: 1 })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/sleep 60')
    const end = await ending(target, name)
    assert.match(end.reason, /turn in progress at the deadline/)
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
    assert.equal(end.reason, 'deadline after the last turn')
    assert.equal(end.anchor?.sessionId, sessionId)
    assert.deepEqual(end.anchor?.files.map((file) => file.path), [`${sessionId}.jsonl`])
  })

  it('stops by no longer renewing, cancels a turn in flight, and never deletes', async () => {
    const target = await lab({ defaults: { leaseSeconds: 4 } })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'before')
    await client.response(2)
    prompt(client, 3, sessionId, '/sleep 60')
    await until(() => view(target, name)?.state === 'in turn')
    const patches = deadlinesOf(target, name).length
    const stopped = await post(target, `/api/executions/${name}/stop`)
    assert.equal(stopped.accepted, true)
    assert.deepEqual((await client.response(3)).result, { stopReason: 'cancelled' })
    assert.equal(view(target, name)?.state, 'stopped')
    assert.match((await post(target, `/api/executions/${name}/stop`)).reason as string, /already requested/)
    const end = await ending(target, name)
    assert.equal(deadlinesOf(target, name).length, patches, 'renewed after the stop')
    assert.equal(end.reason, 'stop requested')
    assert.match(new TextDecoder().decode((await target.anchors.bundle(end.anchor!.id))!), /YmVmb3Jl|before/)
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

  it('reconnects without replay, marks a turn uncertain and resolves it only from its final answer', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/sleep 3')
    await until(() => view(target, name)?.state === 'in turn')
    assert.equal((await post(target, `/api/lab/executions/${name}/drop-bridge`)).accepted, true)
    await until(() => view(target, name)?.state === 'uncertain')
    assert.deepEqual((await client.response(2)).result, { stopReason: 'end_turn' })
    await until(() => view(target, name)?.state === 'ready')
    assert.ok(target.manager.snapshot().logs.some((entry) => entry.message.includes('without replay or initialize')))
  })

  it('finds a turn in flight after its own restart, from the claim alone', async () => {
    const kube = new FakeKube(publicKey)
    cleanups.push(() => kube.closeAll())
    const anchors = new AnchorStore(mkdtempSync(join(tmpdir(), 'anchors-')))
    const first = await lab({ kube, anchors })
    const name = await ready(first)
    const client = await consumer(first, name)
    const sessionId = await session(client)
    const initialized = kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize]
    const firstEpoch = (client.messages.find((m) => (m.event as { type?: string } | undefined)?.type === 'reset')!.event as { epoch: string }).epoch
    prompt(client, 2, sessionId, '/sleep 2')
    await until(() => kube.claims.get(name)?.metadata.annotations?.[ANNOTATION.turn])
    await first.manager.stop()
    const second = await lab({ kube, anchors })
    await until(() => view(second, name)?.state === 'uncertain')
    await until(() => view(second, name)?.state === 'ready', 8000)
    assert.match(String(view(second, name)?.lastTurn?.outcome), /end_turn/)
    assert.equal(kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize], initialized, 'the same initialization is retained, never resent')
    const back = await consumer(second, name, 10_000)
    assert.deepEqual((await back.response(2)).result, { stopReason: 'end_turn' })
    const reset = back.messages.find((m) => (m.event as { type?: string } | undefined)?.type === 'reset')!.event as { epoch: string }
    assert.notEqual(reset.epoch, firstEpoch)
  })

  it('restarts while idle without initializing the mock twice or losing capabilities', async () => {
    const kube = new FakeKube(publicKey)
    cleanups.push(() => kube.closeAll())
    const anchors = new AnchorStore(mkdtempSync(join(tmpdir(), 'anchors-')))
    const first = await lab({ kube, anchors })
    const name = await ready(first)
    const initialization = kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize]
    assert.equal(JSON.parse(initialization!).result.agentInfo.name, 'agora-mock-agent')
    await first.manager.stop()
    const second = await lab({ kube, anchors })
    await until(() => view(second, name)?.state === 'ready')
    assert.equal(kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize], initialization)
    const client = await consumer(second, name)
    client.send({ jsonrpc: '2.0', id: 'consumer-init', method: 'initialize', params: { protocolVersion: 1 } })
    assert.deepEqual((await client.response('consumer-init')).result, JSON.parse(initialization!).result)
    const sessionId = await session(client)
    prompt(client, 1, sessionId, 'still alive')
    assert.deepEqual((await client.response(1)).result, { stopReason: 'end_turn' })
  })

  it('recovers a pending initialize after a restart by waiting for its original answer', async () => {
    const kube = new FakeKube(publicKey)
    kube.bridgeFactory = (key, pod) => mockBridge(key, pod, { initializeDelayMs: 1500 })
    cleanups.push(() => kube.closeAll())
    const anchors = new AnchorStore(mkdtempSync(join(tmpdir(), 'anchors-')))
    const first = await lab({ kube, anchors })
    const created = await post(first, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test' })
    const name = created.name as string
    const bridge = await until(() => {
      const pod = view(first, name)?.pod
      return pod ? kube.bridges.get(pod) : undefined
    })
    const requests = join(bridge.home, '.mock-agent', 'initialize-requests')
    await until(() => existsSync(requests))
    assert.equal(view(first, name)?.state, 'connecting', 'Pod readiness is not ACP readiness')
    const pending = JSON.parse(kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize]!)
    assert.equal(pending.result, null)
    await first.manager.stop()
    const second = await lab({ kube, anchors })
    await until(() => view(second, name)?.state === 'ready')
    assert.equal(readFileSync(requests, 'utf8'), `${String(pending.requestId)}\n`, 'exactly one initialize reached the process')
    assert.equal(JSON.parse(kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize]!).result.agentInfo.name, 'agora-mock-agent')
  })

  it('retries saving an initialization answer without sending another initialize', async () => {
    const kube = new FakeKube(publicKey)
    cleanups.push(() => kube.closeAll())
    const patch = kube.patchClaim.bind(kube)
    let refusedOnce = false
    kube.patchClaim = async (name, input) => {
      const initialization = (input.metadata as { annotations?: Record<string, string> } | undefined)?.annotations?.[ANNOTATION.initialize]
      if (!refusedOnce && initialization !== undefined && JSON.parse(initialization).result !== null) {
        refusedOnce = true
        throw new Error('temporary annotation failure')
      }
      return patch(name, input)
    }
    const target = await lab({ kube })
    const created = await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test' })
    const name = created.name as string
    await until(() => view(target, name)?.state === 'error')
    assert.equal(JSON.parse(kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize]!).result, null)
    assert.equal((await post(target, `/api/lab/executions/${name}/drop-bridge`)).accepted, true)
    await until(() => view(target, name)?.state === 'ready')
    assert.equal(JSON.parse(kube.claims.get(name)!.metadata.annotations![ANNOTATION.initialize]!).result.agentInfo.name, 'agora-mock-agent')
  })

  it('receives all unread lines after Agora is away beyond the end of a turn', async () => {
    const target = await lab()
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, '/sleep 3')
    await until(() => view(target, name)?.state === 'in turn')
    assert.equal((await post(target, `/api/lab/executions/${name}/drop-bridge`, { pauseSeconds: 5 })).accepted, true)
    await until(() => view(target, name)?.state === 'uncertain')
    assert.deepEqual((await client.response(2)).result, { stopReason: 'end_turn' })
    const chunks = client.acp().filter((m) => m.method === 'session/update').map((m) => JSON.stringify(m))
    assert.equal(chunks.length, 4)
    for (let i = 0; i < 3; i++) assert.ok(chunks[i]!.includes(`second ${String(i + 1)}/3`))
    assert.match(chunks[3]!, /Slept 3/)
    await until(() => view(target, name)?.state === 'ready')
  })

  it('treats close 1001 as ending and never reconnects to a terminating Pod', async () => {
    const target = await lab()
    const name = await ready(target)
    await target.kube.bridges.get(view(target, name)!.pod!)!.bridge.terminate()
    await until(() => view(target, name)?.state === 'ending')
    await new Promise((resolve) => setTimeout(resolve, 2200))
    assert.equal(view(target, name)?.bridge.state, 'none')
  })

  it('stops renewing an execution whose adapter died; its anchor still leaves with the Pod', async () => {
    const target = await lab({ defaults: { leaseSeconds: 4 } })
    const name = await ready(target)
    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 2, sessionId, 'before the fall')
    await client.response(2)
    prompt(client, 3, sessionId, '/crash')
    await until(() => view(target, name)?.state === 'lost')
    const end = await ending(target, name)
    assert.match(end.reason, /lost/)
    assert.notEqual(end.anchor, null, String(end.anchorError))
  })

  it('declares an execution lost when its Pod was replaced', async () => {
    const target = await lab()
    const name = await ready(target)
    await target.kube.replacePod(view(target, name)!.pod!)
    await until(() => view(target, name)?.state === 'lost')
    assert.match(String(view(target, name)?.reason), /process replaced/)
  })

  it('refuses an anchor pushed without a valid projected token', async () => {
    const target = await lab()
    const body = JSON.stringify({ format: 'agora-anchor/1', harness: 'mock', files: [], stable: true })
    for (const headers of [{}, { authorization: 'Bearer faux' }] as Record<string, string>[]) {
      const response = await fetch(`http://${target.receiver}/anchors`, { method: 'POST', body, headers })
      assert.equal(response.status, 401)
    }
    assert.equal((await fetch(`http://${target.receiver}/anchors`, { method: 'POST', body, headers: { authorization: 'Bearer pod:unknown' } })).status, 404)
    assert.deepEqual(await target.anchors.list(), [])
  })

  it('forgets a claim that disappears without any push', async () => {
    const target = await lab({ defaults: { leaseSeconds: 1 } })
    const created = await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'no-such-pool-ailleurs' })
    assert.equal(created.accepted, false)
    const claim = await post(target, '/api/executions', { requestId: crypto.randomUUID(), pool: 'mock-test' })
    const end = await ending(target, claim.name as string)
    assert.equal(end.anchor, null)
    assert.match(String(end.anchorError), /no native file|no anchor/)
  })

  it('probes the bridge with bad tokens', async () => {
    const target = await lab()
    const name = await ready(target)
    const probe = await post(target, `/api/lab/executions/${name}/probe-auth`)
    const results = probe.results as { case: string; info: number; acp: number }[]
    for (const result of results.slice(0, -1)) assert.deepEqual([result.info, result.acp], [401, 401], result.case)
    assert.deepEqual([results.at(-1)!.info, results.at(-1)!.acp], [200, 101])
    await until(() => view(target, name)?.state === 'ready')
  })

  it('hands an execution a credential (docs/specs/credentials.md): minted, given to the bridge, never kept by Agora', async () => {
    // A stand-in for the credential proxy: keeps each CONNECT head and refuses it.
    const heads: string[] = []
    const proxy = createTcpServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        heads.push(chunk.toString('latin1'))
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())))
    const minted: { label: string; ttlSeconds: number }[] = []
    const credentials: CredentialSource = {
      describe: () => ({ vault: 'default' }),
      mint: async (input) => {
        minted.push(input)
        return { proxy: `127.0.0.1:${String((proxy.address() as AddressInfo).port)}`, token: 'proxy-session-token', expiresAt: '2030-01-01T00:00:00Z' }
      },
    }

    const without = await lab()
    const bare = await ready(without)
    const refusedAnswer = await post(without, `/api/executions/${bare}/credentials`, {})
    assert.equal(refusedAnswer.status, 503)

    const target = await lab({ credentials })
    const name = await ready(target)
    assert.equal(view(target, name)?.outbound?.proxy, null, 'no credential until one is attached')
    const attached = await post(target, `/api/executions/${name}/credentials`, { ttlSeconds: 900 })
    assert.equal(attached.accepted, true, JSON.stringify(attached))
    assert.deepEqual(minted, [{ label: `agora ${name}`, ttlSeconds: 900 }])
    assert.equal(view(target, name)?.outbound?.expiresAt, '2030-01-01T00:00:00Z')

    const client = await consumer(target, name)
    const sessionId = await session(client)
    prompt(client, 1, sessionId, '/fetch https://api.example.test/v1/models')
    await client.response(1)
    assert.match(heads[0] ?? '', /^CONNECT api\.example\.test:443 HTTP\/1\.1\r\n/)
    assert.match(heads[0] ?? '', /Proxy-Authorization: Bearer proxy-session-token/)
    await until(() => view(target, name)?.outbound?.targets['api.example.test:443']?.lastStatus === 403)
    assert.ok(!JSON.stringify(target.manager.snapshot()).includes('proxy-session-token'), 'the token is kept nowhere on Agora’s side')
  })
})

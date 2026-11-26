// The execution mechanics alone (docs/specs/executions.md, "The mechanics"), against real bridges
// running the mock agent and an in-memory Kubernetes API. What the log decides is tested with the
// log (packages/log/test).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { ANCHOR_FORMAT, checksumOf } from '@agora/harness-bridge/anchor'
import { keys } from '@agora/testkit'
import { createAnchorReceiver } from '../src/http.ts'
import { claimName, ExecutionManager, type Handler } from '../src/manager.ts'
import { FakeKube, NAMESPACE } from './fake-kube.ts'

async function until<T>(what: string, find: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found !== undefined && found !== null && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A handler that accepts every connection and keeps what it is told. */
function recorder(): Handler & { connections: string[]; claims: number } {
  const seen = { connections: [] as string[], claims: 0 }
  return Object.assign(seen, {
    async claim() {
      seen.claims++
    },
    async connected(_execution: string, connection: string) {
      seen.connections.push(connection)
      return true
    },
    async line() {},
    async closed() {},
  })
}

test('E20 the bridge answers 401 with no token, an expired one, one for another sandbox, one signed by another key', async (t) => {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const manager = new ExecutionManager({ kube, signingKey: pair.privateKey, bridgePort: 8080, bridgeAddress: kube.address, tickMs: 100, reconnectMs: 200 })
  t.after(async () => {
    await manager.stop()
    await kube.closeAll()
  })
  const handler = recorder()
  await manager.start(handler)
  const execution = randomUUID()
  const target = { execution, claimName: claimName(execution), pool: 'mock-test' }
  await manager.run(target)
  await manager.createClaim(target, new Date(Date.now() + 120_000).toISOString())
  await until('connected', () => manager.connectionOf(execution))
  const probed = await manager.lab.probeAuth(target.claimName)
  assert.ok(probed.accepted)
  assert.deepEqual(probed.value, [
    { case: 'no token', info: 401, acp: 401 },
    { case: 'expired token', info: 401, acp: 401 },
    { case: 'token for another sandbox', info: 401, acp: 401 },
    { case: 'token signed by another key', info: 401, acp: 401 },
    { case: 'valid token (control)', info: 200, acp: 101 },
  ])
})

test('E21 an anchor pushed without a valid projected token is refused with 401, and nothing is stored', async (t) => {
  const pair = keys()
  const kube = new FakeKube(pair.publicKey)
  const received: string[] = []
  const receiver = createAnchorReceiver({
    receive: async (pod) => {
      received.push(pod.podName)
      return { accepted: true, value: { anchorId: randomUUID() } }
    },
    namespace: NAMESPACE,
    verify: (token) => kube.reviewToken(token),
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve))
    await kube.closeAll()
  })
  const url = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/anchors`
  const content = Buffer.from('{"said":"hello"}\n')
  const body = JSON.stringify({ format: ANCHOR_FORMAT, harness: 'mock', files: [{ path: 's.jsonl', checksum: checksumOf(content), content: content.toString('base64') }], stable: true })
  const push = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then((r) => r.status)
  assert.equal(await push({}), 401)
  assert.equal(await push({ authorization: 'Bearer not-a-projected-token' }), 401)
  assert.deepEqual(received, [])
  // Control: a valid projected token reaches the store.
  assert.equal(await push({ authorization: 'Bearer pod:mock-test-1' }), 200)
  assert.deepEqual(received, ['mock-test-1'])
})

/**
 * A cluster of one claim, its Pod named, never connected to (no Service): the Pod is read on each tick. Its Pod
 * reads are held as `pod` says, and the watch never reports the deadline's deletion.
 */
function oneClaim(shutdownTime: string, pod: (startedAt: number) => Promise<unknown>) {
  const claim = {
    metadata: { name: 'sbx-race', uid: 'uid-race', labels: { 'app.kubernetes.io/managed-by': 'agora', 'agora.bretagne.dev/execution-id': 'race' } },
    spec: { lifecycle: { shutdownTime } },
    status: { conditions: [{ type: 'Ready', status: 'True' }], sandbox: { name: 'pod-race' } },
  }
  const reads: number[] = []
  const kube = {
    listClaims: async () => ({ items: [claim], resourceVersion: '1' }),
    watchClaims: (_s: string, _v: string, _e: unknown, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
    getPod: async () => {
      reads.push(Date.now())
      return pod(Date.now())
    },
    getSandbox: async () => null,
  } as unknown as ConstructorParameters<typeof ExecutionManager>[0]['kube']
  return { kube, reads }
}

test('E40 a Pod read in flight as its claim’s deadline comes, answered “no Pod”: not kept as a Pod gone; the same answer well before it is', async (t) => {
  const run = async (shutdownIn: number, pod: (startedAt: number) => Promise<unknown>) => {
    const { kube, reads } = oneClaim(new Date(Date.now() + shutdownIn).toISOString(), pod)
    const manager = new ExecutionManager({ kube, signingKey: keys().privateKey, bridgePort: 8080, tickMs: 50 })
    t.after(() => manager.stop())
    await manager.start(recorder())
    await manager.run({ execution: 'race', claimName: 'sbx-race', pool: 'mock-test' })
    return { manager, reads }
  }
  // Its deadline 5,130 ms on: the first read starts some 80 ms before the margin's end, and answers that no Pod is there
  // 140 ms later, past it — as Agent Sandbox deleting the Pod for that deadline would, the watch not having said so.
  const deadline = Date.now() + 5_130
  const racing = await run(5_130, () => new Promise((resolve) => setTimeout(() => resolve(null), 140)))
  await until('the read answered', () => racing.reads.length >= 1 && Date.now() > racing.reads[0]! + 300)
  const margin = deadline - 5_000
  assert.ok(racing.reads[0]! < margin && racing.reads[0]! + 140 > margin, `read at ${String(racing.reads[0]! - margin)} ms from the margin's end`)
  assert.equal(racing.manager.observed('race')?.pod, null)
  // Within the margin the Pod is read again, for a container killed for lack of memory alone: "no Pod" keeps nothing still.
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  assert.ok(racing.reads.length >= 2, String(racing.reads.length))
  assert.equal(racing.manager.observed('race')?.pod, null)
  // Control: the same “no Pod” a minute before the deadline is kept, with when it was seen.
  const early = await run(60_000, async () => null)
  const seen = await until('the Pod seen gone', () => early.manager.observed('race')?.pod)
  assert.equal(seen.gone, true)
  assert.ok(Math.abs(seen.at - Date.now()) < 5_000)
})

test('E39 a container killed for lack of memory, read within the margin before its claim’s deadline or across its start: kept; a Pod not found there is not', async (t) => {
  const run = async (shutdownIn: number, pod: () => Promise<unknown>) => {
    const { kube, reads } = oneClaim(new Date(Date.now() + shutdownIn).toISOString(), pod)
    const manager = new ExecutionManager({ kube, signingKey: keys().privateKey, bridgePort: 8080, tickMs: 50 })
    t.after(() => manager.stop())
    await manager.start(recorder())
    await manager.run({ execution: 'race', claimName: 'sbx-race', pool: 'mock-test' })
    return { manager, reads }
  }
  const oom = { status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] } }
  // The deadline 4 s on: every read is within the margin.
  const within = await run(4_000, async () => oom)
  const kept = await until('the OOMKilled container kept', () => within.manager.observed('race')?.pod)
  assert.deepEqual([kept.reason, kept.gone, kept.exitCode], ['OOMKilled', false, 137])
  // Begun 100 ms before the margin's end, answered 200 ms later, within it.
  const deadline = Date.now() + 5_150
  const across = await run(5_150, () => new Promise((resolve) => setTimeout(() => resolve(oom), 200)))
  const late = await until('the OOMKilled container kept', () => across.manager.observed('race')?.pod)
  assert.equal(late.reason, 'OOMKilled')
  assert.ok(across.reads[0]! < deadline - 5_000 && late.at > deadline - 5_000, `read at ${String(across.reads[0]! - deadline)} ms, kept at ${String(late.at - deadline)} ms from the deadline`)
  // Control: within the margin, no Pod found says nothing.
  const gone = await run(4_000, async () => null)
  await until('read twice', () => gone.reads.length >= 2)
  assert.equal(gone.manager.observed('race')?.pod, null)
})

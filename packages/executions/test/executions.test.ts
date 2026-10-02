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

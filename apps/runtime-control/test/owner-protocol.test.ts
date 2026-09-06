import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase } from '@agora/testkit'
import { payloadDigest, type OwnerRequest } from '@agora/owner-requests'
import { PgOwnerGate } from '@agora/owner-requests'
import type { HttpError, K8sClient, K8sObject } from '../src/k8s-client.js'

async function insertWorkstream(pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, id: string): Promise<void> {
  await pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [id, 'p', 't', randomUUID()])
}

function request(overrides: Partial<OwnerRequest> = {}): OwnerRequest {
  const payload = overrides.payload ?? { harnessId: 'claude-code' }
  return {
    epoch: 1,
    workstreamId: '00000000-0000-4000-8000-000000000001',
    attemptKey: 'attempt-1',
    operation: 'create_pod',
    target: { kind: 'reserved', id: 'inc-1' },
    payload,
    payloadDigest: payloadDigest(payload),
    revisionSet: {},
    ...overrides,
  }
}

// PgOwnerGate's own contract (stale epoch, idempotent replay, key mismatch, retired target,
// multi-owner isolation) is tested once, in packages/owner-requests where the class lives — see
// pg-gate.test.ts. These tests exercise runtime-control's owner-api HTTP surface built on top of it.

// A minimal K8sClient double for the owner-api create/cleanup flows — exercises the real
// buildPodSpec/catalogue path and the reserved-target correlation, not a re-decision of it.
class FakeK8sClient implements K8sClient {
  readonly namespace = 'agora-runs'
  #pods = new Map<string, K8sObject>()
  #createCalls = 0
  #failNextCreateWith409 = false

  failNextCreateWith409(): void {
    this.#failNextCreateWith409 = true
  }

  get createCalls(): number {
    return this.#createCalls
  }

  async createPod(pod: K8sObject): Promise<K8sObject> {
    this.#createCalls += 1
    const name = (pod['metadata'] as { name: string }).name
    if (this.#failNextCreateWith409) {
      this.#failNextCreateWith409 = false
      throw Object.assign(new Error('already exists'), { status: 409 }) satisfies HttpError
    }
    const created = { ...pod, metadata: { ...(pod['metadata'] as object), uid: `uid-${name}` } }
    this.#pods.set(name, created)
    return created
  }

  async getPod(name: string): Promise<K8sObject | undefined> {
    return this.#pods.get(name)
  }

  async listPods(): Promise<{ items: readonly K8sObject[]; metadata?: { resourceVersion?: string } }> {
    return { items: [...this.#pods.values()] }
  }

  async deletePod(name: string): Promise<void> {
    this.#pods.delete(name)
  }

  async getNode(): Promise<K8sObject | undefined> {
    return undefined
  }

  // eslint-disable-next-line require-yield
  async *watchPods(): AsyncGenerator<{ type: string; object: K8sObject; resourceVersion: string | null }> {
    return
  }

  seed(name: string, pod: K8sObject): void {
    this.#pods.set(name, pod)
  }
}

test('owner-api create_pod: the PodSpec comes from the reviewed catalogue, keyed by the reserved target', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [] }]
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams: new Map(), gate, harnesses, settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const req = request({ workstreamId })
      const first = await postOwnerRequest(port, req)
      assert.equal(first.kind, 'completed')
      assert.equal(k8s.createCalls, 1)
      const stored = await k8s.getPod('agora-' + workstreamId.slice(0, 8) + '-inc-1')
      assert.ok(stored, 'the Pod is discoverable by its deterministic name')
      assert.equal((stored!['spec'] as { containers: { image: string }[] }).containers[0]!.image, harnesses[0]!.imageDigest)

      // Same attempt key, same payload: the gate replays without calling Kubernetes again.
      const replay = await postOwnerRequest(port, req)
      assert.deepEqual(replay, first)
      assert.equal(k8s.createCalls, 1, 'idempotent replay never re-dispatches to Kubernetes')
    } finally {
      server.close()
    }
  })
})

test('owner-api create_pod: a 409 from a crash-then-retry resolves by discovering the already-created Pod', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const name = 'agora-' + workstreamId.slice(0, 8) + '-inc-1'
    k8s.seed(name, { apiVersion: 'v1', kind: 'Pod', metadata: { name, uid: 'uid-existing' }, spec: { containers: [{ image: `sha256:${'a'.repeat(64)}` }] } })
    k8s.failNextCreateWith409()
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [] }]
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams: new Map(), gate, harnesses, settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const result = await postOwnerRequest(port, request({ workstreamId }))
      assert.equal(result.kind, 'completed')
      assert.equal((result['result'] as { podUid: string }).podUid, 'uid-existing')
    } finally {
      server.close()
    }
  })
})

test('owner-api gate_release: mints a bridge token verifiable for exactly this incarnation, only once the seam actually releases', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  const { verifyBridgeToken } = await import('@agora/acp')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [] }]
    const seams = new Map()
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams, gate, harnesses, settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      // create_pod registers the seam for this incarnation.
      await postOwnerRequest(port, request({ workstreamId }))
      const release = await postOwnerRequest(
        port,
        request({ workstreamId, operation: 'gate_release', attemptKey: 'attempt-release', payload: { sessionId: 'session-1' } }),
      )
      assert.equal(release.kind, 'completed')
      const token = (release['result'] as { bridgeToken: string }).bridgeToken
      assert.ok(typeof token === 'string' && token.length > 0)
      assert.deepEqual(verifyBridgeToken(token, 'inc-1', 'test-secret').ok, true)
      assert.equal(verifyBridgeToken(token, 'inc-1', 'wrong-secret').ok, false)
      assert.equal(verifyBridgeToken(token, 'some-other-incarnation', 'test-secret').ok, false)
    } finally {
      server.close()
    }
  })
})

function fakeObligations() {
  return {
    async obligationsFor() {
      return []
    },
    async record() {
      /* not exercised here */
    },
    async discharge() {
      return false
    },
    async allOutstanding() {
      return []
    },
  }
}

async function postOwnerRequest(port: number, req: OwnerRequest): Promise<{ kind: string; [key: string]: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/owner-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  return (await res.json()) as { kind: string; [key: string]: unknown }
}

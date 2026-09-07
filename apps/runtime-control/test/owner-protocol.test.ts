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

  setPodStatus(name: string, status: Record<string, unknown>): void {
    const pod = this.#pods.get(name)
    if (pod !== undefined) this.#pods.set(name, { ...pod, status })
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
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [], harnessHome: '/home/agent', workspaceRoot: '/home/agent/work' }]
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
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [], harnessHome: '/home/agent', workspaceRoot: '/home/agent/work' }]
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
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [], harnessHome: '/home/agent', workspaceRoot: '/home/agent/work' }]
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

test('evidence: a live restartCount catches the seam up exactly once, then stays put on a later read (SESSION-A06)', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  const { LaunchSeam } = await import('../src/launch-seam.js')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const name = 'agora-' + workstreamId.slice(0, 8) + '-inc-1'
    k8s.seed(name, {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, uid: 'uid-1', creationTimestamp: new Date().toISOString() },
      spec: { containers: [{ image: `sha256:${'a'.repeat(64)}` }] },
      status: { phase: 'Running', containerStatuses: [{ imageID: `sha256:${'a'.repeat(64)}`, restartCount: 2 }] },
    })
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const seams = new Map([[name, new LaunchSeam('inc-1')]])
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams, gate, harnesses: [], settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const first = (await (await fetch(`http://127.0.0.1:${port}/v1/pods/${name}/evidence`)).json()) as { processGeneration: number; seam: { processGeneration: number } | null }
      assert.equal(first.processGeneration, 2, 'catches up to the live restartCount in one read')
      assert.equal(first.seam?.processGeneration, 2)

      const second = (await (await fetch(`http://127.0.0.1:${port}/v1/pods/${name}/evidence`)).json()) as { processGeneration: number }
      assert.equal(second.processGeneration, 2, 'an unchanged restartCount never advances the seam again')
    } finally {
      server.close()
    }
  })
})

test('custody: the offer reaches the Pod on the evidence endpoint, and the gate opens only once the placement verifies', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  const { CustodyTransport } = await import('../src/custody-transport.js')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const name = 'agora-' + workstreamId.slice(0, 8) + '-inc-1'
    const bytes = new TextEncoder().encode('{"type":"user","sessionId":"ctx-1"}\n')
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [], harnessHome: '/home/agent', workspaceRoot: '/home/agent/work' }]
    const custody = new CustodyTransport({ secret: 'test-secret', readPayload: async (saveId) => (saveId === 'save-1' ? bytes : null) })
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams: new Map(), gate, harnesses, settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret', custody })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    try {
      await postOwnerRequest(port, request({ workstreamId }))
      const offer = custody.stage({ podName: name, saveId: 'save-1', checksum: 'sha256:abc', byteLength: bytes.byteLength })

      // What the Pod sees while it waits at the seam: the offer, and no bytes.
      const evidence = (await (await fetch(`${base}/v1/pods/${name}/evidence`)).json()) as { custody: { saveId: string; token: string } | null }
      assert.equal(evidence.custody?.saveId, 'save-1')
      assert.equal(evidence.custody?.token, offer.token)

      assert.equal((await fetch(`${base}/v1/pods/${name}/custody/payload?token=wrong`)).status, 403)
      const payload = await fetch(`${base}/v1/pods/${name}/custody/payload?token=${offer.token}`)
      assert.equal(payload.status, 200)
      assert.deepEqual(new Uint8Array(await payload.arrayBuffer()), bytes)

      // The gate refuses while the placement is unverified — the adapter must not open a context on
      // a transcript nobody checked.
      const blocked = await postOwnerRequest(port, request({ workstreamId, operation: 'gate_release', attemptKey: 'attempt-blocked', payload: { sessionId: 'session-1' } }))
      assert.equal(blocked.kind, 'unknown')
      assert.match(String(blocked['detail']), /has not been verified/)

      const wrongReport = await fetch(`${base}/v1/pods/${name}/custody/placement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: offer.token, checksum: 'sha256:different', byteLength: bytes.byteLength, path: '/home/agent/x.jsonl' }),
      })
      assert.equal(wrongReport.status, 409)

      const goodReport = await fetch(`${base}/v1/pods/${name}/custody/placement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: offer.token, checksum: 'sha256:abc', byteLength: bytes.byteLength, path: '/home/agent/x.jsonl' }),
      })
      assert.equal(goodReport.status, 200)

      const released = await postOwnerRequest(port, request({ workstreamId, operation: 'gate_release', attemptKey: 'attempt-released', payload: { sessionId: 'session-1' } }))
      assert.equal(released.kind, 'completed')
      // And the offer is withdrawn: there is nothing left for the Pod to place.
      const after = (await (await fetch(`${base}/v1/pods/${name}/evidence`)).json()) as { custody: unknown }
      assert.equal(after.custody, null)
    } finally {
      server.close()
    }
  })
})

test('custody: a runtime-control that serves no placements behaves exactly as it did before S9', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const name = 'agora-' + workstreamId.slice(0, 8) + '-inc-1'
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [], harnessHome: '/home/agent', workspaceRoot: '/home/agent/work' }]
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams: new Map(), gate, harnesses, settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await postOwnerRequest(port, request({ workstreamId }))
      const evidence = (await (await fetch(`http://127.0.0.1:${port}/v1/pods/${name}/evidence`)).json()) as { custody: unknown }
      assert.equal(evidence.custody, null)
      assert.equal((await fetch(`http://127.0.0.1:${port}/v1/pods/${name}/custody/payload?token=x`)).status, 404)
      const released = await postOwnerRequest(port, request({ workstreamId, operation: 'gate_release', attemptKey: 'attempt-release', payload: { sessionId: 'session-1' } }))
      assert.equal(released.kind, 'completed')
    } finally {
      server.close()
    }
  })
})

test('evidence: no seam yet (read before create_pod) is generation 0, not an error', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const name = 'agora-' + workstreamId.slice(0, 8) + '-inc-1'
    k8s.seed(name, { apiVersion: 'v1', kind: 'Pod', metadata: { name, uid: 'uid-1' }, spec: { containers: [] }, status: { phase: 'Pending' } })
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams: new Map(), gate, harnesses: [], settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const evidence = (await (await fetch(`http://127.0.0.1:${port}/v1/pods/${name}/evidence`)).json()) as { processGeneration: number; seam: unknown }
      assert.equal(evidence.processGeneration, 0)
      assert.equal(evidence.seam, null)
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

test('owner-api bridge-token: a still-running incarnation gets a FRESH token, and a Pod that is gone gets none', async () => {
  const { createOwnerApi } = await import('../src/owner-api.js')
  const { WakeLog } = await import('../src/wakes.js')
  const { verifyBridgeToken, bridgeTokenExpiry } = await import('@agora/acp')
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await insertWorkstream(db.pool, workstreamId)
    const k8s = new FakeK8sClient()
    const gate = new PgOwnerGate(db.pool as never, 'runtime-control')
    const settings = { namespace: 'agora-runs', startupDeadlineSeconds: 120, terminationGraceSeconds: 30, inventoryFreshnessMs: 5000, runtimeClassName: 'sandboxed', runAsUser: 10001, bridgeAuthSecretName: 'agora-bridge-auth', bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET', bridgePort: 8765, ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090', relayHost: 'broker.agora-system.svc.cluster.local', relayPort: 8444, relayCaConfigMapName: 'agora-onecli-ca' }
    const harnesses = [{ harnessId: 'claude-code', imageDigest: `sha256:${'a'.repeat(64)}`, launchCommand: ['/entry'], mounts: [], harnessHome: '/home/agent', workspaceRoot: '/home/agent/work' }]
    const server = createOwnerApi({ k8s, obligations: fakeObligations(), seams: new Map(), gate, harnesses, settings, wakes: new WakeLog(), bridgeAuthSecret: 'test-secret' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await postOwnerRequest(port, request({ workstreamId }))
      const name = `agora-${workstreamId.slice(0, 8)}-inc-1`
      const created = (await k8s.getPod(name))!
      // The Pod the Kubernetes API would report: running, carrying its incarnation label.
      k8s.setPodStatus(name, { phase: 'Running' })

      const renewed = await fetch(`http://127.0.0.1:${String(port)}/v1/workstreams/${workstreamId}/incarnations/inc-1/bridge-token`, { method: 'POST' })
      assert.equal(renewed.status, 200)
      const token = ((await renewed.json()) as { bridgeToken: string }).bridgeToken
      assert.deepEqual(verifyBridgeToken(token, 'inc-1', 'test-secret').ok, true, 'the renewed token is valid for this incarnation')
      assert.ok(bridgeTokenExpiry(token)! > Math.floor(Date.now() / 1000), 'and it is not born expired — which is the whole point')
      assert.deepEqual(verifyBridgeToken(token, 'inc-2', 'test-secret'), { ok: false, reason: 'wrong_incarnation' }, 'it names one incarnation and no other')
      void created

      // The renewal is a claim about the world, not a favour: no Pod, no token.
      const gone = await fetch(`http://127.0.0.1:${String(port)}/v1/workstreams/${workstreamId}/incarnations/inc-9/bridge-token`, { method: 'POST' })
      assert.equal(gone.status, 404)
    } finally {
      server.close()
    }
  })
})

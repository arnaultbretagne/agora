import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { principalId, workstreamId as toWorkstreamId } from '@agora/domain'
import { createWorkstreamWithFirstSession } from '@agora/store-pg'
import { BridgeCredentialIssuer } from '../src/bridge-credentials.js'
import { FAKE_NATIVE_FORMAT_ID, startFakeAgentServer } from '../src/fake-agent-server.js'
import { serviceAccountName } from '../src/labels.js'
import { fakeRelayBundle } from '../src/relay-bundle.js'
import { CustodyStreamIssuer } from '../src/restore-credentials.js'
import { createServer } from '../src/server.js'
import { FakeBrokerActivationClient } from './support/fake-broker-activation-client.js'
import { FakeK8s } from './support/fake-k8s.js'
import { openTestDatabase, type TestDatabaseHandle } from './support.js'

let baseUrl: string
let k8s: FakeK8s
let bridgeIssuer: BridgeCredentialIssuer
let restoreIssuer: CustodyStreamIssuer
let brokerActivationClient: FakeBrokerActivationClient
let db: TestDatabaseHandle
let server: ReturnType<typeof createServer>

async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo
      probe.close((err) => (err ? reject(err) : resolve(port)))
    })
    probe.on('error', reject)
  })
}

before(async () => {
  db = await openTestDatabase()
  k8s = new FakeK8s()
  bridgeIssuer = new BridgeCredentialIssuer()
  restoreIssuer = new CustodyStreamIssuer()
  brokerActivationClient = new FakeBrokerActivationClient()
  // Self-referential: this same server serves both the controller API and the restore stream a
  // Pod pulls from — the port is only known once reserved, unlike production's fixed listen port.
  const port = await reserveFreePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = createServer({
    k8s,
    definitions: [FAKE_AGENT_DEFINITION],
    registryRevision: 'rev-test',
    bridgeIssuer,
    controllerRevision: 'controller-rev-1',
    custodyPool: db.pool,
    restoreIssuer,
    custodyControllerBaseUrl: baseUrl,
    relayBundle: fakeRelayBundle(),
    brokerActivationClient,
  })
  await new Promise<void>((resolve) => server.listen(port, resolve))
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  await db.close()
})

function materializeBody(overrides: Record<string, unknown> = {}) {
  return {
    agentId: FAKE_AGENT_DEFINITION.agentId,
    runtimeDefinitionVersion: FAKE_AGENT_DEFINITION.version,
    workspaceMountRef: 'pvc-workspace-1',
    executionGrantRef: 'grant-ref-opaque',
    ...overrides,
  }
}

test('GET /v1/agents lists the fake Agent as enabled', async () => {
  const res = await fetch(`${baseUrl}/v1/agents`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { registryRevision: string; items: { agentId: string; availability: string }[] }
  assert.equal(body.registryRevision, 'rev-test')
  assert.ok(body.items.some((i) => i.agentId === FAKE_AGENT_DEFINITION.agentId && i.availability === 'enabled'))
})

test('required: arbitrary image/command/env fields on a materialize request are schema-rejected', async () => {
  const sessionId = randomUUID()
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody({ image: 'evil/image:latest', command: ['sh', '-c', 'whoami'], env: { FOO: 'bar' } })),
  })
  assert.equal(res.status, 400)
  assert.equal(k8s.pods.size, 0)
})

test('PUT without X-Request-Id is rejected before touching Kubernetes', async () => {
  const sessionId = randomUUID()
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(materializeBody()),
  })
  assert.equal(res.status, 400)
  assert.equal(k8s.pods.size, 0)
})

test('PUT for an unknown agentId/version is a 409, not a Pod creation', async () => {
  const sessionId = randomUUID()
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody({ agentId: 'no-such-agent' })),
  })
  assert.equal(res.status, 409)
  assert.equal(k8s.pods.size, 0)
})

test('full lifecycle: materialize -> get -> ready -> open ACP connection -> dematerialize -> get 404', async () => {
  const sessionId = randomUUID()

  const put = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody()),
  })
  assert.equal(put.status, 202)
  const provisioning = (await put.json()) as { state: string; agentId: string; sessionId: string }
  assert.equal(provisioning.state, 'provisioning')
  assert.equal(provisioning.agentId, FAKE_AGENT_DEFINITION.agentId)
  assert.equal(provisioning.sessionId, sessionId)

  // Simulate the kubelet reporting readiness with a Pod IP, the way a real cluster would.
  const [pod] = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  assert.ok(pod?.metadata?.name)
  k8s.seedPod({
    ...pod,
    status: { phase: 'Running', podIP: '10.0.0.5', conditions: [{ type: 'Ready', status: 'True' }] },
  })

  const get = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`)
  assert.equal(get.status, 200)
  const ready = (await get.json()) as { state: string }
  assert.equal(ready.state, 'ready')

  const connect = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/acp-connections`, {
    method: 'POST',
    headers: { 'x-request-id': randomUUID() },
  })
  assert.equal(connect.status, 201)
  const endpoint = (await connect.json()) as { transport: string; url: string; credential: string; expiresAt: string }
  assert.equal(endpoint.transport, FAKE_AGENT_DEFINITION.bridge.transport)
  assert.ok(endpoint.url.includes('10.0.0.5'))
  assert.equal(bridgeIssuer.verify(sessionId, endpoint.credential), true)

  const del = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'DELETE',
    headers: { 'x-request-id': randomUUID() },
  })
  assert.equal(del.status, 202)
  assert.equal(k8s.pods.size, 0)
  // required: "Revoke bridge/grant during dematerialization".
  assert.equal(bridgeIssuer.verify(sessionId, endpoint.credential), false)

  const getAfterDelete = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`)
  assert.equal(getAfterDelete.status, 404)
})

test('required: materialize binds grant + session_id + agent_id + workload_identity via the Broker before any Pod exists', async () => {
  const sessionId = randomUUID()
  const requestId = randomUUID()
  brokerActivationClient.calls.length = 0
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify(materializeBody({ executionGrantRef: 'grant-ref-bind-test' })),
  })
  assert.equal(res.status, 202)
  assert.equal(brokerActivationClient.calls.length, 1)
  const call = brokerActivationClient.calls[0]
  assert.equal(call?.grantRef, 'grant-ref-bind-test')
  assert.equal(call?.sessionId, sessionId)
  assert.equal(call?.agentId, FAKE_AGENT_DEFINITION.agentId)
  assert.equal(call?.workloadIdentity, serviceAccountName(sessionId))
  assert.equal(call?.requestId, requestId)
})

test('required: Broker denial of grant activation prevents Pod creation (fail closed)', async () => {
  const sessionId = randomUUID()
  brokerActivationClient.denyWithStatus = 403
  try {
    const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: JSON.stringify(materializeBody()),
    })
    assert.equal(res.status, 403)
    const pods = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
    assert.equal(pods.length, 0, 'a grant the Broker refuses to activate must never produce a Pod')
  } finally {
    brokerActivationClient.denyWithStatus = undefined
  }
})

test('required: DELETE for a non-materialized Session Runtime succeeds (204)', async () => {
  const res = await fetch(`${baseUrl}/v1/sessions/${randomUUID()}/runtime`, {
    method: 'DELETE',
    headers: { 'x-request-id': randomUUID() },
  })
  assert.equal(res.status, 204)
})

test('opening an ACP connection before the Session Runtime is ready is a 409', async () => {
  const sessionId = randomUUID()
  await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody()),
  })
  const connect = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/acp-connections`, {
    method: 'POST',
    headers: { 'x-request-id': randomUUID() },
  })
  assert.equal(connect.status, 409)
})

/**
 * `custody.snapshots.session_id` FK-references `product.sessions(id)` — real in production (a
 * Session always exists in product before the controller is ever asked to capture it), so capture
 * tests need a real product.sessions row too, even though the controller itself never writes to
 * that schema (only `agora_custody_runtime`'s own narrow grant, checked elsewhere).
 */
async function seedProductSession(sessionId: string): Promise<void> {
  const client = await db.pool.connect()
  try {
    await createWorkstreamWithFirstSession(client, {
      workstream: { id: toWorkstreamId(randomUUID()), category: 'discussion', title: 'custody test', owner: principalId('alice'), createdAt: new Date() },
      session: {
        id: sessionId as never,
        ordinal: 1,
        launchEnvelope: {
          agentId: FAKE_AGENT_DEFINITION.agentId,
          workspaceSpec: { root: '/work' },
          equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
          runtimeDefinitionVersion: FAKE_AGENT_DEFINITION.version,
        },
      },
      runtimeDefinitionVersion: FAKE_AGENT_DEFINITION.version,
    })
  } finally {
    client.release()
  }
}

async function materializeAndSeedReady(sessionId: string, podIp: string) {
  await seedProductSession(sessionId)
  await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody()),
  })
  const [pod] = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  assert.ok(pod?.metadata?.name)
  k8s.seedPod({ ...pod, status: { phase: 'Running', podIP: podIp, conditions: [{ type: 'Ready', status: 'True' }] } })
}

function requiredPodEnv(pod: import('../src/k8s-client.js').K8sObject | undefined): Record<string, string> {
  const container = (pod?.spec as { containers?: { env?: { name: string; value: string }[] }[] } | undefined)?.containers?.[0]
  return Object.fromEntries((container?.env ?? []).map((e) => [e.name, e.value]))
}

function requireEnvValue(env: Record<string, string>, name: string): string {
  const value = env[name]
  assert.ok(value, `expected Pod env to carry ${name}`)
  return value
}

interface CustodySnapshotRefBody {
  readonly snapshotId: string
  readonly generation: number
  readonly formatId: string
  readonly sha256: string
  readonly syncedThroughSeq: number
}

test('required: capture streams real bytes from the fake Agent Pod, commits an immutable snapshot, and a same-request-id retry never allocates a second generation', async () => {
  const sessionId = randomUUID()
  const fakeAgent = await startFakeAgentServer({ port: FAKE_AGENT_DEFINITION.bridge.listenPort })
  try {
    await materializeAndSeedReady(sessionId, '127.0.0.1')

    const requestId = randomUUID()
    const capture1 = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      body: JSON.stringify({ syncedThroughSeq: 5 }),
    })
    const capture1Body = (await capture1.json()) as CustodySnapshotRefBody
    assert.equal(capture1.status, 201, JSON.stringify(capture1Body))
    const ref1 = capture1Body
    assert.equal(ref1.generation, 1)
    assert.equal(ref1.formatId, FAKE_NATIVE_FORMAT_ID)
    assert.equal(ref1.syncedThroughSeq, 5)

    // required: "capture retry cannot allocate two generations for one request id".
    const capture2 = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      body: JSON.stringify({ syncedThroughSeq: 5 }),
    })
    assert.equal(capture2.status, 201)
    const ref2 = (await capture2.json()) as CustodySnapshotRefBody
    assert.equal(ref2.snapshotId, ref1.snapshotId)
    assert.equal(ref2.generation, 1)

    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM custody.snapshots WHERE session_id = $1', [sessionId])
    assert.equal(rows[0].n, 1)

    // A DIFFERENT request id is a genuinely new capture: generation advances.
    const capture3 = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: JSON.stringify({ syncedThroughSeq: 7 }),
    })
    const ref3 = (await capture3.json()) as CustodySnapshotRefBody
    assert.equal(ref3.generation, 2)
  } finally {
    await fakeAgent.close()
  }
})

test('required: capture failure (unreachable Pod) leaves the Pod alive and no snapshot row is written', async () => {
  const sessionId = randomUUID()
  // 127.0.0.1:1 — reserved, nothing listens there; the fetch fails fast.
  await materializeAndSeedReady(sessionId, '127.0.0.1')
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify({ syncedThroughSeq: 0 }),
  })
  assert.equal(res.status, 422)
  const [pod] = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  assert.ok(pod, 'Pod must still exist — capture failure must not touch it')
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM custody.snapshots WHERE session_id = $1', [sessionId])
  assert.equal(rows[0].n, 0)
})

test('required: restore-before-start — a Pod pulls its native state via a one-time credential and never a second time', async () => {
  const sessionId = randomUUID()
  const fakeAgent = await startFakeAgentServer({ port: FAKE_AGENT_DEFINITION.bridge.listenPort })
  let snapshotId: string
  try {
    await materializeAndSeedReady(sessionId, '127.0.0.1')
    const capture = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: JSON.stringify({ syncedThroughSeq: 3 }),
    })
    snapshotId = ((await capture.json()) as CustodySnapshotRefBody).snapshotId
  } finally {
    await fakeAgent.close()
  }

  // ADR 0005: Pod replacement, not a new Session — dematerialize the old Pod, then re-materialize
  // the SAME sessionId with `restoreFrom` (matching how `resumeSessionRuntime` actually drives it).
  await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, { method: 'DELETE', headers: { 'x-request-id': randomUUID() } })
  const materialize = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody({ restoreFrom: snapshotId })),
  })
  assert.equal(materialize.status, 202, await materialize.text())
  const [pod] = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  const env = requiredPodEnv(pod)
  const restoreUrl = requireEnvValue(env, 'AGORA_CUSTODY_RESTORE_URL')
  const restoreCredential = requireEnvValue(env, 'AGORA_CUSTODY_RESTORE_CREDENTIAL')
  assert.ok(restoreUrl.includes('/custody-restore-stream'))

  // The Pod side: pull for real, exactly as fake-agent-server.ts does at startup.
  const restoredAgent = await startFakeAgentServer({ restore: { url: restoreUrl, credential: restoreCredential } })
  try {
    const custodyRes = await fetch(`http://127.0.0.1:${restoredAgent.port}/custody`)
    assert.equal(custodyRes.status, 200)
  } finally {
    await restoredAgent.close()
  }

  // required: the restore stream is one-time — a second presentation of the SAME credential fails.
  await assert.rejects(() => startFakeAgentServer({ restore: { url: restoreUrl, credential: restoreCredential } }))
})

test('required: a corrupted checksum prevents restore (and therefore Pod readiness) with a typed reason', async () => {
  const sessionId = randomUUID()
  const fakeAgent = await startFakeAgentServer({ port: FAKE_AGENT_DEFINITION.bridge.listenPort })
  let snapshotId: string
  try {
    await materializeAndSeedReady(sessionId, '127.0.0.1')
    const capture = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: JSON.stringify({ syncedThroughSeq: 1 }),
    })
    snapshotId = ((await capture.json()) as CustodySnapshotRefBody).snapshotId
  } finally {
    await fakeAgent.close()
  }

  await db.pool.query('UPDATE custody.snapshots SET payload_sha256 = $2 WHERE id = $1', [snapshotId, Buffer.alloc(32, 0xff)])

  await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, { method: 'DELETE', headers: { 'x-request-id': randomUUID() } })
  const materialize = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody({ restoreFrom: snapshotId })),
  })
  const [pod] = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  const env = requiredPodEnv(pod)
  assert.equal(materialize.status, 202)

  await assert.rejects(() =>
    startFakeAgentServer({
      restore: { url: requireEnvValue(env, 'AGORA_CUSTODY_RESTORE_URL'), credential: requireEnvValue(env, 'AGORA_CUSTODY_RESTORE_CREDENTIAL') },
    }),
  )
})

test('required: restoreFrom naming an unknown/foreign snapshot never creates a Pod', async () => {
  const sessionId = randomUUID()
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody({ restoreFrom: randomUUID() })),
  })
  assert.equal(res.status, 409)
  const pods = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  assert.equal(pods.length, 0)
})

test('required: a format the fake Agent does not read is rejected before a Pod is ever created', async () => {
  const sessionId = randomUUID()
  await seedProductSession(sessionId)
  const foreignSnapshotId = randomUUID()
  await db.pool.query(
    `INSERT INTO custody.snapshots
       (id, session_id, generation, capture_request_id, format_id, format_version, adapter_version,
        synced_through_seq, payload, payload_sha256, size_bytes, created_at)
     VALUES ($1,$2,1,$3,'some-other-agents-native-format','9','1',0,$4,$5,3,$6)`,
    [foreignSnapshotId, sessionId, randomUUID(), Buffer.from('abc'), Buffer.alloc(32, 1), new Date()],
  )
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify(materializeBody({ restoreFrom: foreignSnapshotId })),
  })
  // docs/specs/07 "Restore contract" step 3: format/adapter compatibility is validated by the
  // CONTROLLER, against the registry's own declared `readFormats` — before any Pod exists.
  assert.equal(res.status, 422, await res.text())
  const pods = await k8s.listPods(`agora.dev/session-id=${sessionId}`)
  assert.equal(pods.length, 0, 'an incompatible format must never reach Pod creation')
})

test('required: captured bytes never contain the execution grant reference or Broker relay endpoint — only the driver\'s own opaque native state', async () => {
  const sessionId = randomUUID()
  const fakeAgent = await startFakeAgentServer({ port: FAKE_AGENT_DEFINITION.bridge.listenPort })
  try {
    await materializeAndSeedReady(sessionId, '127.0.0.1')
    const capture = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: JSON.stringify({ syncedThroughSeq: 0 }),
    })
    const ref = (await capture.json()) as CustodySnapshotRefBody
    const { rows } = await db.pool.query<{ payload: Buffer }>('SELECT payload FROM custody.snapshots WHERE id = $1', [ref.snapshotId])
    const payloadText = rows[0]?.payload.toString('utf8') ?? ''
    assert.doesNotMatch(payloadText, /grant-ref-opaque/, 'the execution grant reference must never reach the captured payload')
    assert.doesNotMatch(payloadText, /broker-relay\.agent\.svc/, 'the Broker relay endpoint must never reach the captured payload')
    assert.doesNotMatch(payloadText, /onecli/i, 'OneCLI CA/stub material must never reach the captured payload')
  } finally {
    await fakeAgent.close()
  }
})

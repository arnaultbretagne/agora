import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { BridgeCredentialIssuer } from '../src/bridge-credentials.js'
import { createServer } from '../src/server.js'
import { FakeK8s } from './support/fake-k8s.js'

let baseUrl: string
let k8s: FakeK8s
let bridgeIssuer: BridgeCredentialIssuer
let server: ReturnType<typeof createServer>

before(async () => {
  k8s = new FakeK8s()
  bridgeIssuer = new BridgeCredentialIssuer()
  server = createServer({
    k8s,
    definitions: [FAKE_AGENT_DEFINITION],
    registryRevision: 'rev-test',
    bridgeIssuer,
    controllerRevision: 'controller-rev-1',
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
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

test('custody-snapshots is not implemented in this plan (P06 owns capture) and is not faked as success', async () => {
  const sessionId = randomUUID()
  const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/runtime/custody-snapshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
    body: JSON.stringify({ syncedThroughSeq: 0 }),
  })
  assert.equal(res.status, 404)
})

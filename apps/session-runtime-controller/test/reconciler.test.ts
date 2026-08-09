import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { LABEL_SESSION_ID } from '../src/labels.js'
import { fakeRelayBundle } from '../src/relay-bundle.js'
import { dematerializeSessionRuntime, materializeSessionRuntime, reconcileSessionRuntime } from '../src/reconciler.js'
import { FakeK8s } from './support/fake-k8s.js'

function input(sessionId: string, overrides: Partial<Parameters<typeof materializeSessionRuntime>[1]> = {}) {
  return {
    sessionId,
    definition: FAKE_AGENT_DEFINITION,
    executionGrantRef: 'super-secret-grant-reference-value',
    relayBundle: fakeRelayBundle(),
    controllerRevision: 'rev-1',
    ...overrides,
  }
}

test('GET on a never-materialized Session reports absent', async () => {
  const k8s = new FakeK8s()
  const status = await reconcileSessionRuntime(k8s, 'session-none')
  assert.equal(status.state, 'absent')
})

test('PUT on an absent Session materializes exactly one Pod and one ServiceAccount, 202 provisioning', async () => {
  const k8s = new FakeK8s()
  const result = await materializeSessionRuntime(k8s, input('session-1'))
  assert.equal(result.httpStatus, 202)
  assert.equal(result.status.state, 'provisioning')
  assert.equal(result.status.agentId, FAKE_AGENT_DEFINITION.agentId)
  assert.equal(result.status.runtimeDefinitionVersion, FAKE_AGENT_DEFINITION.version)
  assert.equal(k8s.pods.size, 1)
  assert.equal(k8s.serviceAccounts.size, 1)
})

test('an operator-configured imagePullSecretName is bound to the per-Session ServiceAccount, never the materialize request', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-pull-secret', { imagePullSecretName: 'ghcr-pull' }))
  const [sa] = [...k8s.serviceAccounts.values()]
  assert.deepEqual((sa as { imagePullSecrets?: unknown }).imagePullSecrets, [{ name: 'ghcr-pull' }])
})

test('PUT is idempotent: materializing an already-materialized Session returns 200 and creates nothing new', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-2'))
  const second = await materializeSessionRuntime(k8s, input('session-2'))
  assert.equal(second.httpStatus, 200)
  assert.equal(k8s.pods.size, 1)
  assert.equal(k8s.serviceAccounts.size, 1)
})

test('required: concurrent PUT for the same Session creates exactly one Pod', async () => {
  const k8s = new FakeK8s()
  const [a, b] = await Promise.all([
    materializeSessionRuntime(k8s, input('session-3')),
    materializeSessionRuntime(k8s, input('session-3')),
  ])
  assert.equal(k8s.pods.size, 1)
  assert.ok(a && b)
  assert.notEqual(a.status.state, 'absent')
  assert.notEqual(b.status.state, 'absent')
})

test('required: restart reconstructs the same Session Runtime state by session_id, from labels alone', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-4'))
  // No shared in-memory state exists between these two calls beyond the (real, cluster-owned) Pod —
  // this stands in for "a freshly restarted controller process observes the same session".
  const beforeRestart = await reconcileSessionRuntime(k8s, 'session-4')
  const afterRestart = await reconcileSessionRuntime(k8s, 'session-4')
  assert.deepEqual(afterRestart, beforeRestart)
})

test('a Pod with a Ready condition reports state ready with its podUid', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-5'))
  const [pod] = await k8s.listPods(`${LABEL_SESSION_ID}=session-5`)
  assert.ok(pod?.metadata?.name)
  k8s.seedPod({ ...pod, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } })
  const status = await reconcileSessionRuntime(k8s, 'session-5')
  assert.equal(status.state, 'ready')
  assert.equal(typeof status.podUid, 'string')
})

test('a Pod with metadata.deletionTimestamp reports state terminating', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-6'))
  const [pod] = await k8s.listPods(`${LABEL_SESSION_ID}=session-6`)
  assert.ok(pod?.metadata)
  k8s.seedPod({ ...pod, metadata: { ...pod.metadata, deletionTimestamp: '2026-01-01T00:00:00Z' } })
  const status = await reconcileSessionRuntime(k8s, 'session-6')
  assert.equal(status.state, 'terminating')
})

test('a Pod reporting phase Failed reports state failed', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-7'))
  const [pod] = await k8s.listPods(`${LABEL_SESSION_ID}=session-7`)
  assert.ok(pod)
  k8s.seedPod({ ...pod, status: { phase: 'Failed' } })
  const status = await reconcileSessionRuntime(k8s, 'session-7')
  assert.equal(status.state, 'failed')
})

test('required: duplicate Pods for one Session fail closed and reconcile to a single deterministic survivor', async () => {
  const k8s = new FakeK8s()
  const sessionId = 'session-8'
  const labels = { [LABEL_SESSION_ID]: sessionId }
  k8s.seedPod({
    metadata: { name: 'sr-session-8', labels, creationTimestamp: '2026-01-01T00:00:00.000Z' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  })
  k8s.seedPod({
    metadata: { name: 'sr-session-8-stale-duplicate', labels, creationTimestamp: '2026-01-02T00:00:00.000Z' },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  })
  const status = await reconcileSessionRuntime(k8s, sessionId)
  assert.equal(status.state, 'failed')
  assert.equal(status.failure?.code, 'duplicate_pod')
  // Deterministic survivor policy: the older Pod (by creationTimestamp) survives, the newer one is removed.
  assert.equal(k8s.pods.has('sr-session-8'), true)
  assert.equal(k8s.pods.has('sr-session-8-stale-duplicate'), false)
})

test('DELETE for a non-materialized Session Runtime succeeds with 204', async () => {
  const k8s = new FakeK8s()
  const result = await dematerializeSessionRuntime(k8s, 'session-never-existed')
  assert.equal(result.httpStatus, 204)
})

test('DELETE for a materialized Session Runtime removes the Pod and ServiceAccount, 202', async () => {
  const k8s = new FakeK8s()
  await materializeSessionRuntime(k8s, input('session-9'))
  const result = await dematerializeSessionRuntime(k8s, 'session-9')
  assert.equal(result.httpStatus, 202)
  assert.equal(k8s.pods.size, 0)
  assert.equal(k8s.serviceAccounts.size, 0)
  assert.equal((await reconcileSessionRuntime(k8s, 'session-9')).state, 'absent')
})

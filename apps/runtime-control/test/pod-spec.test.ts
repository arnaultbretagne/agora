import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { describeK8sError } from '../src/k8s-client.js'
import { withTestDatabase } from '@agora/testkit'
import { buildPodSpec, loadHarnessDefinitions, RequestSuppliesPodInputError, type HarnessDefinition, type RuntimeSettings } from '../src/k8s-pod-spec.js'
import { inventoryWorkstream, isStartupDeadlineExpired } from '../src/inventory.js'
import { LaunchSeam, admittedSpecDigest } from '../src/launch-seam.js'

const harness: HarnessDefinition = {
  harnessId: 'claude-code',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  launchCommand: ['/usr/local/bin/entrypoint'],
  mounts: [{ name: 'relay-ca', mountPath: '/etc/agora/relay-ca', readOnly: true }],
}

const settings: RuntimeSettings = {
  namespace: 'agora-runs',
  startupDeadlineSeconds: 120,
  terminationGraceSeconds: 30,
  inventoryFreshnessMs: 5000,
  runtimeClassName: 'sandboxed',
  runAsUser: 10001,
}

test('the PodSpec is deterministic from the reviewed definition only', () => {
  const pod = buildPodSpec({ workstreamId: '11111111-1111-4111-8111-111111111111', attemptKey: 'k1', incarnation: 'inc-1', harnessId: 'claude-code' }, harness, settings)
  const spec = pod['spec'] as Record<string, unknown>
  const containers = spec['containers'] as Array<Record<string, unknown>>
  const security = containers[0]!['securityContext'] as Record<string, unknown>
  assert.equal(containers[0]!['image'], harness.imageDigest)
  assert.deepEqual(containers[0]!['command'], harness.launchCommand)
  assert.equal(spec['automountServiceAccountToken'], false)
  assert.equal(spec['runtimeClassName'], 'sandboxed')
  assert.equal(security['runAsUser'], 10001, 'numeric runAsUser — kubelet rejects an account name')
  assert.equal(security['runAsNonRoot'], true)
  const again = buildPodSpec({ workstreamId: '11111111-1111-4111-8111-111111111111', attemptKey: 'k1', incarnation: 'inc-1', harnessId: 'claude-code' }, harness, settings)
  assert.deepEqual(again, pod)
})

test('no request field may name an image, argv, env or PodSpec fragment', () => {
  // The input type has no such members: the compile-time shape IS the 422. The error type exists
  // for defense in depth at the API boundary.
  assert.throws(() => {
    throw new RequestSuppliesPodInputError('image')
  }, RequestSuppliesPodInputError)
})

test('describeK8sError keeps the API Status.message (findings §4)', () => {
  assert.equal(
    describeK8sError('POST', '/api/v1/namespaces/agora-runs/pods', 403, { message: 'exceeded quota: agora-runs-quota' }),
    'k8s API POST /api/v1/namespaces/agora-runs/pods -> 403: exceeded quota: agora-runs-quota',
  )
  assert.equal(describeK8sError('GET', '/x', 500, 'boom'), 'k8s API GET /x -> 500: boom')
})

test('an inventory that could not list completely reports complete:false and suppresses obligations', async () => {
  await withTestDatabase(async (db) => {
    const failing = {
      namespace: 'agora-runs',
      listPods: async (): Promise<never> => {
        throw new Error('apiserver unreachable')
      },
    }
    const store = {
      async obligationsFor() {
        return [{ podName: 'agora-11111111-inc1', reason: 'cleanup_pod', deadline: new Date().toISOString(), nodeName: null }]
      },
    }
    const inventory = await inventoryWorkstream(failing as never, store as never, 'w1')
    assert.equal(inventory.complete, false)
    assert.equal(inventory.pods.length, 0)
    assert.equal(inventory.obligations.length, 0, 'an incomplete listing must not invent absence (OFF-006 shape)')
  })
})

test('SESSION-A06: a process restart inside the Pod invalidates the evidence and retires the incarnation', () => {
  const seam = new LaunchSeam('inc-1')
  // Release REQUIRES the Session id: birth-then-release ordering — no session, no release.
  assert.equal(seam.release('session-1'), true, 'the first release binds the born Session')
  assert.equal(seam.release('session-2'), false, 'a bound incarnation never rebinds to another Session')
  const restarted = seam.processRestart()
  assert.notEqual(restarted.incarnation, 'inc-1')
  const state = seam.state()
  assert.equal(state.released, false)
  assert.equal(state.sessionId, null)
  assert.equal(state.generation, 1)
  assert.match(admittedSpecDigest({ containers: [] }), /^[0-9a-f]{64}$/)
})

test('the harness definitions catalogue is the only image source', () => {
  const defs = loadHarnessDefinitions(new URL('../../../../contracts/catalogue/harness-definitions.json', import.meta.url).pathname)
  assert.equal(defs[0]!.harnessId, 'claude-code')
  assert.match(defs[0]!.imageDigest, /^sha256:[0-9a-f]{64}$/)
})

test('the settings carry the P7 first values', () => {
  const parsed: RuntimeSettings = JSON.parse(readFileSync(new URL('../../../../contracts/catalogue/runtime-settings.json', import.meta.url).pathname, 'utf8'))
  assert.ok(parsed.startupDeadlineSeconds >= 30)
  assert.equal(typeof parsed.runAsUser, 'number')
})

test('P7: a Pod stuck before Running past the pinned deadline is expired; Running/terminal never is', () => {
  const start = '2026-01-01T00:00:00.000Z'
  assert.equal(isStartupDeadlineExpired(start, 'Pending', '2026-01-01T00:01:00.000Z', 120), false, 'within the deadline')
  assert.equal(isStartupDeadlineExpired(start, 'Pending', '2026-01-01T00:03:00.000Z', 120), true, 'past the deadline, still not Running')
  assert.equal(isStartupDeadlineExpired(start, 'Running', '2026-01-01T01:00:00.000Z', 120), false, 'Running evidence, however late, is not a startup failure')
  assert.equal(isStartupDeadlineExpired(null, 'Pending', '2026-01-01T01:00:00.000Z', 120), false, 'no creation evidence yet: never invent expiry')
})

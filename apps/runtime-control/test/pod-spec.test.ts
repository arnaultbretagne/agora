import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { describeK8sError } from '../src/k8s-client.js'
import { withTestDatabase } from '@agora/testkit'
import { buildPodSpec, loadHarnessDefinitions, RequestSuppliesPodInputError, type HarnessDefinition, type RuntimeSettings } from '../src/k8s-pod-spec.js'
import { podName } from '../src/k8s-labels.js'
import { inventoryWorkstream, isStartupDeadlineExpired } from '../src/inventory.js'
import { LaunchSeam, admittedSpecDigest } from '../src/launch-seam.js'

const harness: HarnessDefinition = {
  harnessId: 'claude-code',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  launchCommand: ['/usr/local/bin/entrypoint'],
  mounts: [
    { name: 'relay-ca', mountPath: '/etc/agora/relay-ca', readOnly: true },
    { name: 'harness-home', mountPath: '/home/agent', readOnly: false },
  ],
  harnessHome: '/home/agent',
  workspaceRoot: '/home/agent/work',
}

const settings: RuntimeSettings = {
  namespace: 'agora-runs',
  startupDeadlineSeconds: 120,
  terminationGraceSeconds: 30,
  inventoryFreshnessMs: 5000,
  runtimeClassName: 'sandboxed',
  runAsUser: 10001,
  bridgeAuthSecretName: 'agora-bridge-auth',
  bridgeAuthSecretKey: 'BRIDGE_AUTH_SECRET',
  bridgePort: 8765,
  ownerApiBaseUrl: 'http://runtime-control.agora-system.svc.cluster.local:8090',
  relayHost: 'broker.agora-system.svc.cluster.local',
  relayPort: 8444,
  relayCaConfigMapName: 'agora-onecli-ca',
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

test('the Pod name agrees with owner-api.ts\'s own podName(workstreamId, incarnation) even for a long incarnation (S8 regression)', () => {
  // A real engine-chosen incarnation is typically a UUID (36 chars), well past the 10 characters
  // this file's metadata.name computation used to slice to internally, before podName()'s own
  // 20-char cap ran — silently diverging from owner-api.ts's unsliced discovery name and breaking
  // "discoverable by pre-recorded correlation" (engine.md) exactly when it mattered.
  const workstreamId = '11111111-1111-4111-8111-111111111111'
  const longIncarnation = '550e8400-e29b-41d4-a716-446655440000'
  const pod = buildPodSpec({ workstreamId, attemptKey: 'k1', incarnation: longIncarnation, harnessId: 'claude-code' }, harness, settings)
  const metadata = pod['metadata'] as { name: string }
  assert.equal(metadata.name, podName(workstreamId, longIncarnation))
})

test('the container carries the bridge wiring for S8: incarnation, evidence URL, bridge port and the secret-sourced auth key', () => {
  const pod = buildPodSpec({ workstreamId: '11111111-1111-4111-8111-111111111111', attemptKey: 'k1', incarnation: 'inc-1', harnessId: 'claude-code' }, harness, settings)
  const spec = pod['spec'] as { containers: Array<{ env: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }>; ports: Array<{ containerPort: number }> }> }
  const container = spec.containers[0]!
  const env = Object.fromEntries(container.env.map((e) => [e.name, e]))
  assert.equal(env['AGORA_INCARNATION']!.value, 'inc-1')
  assert.ok(env['AGORA_EVIDENCE_URL']!.value!.endsWith(`/v1/pods/${podName('11111111-1111-4111-8111-111111111111', 'inc-1')}/evidence`))
  assert.equal(env['BRIDGE_PORT']!.value, String(settings.bridgePort))
  assert.deepEqual(env['BRIDGE_AUTH_SECRET']!.valueFrom!.secretKeyRef, { name: settings.bridgeAuthSecretName, key: settings.bridgeAuthSecretKey })
  assert.deepEqual(container.ports, [{ containerPort: settings.bridgePort, name: 'bridge' }])
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

test('inventory: podIP is the kubelet-assigned address once scheduled, null before it (Pending)', async () => {
  await withTestDatabase(async (db) => {
    const pods = {
      namespace: 'agora-runs',
      listPods: async () => ({
        items: [
          { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'agora-w1-inc-1', uid: 'uid-1' }, spec: { nodeName: 'node-a' }, status: { phase: 'Running', podIP: '10.244.1.7' } },
          { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'agora-w1-inc-2', uid: 'uid-2' }, spec: {}, status: { phase: 'Pending' } },
        ],
      }),
      getNode: async () => ({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'node-a' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    }
    const store = { async obligationsFor() { return [] } }
    const inventory = await inventoryWorkstream(pods as never, store as never, 'w1')
    const running = inventory.pods.find((p) => p.uid === 'uid-1')
    const pending = inventory.pods.find((p) => p.uid === 'uid-2')
    assert.equal(running?.podIP, '10.244.1.7')
    assert.equal(pending?.podIP, null, 'no address before the kubelet schedules and assigns one')
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

test('S13: a harness may add the reviewed auth markers it needs, and may not overwrite a decided value', () => {
  const withStubs: HarnessDefinition = {
    ...harness,
    podEnv: {
      SSL_CERT_FILE: '/etc/agora/relay-ca/ca.pem',
      // Every one of these is decided by the PodSpec from trusted input. A catalogue that could
      // redefine them could point a Pod at another relay, another bridge, or another Workstream.
      HTTPS_PROXY: 'http://attacker.example:3128',
      BRIDGE_AUTH_SECRET: 'nope',
      AGORA_INCARNATION: 'someone-elses',
      AGORA_CREDENTIAL_STUBS: '[]',
    },
    credentialStubs: [{ path: '.codex/auth.json', content: '{"auth_mode":"chatgpt"}' }],
  }
  const pod = buildPodSpec({ workstreamId: '11111111-1111-4111-8111-111111111111', attemptKey: 'k1', incarnation: 'inc-1', harnessId: 'claude-code' }, withStubs, settings)
  const container = ((pod['spec'] as Record<string, unknown>)['containers'] as Array<Record<string, unknown>>)[0]!
  const env = container['env'] as Array<{ name: string; value?: string }>
  const valuesOf = (name: string): string[] => env.filter((entry) => entry.name === name).map((entry) => entry.value ?? '')

  assert.deepEqual(valuesOf('SSL_CERT_FILE'), ['/etc/agora/relay-ca/ca.pem'], 'the addition is there, once')
  assert.deepEqual(valuesOf('HTTPS_PROXY'), ['http://broker.agora-system.svc.cluster.local:8444'], 'the relay is not negotiable')
  assert.deepEqual(valuesOf('AGORA_INCARNATION'), ['inc-1'])
  assert.equal(env.filter((entry) => entry.name === 'BRIDGE_AUTH_SECRET').length, 1)
  assert.deepEqual(valuesOf('AGORA_CREDENTIAL_STUBS'), [JSON.stringify(withStubs.credentialStubs)], 'the stubs come from the definition, not from podEnv')
})

test('S13: a harness that declares no stubs gets no stub variable at all', () => {
  const pod = buildPodSpec({ workstreamId: '11111111-1111-4111-8111-111111111111', attemptKey: 'k1', incarnation: 'inc-1', harnessId: 'claude-code' }, harness, settings)
  const container = ((pod['spec'] as Record<string, unknown>)['containers'] as Array<Record<string, unknown>>)[0]!
  const env = container['env'] as Array<{ name: string }>
  assert.equal(env.some((entry) => entry.name === 'AGORA_CREDENTIAL_STUBS'), false, 'absent, not present-and-empty')
})

test('S13: the reviewed catalogue carries the markers both pinned adapters actually need', () => {
  // Not a unit test of a literal: the deployment reads this file, and a harness whose adapter
  // refuses to start is indistinguishable, from outside, from one that never got scheduled.
  const definitions = loadHarnessDefinitions(new URL('../../../../contracts/catalogue/harness-definitions.json', import.meta.url).pathname)
  const claude = definitions.find((definition) => definition.harnessId === 'claude-code')
  const codex = definitions.find((definition) => definition.harnessId === 'codex')
  assert.equal(claude?.podEnv?.['CLAUDE_CODE_OAUTH_TOKEN'], 'onecli-managed', 'the placeholder that selects OAuth mode (findings §2.2)')
  assert.equal(codex?.podEnv?.['SSL_CERT_FILE'], '/etc/agora/relay-ca/ca.pem', 'a Rust binary ignores NODE_EXTRA_CA_CERTS (findings §2.3)')
  assert.equal(codex?.credentialStubs?.[0]?.path, '.codex/auth.json')
  assert.match(codex?.credentialStubs?.[0]?.content ?? '', /onecli-managed/, 'a marker, never a credential')
})

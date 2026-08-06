import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FAKE_AGENT_DEFINITION } from '@agora/agent-registry'
import { buildPodSpec } from '../src/pod-spec.js'
import { fakeRelayBundle } from '../src/relay-bundle.js'
import { LABEL_AGENT_ID, LABEL_EXECUTION_GRANT_ID, LABEL_SESSION_ID } from '../src/labels.js'

function pod(overrides: Partial<Parameters<typeof buildPodSpec>[0]> = {}) {
  return buildPodSpec({
    sessionId: '11111111-1111-1111-1111-111111111111',
    definition: FAKE_AGENT_DEFINITION,
    workspaceMountRef: 'pvc-workspace-1',
    executionGrantRef: 'super-secret-grant-reference-value',
    relayBundle: fakeRelayBundle(),
    controllerRevision: 'rev-1',
    ...overrides,
  })
}

test('the PodSpec builder only ever accepts trusted inputs — no arbitrary image/command/env exists as a parameter', () => {
  // Structural proof, not a runtime assertion: buildPodSpec's signature has no image/command/env
  // parameter at all — the compiler itself is the guard the "schema-rejected" required test needs
  // at the HTTP layer (server.test.ts); this proves the builder cannot be made to embed them even
  // if a caller tried, because there is nowhere to pass them.
  const spec = pod() as any
  assert.equal(spec.spec.containers[0].image, FAKE_AGENT_DEFINITION.imageDigest)
  assert.deepEqual(spec.spec.containers[0].command, FAKE_AGENT_DEFINITION.acpCommand)
})

test('required: Pod has no Kubernetes API token and uses the required security context', () => {
  const spec = pod({ runtimeClassName: 'sandboxed' }) as any
  assert.equal(spec.spec.automountServiceAccountToken, false)
  assert.equal(spec.spec.securityContext.runAsNonRoot, true)
  assert.equal(typeof spec.spec.securityContext.runAsUser, 'number')
  assert.equal(spec.spec.securityContext.seccompProfile.type, 'RuntimeDefault')
  assert.equal(spec.spec.runtimeClassName, 'sandboxed')
  const container = spec.spec.containers[0]
  assert.equal(container.securityContext.allowPrivilegeEscalation, false)
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL'])
  assert.equal(container.securityContext.runAsNonRoot, true)
})

test('required: Pod environment/files contain no OneCLI organization key, upstream aoc_ bearer or provider credential', () => {
  const spec = pod()
  const serialized = JSON.stringify(spec)
  assert.equal(/aoc_[A-Za-z0-9_-]{8,}/.test(serialized), false)
  assert.equal(serialized.includes('super-secret-grant-reference-value'), false, 'the raw execution grant ref must never appear')
  assert.equal(serialized.toLowerCase().includes('onecli-control'), false)
  assert.equal(serialized.toLowerCase().includes('upstream-bearer'), false)
})

test('the onecli-stubs volume projects from a Secret, not a ConfigMap — a stub can carry real account-identifying content (e.g. Codex\'s id_token)', () => {
  const spec = pod() as any
  const volumes = spec.spec.volumes as any[]
  const stubsVolume = volumes.find((v) => v.name === 'onecli-stubs')
  assert.ok(stubsVolume, 'onecli-stubs volume must exist')
  const source = stubsVolume.projected.sources[0]
  assert.ok(source.secret, 'must project from a secret source')
  assert.equal(source.secret.name, 'agora-onecli-stubs')
  assert.equal(source.configMap, undefined)
})

test('the onecli-ca volume still projects from a ConfigMap — a public trust cert has no confidentiality need', () => {
  const spec = pod() as any
  const volumes = spec.spec.volumes as any[]
  const caVolume = volumes.find((v) => v.name === 'onecli-ca')
  assert.ok(caVolume, 'onecli-ca volume must exist')
  assert.equal(caVolume.configMap.name, 'agora-onecli-ca')
})

test('required labels are present, and the execution grant label is a non-reversible hash, never the raw ref', () => {
  const spec = pod() as any
  const labels = spec.metadata.labels
  assert.equal(labels[LABEL_SESSION_ID], '11111111-1111-1111-1111-111111111111')
  assert.equal(labels[LABEL_AGENT_ID], FAKE_AGENT_DEFINITION.agentId)
  assert.match(labels[LABEL_EXECUTION_GRANT_ID], /^[a-f0-9]{32}$/)
  assert.notEqual(labels[LABEL_EXECUTION_GRANT_ID], 'super-secret-grant-reference-value')
})

test('the same materialize input always builds the identical PodSpec (deterministic)', () => {
  assert.deepEqual(pod(), pod())
})

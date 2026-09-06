import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideConnect, type ConnectContext } from '../src/relay/decision.js'

const egressHosts = { hostsFor: (provider: string) => (provider === 'github-app' ? ['api.github.com'] : []) }

function ctx(overrides: Partial<ConnectContext> = {}): ConnectContext {
  return {
    identity: { workstreamId: 'w1', incarnation: 'inc-1' },
    agentId: 'agent-1',
    effective: [{ kind: 'secret', status: 'usable', host: 'api.anthropic.com' }],
    bearerAvailable: true,
    targetHost: 'api.anthropic.com',
    egressHosts,
    ...overrides,
  }
}

test('an unresolved source IP (no matching Pod) is denied — never assumed local traffic', () => {
  assert.deepEqual(decideConnect(ctx({ identity: undefined })), { allow: false, reason: 'unresolved_identity' })
})

test('a Pod with no bound Agent yet is denied', () => {
  assert.deepEqual(decideConnect(ctx({ agentId: undefined })), { allow: false, reason: 'unbound_agent' })
})

test('a failed effective-credentials read is denied — never treated as unrestricted', () => {
  assert.deepEqual(decideConnect(ctx({ effective: undefined })), { allow: false, reason: 'host_not_reachable' })
})

test('a host no usable credential projects to is denied', () => {
  assert.deepEqual(decideConnect(ctx({ targetHost: 'evil.example.com' })), { allow: false, reason: 'host_not_reachable' })
})

test('the exact projected host is allowed', () => {
  assert.deepEqual(decideConnect(ctx()), { allow: true })
})

test('a connection\'s reviewed host is allowed', () => {
  assert.deepEqual(decideConnect(ctx({ effective: [{ kind: 'connection', status: 'usable', provider: 'github-app' }], targetHost: 'api.github.com' })), { allow: true })
})

test('an allowed host with no private-store bearer is denied — never opened without the authenticated hop ready', () => {
  assert.deepEqual(decideConnect(ctx({ bearerAvailable: false })), { allow: false, reason: 'credential_unavailable' })
})

test('a blocked credential\'s host is denied even if another usable credential exists', () => {
  const effective = [
    { kind: 'secret' as const, status: 'blocked', host: 'api.anthropic.com' },
    { kind: 'secret' as const, status: 'usable', host: 'api.openai.com' },
  ]
  assert.deepEqual(decideConnect(ctx({ effective, targetHost: 'api.anthropic.com' })), { allow: false, reason: 'host_not_reachable' })
  assert.deepEqual(decideConnect(ctx({ effective, targetHost: 'api.openai.com' })), { allow: true })
})

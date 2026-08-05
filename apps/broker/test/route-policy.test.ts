import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CapabilityFact } from '@agora/equipment-policy'
import type { ActiveGrantSummary } from '../src/grants-repository.js'
import { compileRoutePolicy, RoutePolicyError, ROUTE_SET_VERSION } from '../src/route-policy.js'

function fact(capabilityId: string): CapabilityFact {
  return { capabilityId, accessLevel: 'read', constraints: {} }
}

function grant(overrides: Partial<ActiveGrantSummary> = {}): ActiveGrantSummary {
  return {
    id: 'grant-1',
    agentId: 'fake-agent',
    onecliIdentifier: 'onecli-1',
    capabilities: [fact('vault')],
    ...overrides,
  }
}

test('an idle Broker with no active grants compiles to the terminal block alone', () => {
  const policy = compileRoutePolicy([])
  assert.equal(policy.routeSetVersion, ROUTE_SET_VERSION)
  assert.deepEqual(policy.routes, [{ action: 'block', host: '*' }])
})

test('a pinned Agent route set is included, and vault (no external route) contributes nothing beyond it', () => {
  const policy = compileRoutePolicy([grant()])
  assert.deepEqual(policy.routes, [
    { action: 'allow', host: 'fake-agent.internal.test' },
    { action: 'block', host: '*' },
  ])
})

test('capability-derived hosts are appended after every pinned host, terminal block always last', () => {
  const policy = compileRoutePolicy([grant({ capabilities: [fact('github')] })])
  assert.deepEqual(policy.routes, [
    { action: 'allow', host: 'fake-agent.internal.test' },
    { action: 'allow', host: 'api.github.com' },
    { action: 'block', host: '*' },
  ])
})

test('a host already covered by a pinned route is never duplicated as a capability route', () => {
  const policy = compileRoutePolicy([
    grant({ agentId: 'fake-agent-b', capabilities: [fact('github')] }),
    grant({ agentId: 'fake-agent-b', id: 'grant-2', capabilities: [] }),
  ])
  const hosts = policy.routes.map((r) => r.host)
  assert.deepEqual(hosts, ['fake-agent.internal.test', 'api.github.com', '*'])
  assert.equal(hosts.filter((h) => h === 'fake-agent.internal.test').length, 1)
})

test('output is deterministic — the same set of active grants compiles identically regardless of input order', () => {
  const a = grant({ id: 'a', agentId: 'claude-code', capabilities: [fact('github')] })
  const b = grant({ id: 'b', agentId: 'codex', capabilities: [fact('vault')] })
  const forward = compileRoutePolicy([a, b])
  const backward = compileRoutePolicy([b, a])
  assert.deepEqual(forward, backward)
})

test('hosts within each tier are sorted, not issue-ordered', () => {
  const policy = compileRoutePolicy([grant({ agentId: 'codex' })])
  const pinnedHosts = policy.routes.filter((r) => r.action === 'allow').map((r) => r.host)
  assert.deepEqual(pinnedHosts, [...pinnedHosts].sort())
})

test('an unreviewed Agent identity refuses to compile rather than silently omitting its routes', () => {
  assert.throws(
    () => compileRoutePolicy([grant({ agentId: 'unknown-agent' })]),
    (error: unknown) => error instanceof RoutePolicyError && error.code === 'unknown_pinned_agent',
  )
})

test('an unreviewed capability id refuses to compile rather than silently granting or omitting a route', () => {
  assert.throws(
    () => compileRoutePolicy([grant({ capabilities: [fact('unknown-capability')] })]),
    (error: unknown) => error instanceof RoutePolicyError && error.code === 'unknown_capability_host_mapping',
  )
})

test('the terminal block is always present and always last, even with many allow rules', () => {
  const policy = compileRoutePolicy([
    grant({ agentId: 'claude-code', capabilities: [fact('github')] }),
    grant({ id: 'grant-2', agentId: 'codex', capabilities: [fact('vault')] }),
  ])
  const last = policy.routes[policy.routes.length - 1]
  assert.deepEqual(last, { action: 'block', host: '*' })
  assert.equal(policy.routes.filter((r) => r.host === '*').length, 1)
})

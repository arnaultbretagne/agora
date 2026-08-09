import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CapabilityFact } from '@agora/equipment-policy'
import {
  compileSessionEgressAllowList,
  EGRESS_SET_VERSION,
  isEgressHostAllowed,
  RoutePolicyError,
  type EgressPolicySubject,
} from '../src/route-policy.js'

function fact(capabilityId: string, accessLevel = 'read', constraints: Record<string, unknown> = {}): CapabilityFact {
  return { capabilityId, accessLevel, constraints }
}

function subject(overrides: Partial<EgressPolicySubject> = {}): EgressPolicySubject {
  return { agentId: 'fake-agent', capabilities: [fact('vault')], ...overrides }
}

test('the compiled allow-list is a plain host set — no terminal block, because the relay is deny-by-default intrinsically', () => {
  const compiled = compileSessionEgressAllowList(subject())
  assert.equal(compiled.egressSetVersion, EGRESS_SET_VERSION)
  assert.deepEqual(compiled.hosts, ['fake-agent.internal.test'])
  assert.ok(!compiled.hosts.includes('*'), 'a wildcard host would be an allow-everything hole, not a terminal block')
})

test('the allow-list is per Session: it depends only on that Session\'s own Agent and capabilities', () => {
  const a = compileSessionEgressAllowList(subject({ agentId: 'claude-code', capabilities: [] }))
  const b = compileSessionEgressAllowList(subject({ agentId: 'codex', capabilities: [] }))
  assert.deepEqual(a.hosts, ['api.anthropic.com', 'statsig.anthropic.com'])
  assert.deepEqual(b.hosts, ['api.openai.com', 'auth.openai.com', 'chatgpt.com'])
  // Required test "No global state": neither Session's list contains a single host of the other's.
  assert.ok(a.hosts.every((host) => !b.hosts.includes(host)))
})

test('required: `github` equipment allow-lists github.com itself, so `git clone` over HTTPS works — not only api.github.com', () => {
  const compiled = compileSessionEgressAllowList(subject({ agentId: 'claude-code', capabilities: [fact('github')] }))
  assert.ok(compiled.hosts.includes('github.com'), 'git-over-HTTPS talks to github.com; an api.github.com-only list silently breaks clone')
  assert.ok(compiled.hosts.includes('api.github.com'))
  assert.ok(compiled.hosts.includes('raw.githubusercontent.com'))
  // and the Agent's own pinned provider hosts are still there
  assert.ok(compiled.hosts.includes('api.anthropic.com'))
})

test('vault derives no external host — it is served by Broker\'s own MCP shim, never through the gateway', () => {
  const withVault = compileSessionEgressAllowList(subject({ agentId: 'claude-code', capabilities: [fact('vault'), fact('vault', 'read-write')] }))
  const without = compileSessionEgressAllowList(subject({ agentId: 'claude-code', capabilities: [] }))
  assert.deepEqual(withVault.hosts, without.hosts)
})

test('the access level is consumed, not ignored — an unreviewed access level refuses to compile', () => {
  // `github/propose` is reviewed…
  assert.ok(compileSessionEgressAllowList(subject({ capabilities: [fact('github', 'propose')] })).hosts.includes('github.com'))
  // …`github/admin` is not, and must not silently inherit `read`'s hosts.
  assert.throws(
    () => compileSessionEgressAllowList(subject({ capabilities: [fact('github', 'admin')] })),
    (error: unknown) => error instanceof RoutePolicyError && error.code === 'unknown_capability_host_mapping',
  )
})

test('required: constraints are consumed, not silently discarded — an unreviewed constraint fails closed', () => {
  // Before P13 the compiler resolved `fact.constraints`, persisted them, then dropped them, so a
  // request for scoped access was granted UNSCOPED. Refusing is the only honest answer while no
  // constraint vocabulary has been reviewed.
  assert.throws(
    () => compileSessionEgressAllowList(subject({ capabilities: [fact('github', 'read', { repositories: ['acme/widgets'] })] })),
    (error: unknown) => error instanceof RoutePolicyError && error.code === 'unreviewed_capability_constraint',
  )
})

test('output is deterministic and deduplicated regardless of capability order', () => {
  const forward = compileSessionEgressAllowList(subject({ agentId: 'codex', capabilities: [fact('github'), fact('vault')] }))
  const backward = compileSessionEgressAllowList(subject({ agentId: 'codex', capabilities: [fact('vault'), fact('github')] }))
  assert.deepEqual(forward, backward)
  assert.deepEqual(forward.hosts, [...forward.hosts].sort())
  assert.equal(new Set(forward.hosts).size, forward.hosts.length)
})

test('an unreviewed Agent identity refuses to compile rather than silently omitting (or granting) its routes', () => {
  assert.throws(
    () => compileSessionEgressAllowList(subject({ agentId: 'unknown-agent' })),
    (error: unknown) => error instanceof RoutePolicyError && error.code === 'unknown_pinned_agent',
  )
})

test('an unreviewed capability id refuses to compile', () => {
  assert.throws(
    () => compileSessionEgressAllowList(subject({ capabilities: [fact('unknown-capability')] })),
    (error: unknown) => error instanceof RoutePolicyError && error.code === 'unknown_capability_host_mapping',
  )
})

test('required: host matching is exact and case-insensitive — never a suffix match', () => {
  const compiled = compileSessionEgressAllowList(subject({ agentId: 'claude-code', capabilities: [fact('github')] }))
  assert.ok(isEgressHostAllowed(compiled, 'api.github.com'))
  assert.ok(isEgressHostAllowed(compiled, 'API.GitHub.COM'), 'DNS names are case-insensitive; a CONNECT line may carry any casing')
  // The whole point of exact matching: an attacker-controlled name that merely CONTAINS a listed
  // one must not pass.
  assert.ok(!isEgressHostAllowed(compiled, 'api.github.com.attacker.test'))
  assert.ok(!isEgressHostAllowed(compiled, 'evil-api.github.com'))
  assert.ok(!isEgressHostAllowed(compiled, 'unlisted.example.test'))
  assert.ok(!isEgressHostAllowed(compiled, '*'))
})

test('a Session whose Agent needs nothing externally compiles to total egress denial, not to an error', () => {
  const compiled = compileSessionEgressAllowList({ agentId: 'fake-agent', capabilities: [] })
  assert.deepEqual(compiled.hosts, ['fake-agent.internal.test'])
  assert.ok(!isEgressHostAllowed(compiled, 'api.anthropic.com'))
})

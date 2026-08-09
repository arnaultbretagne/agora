import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CapabilityFact } from '@agora/equipment-policy'
import {
  compileSessionCredentialGrants,
  CREDENTIAL_SET_VERSION,
  CredentialPolicyError,
  type CredentialPolicySubject,
} from '../src/credential-policy.js'

function fact(capabilityId: string, accessLevel = 'read'): CapabilityFact {
  return { capabilityId, accessLevel, constraints: {} }
}

function subject(overrides: Partial<CredentialPolicySubject> = {}): CredentialPolicySubject {
  return { agentId: 'claude-code', capabilities: [], ...overrides }
}

test('the Agent\'s own provider credential comes from its pinned entry, never from an equipment request', () => {
  const claude = compileSessionCredentialGrants(subject({ agentId: 'claude-code' }))
  const codex = compileSessionCredentialGrants(subject({ agentId: 'codex' }))
  assert.equal(claude.credentialSetVersion, CREDENTIAL_SET_VERSION)
  assert.deepEqual(claude.secretTypes, ['anthropic'])
  assert.deepEqual(codex.secretTypes, ['openai'])
  // Required test "Grant isolation": a Claude Session's compiled set never contains OpenAI's
  // credential, and vice versa.
  assert.ok(!claude.secretTypes.includes('openai'))
  assert.ok(!codex.secretTypes.includes('anthropic'))
})

test('a fake Agent has no provider credential at all — an empty reviewed set, not an unreviewed one', () => {
  const compiled = compileSessionCredentialGrants(subject({ agentId: 'fake-agent' }))
  assert.deepEqual(compiled.secretTypes, [])
  assert.deepEqual(compiled.connections, [])
})

test('vault maps to no OneCLI credential — it is served by Broker\'s own credential-free MCP shim', () => {
  const compiled = compileSessionCredentialGrants(subject({ capabilities: [fact('vault'), fact('vault', 'read-write')] }))
  assert.deepEqual(compiled.connections, [])
})

test('github/read grants exactly the catalogue read tools, and no write tool', () => {
  const compiled = compileSessionCredentialGrants(subject({ capabilities: [fact('github')] }))
  assert.equal(compiled.connections.length, 1)
  const connection = compiled.connections[0]!
  assert.equal(connection.provider, 'github-app')
  assert.ok(connection.allowedToolIds.includes('git_clone'), 'read access must still be able to clone')
  assert.ok(connection.allowedToolIds.includes('graphql_query'))
  for (const write of ['git_push', 'create_pull', 'create_issue', 'graphql_mutation', 'delete_branch']) {
    assert.ok(!connection.allowedToolIds.includes(write), `read must not grant '${write}'`)
  }
})

test('github/propose adds the proposal write tools but never a destructive one', () => {
  const compiled = compileSessionCredentialGrants(subject({ capabilities: [fact('github', 'propose')] }))
  const connection = compiled.connections[0]!
  for (const tool of ['git_clone', 'git_push', 'create_pull', 'create_comment', 'create_issue', 'graphql_mutation']) {
    assert.ok(connection.allowedToolIds.includes(tool), `propose must grant '${tool}'`)
  }
  assert.ok(!connection.allowedToolIds.includes('delete_branch'), 'proposing a change is not deleting a ref; unnamed tools are blocked')
})

test('required: nothing is ever placed in OneCLI\'s approval-gated `ask` list', () => {
  // A headless Session Runtime has no path to OneCLI's approval channel — an `ask` tool would hang
  // the Agent rather than deny it. `CapabilityConnectionGrant` therefore carries allow ids only,
  // and the adapter always sends `ask: []`.
  const compiled = compileSessionCredentialGrants(subject({ capabilities: [fact('github', 'propose')] }))
  assert.ok(compiled.connections.every((connection) => Object.keys(connection).sort().join(',') === 'allowedToolIds,provider'))
})

test('output is deterministic and deduplicated regardless of capability order', () => {
  const forward = compileSessionCredentialGrants(subject({ capabilities: [fact('github'), fact('vault')] }))
  const backward = compileSessionCredentialGrants(subject({ capabilities: [fact('vault'), fact('github')] }))
  assert.deepEqual(forward, backward)
  const tools = forward.connections[0]!.allowedToolIds
  assert.deepEqual(tools, [...tools].sort())
  assert.equal(new Set(tools).size, tools.length)
})

test('an unreviewed Agent or capability/access level refuses to compile rather than attaching an unreviewed credential', () => {
  assert.throws(
    () => compileSessionCredentialGrants(subject({ agentId: 'unknown-agent' })),
    (error: unknown) => error instanceof CredentialPolicyError && error.code === 'unknown_pinned_agent',
  )
  assert.throws(
    () => compileSessionCredentialGrants(subject({ capabilities: [fact('github', 'admin')] })),
    (error: unknown) => error instanceof CredentialPolicyError && error.code === 'unknown_capability_credential_mapping',
  )
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { equals } from '@agora/domain'
import type { Authorization } from '@agora/domain'
import { compile, type CredentialResolver } from '../src/compiler.js'
import type { CapabilityCatalogue, GrantMappingEntry } from '../src/catalogue.js'

function catalogue(mappings: Record<string, readonly GrantMappingEntry[]>, revisionId = 'rev-1'): CapabilityCatalogue {
  const capabilities = new Set(Object.keys(mappings))
  return { revisionId, capabilities, grantsFor: (id) => mappings[id] }
}

const resolver: CredentialResolver = {
  resolveSecret: (ref) => (ref === 'anthropic' ? 'secret-anthropic-live-id' : undefined),
  resolveConnection: (ref) => (ref === 'github-app' ? 'connection-github-live-id' : undefined),
}

test('an unknown capability id is a typed denial, never a silent no-op', () => {
  const result = compile(['nope'], catalogue({}), resolver)
  assert.deepEqual(result, { kind: 'denied', reason: 'unknown_capability', detail: 'capability "nope" is not in the reviewed catalogue' })
})

test('a capability whose credential is not configured in this project is denied, not skipped', () => {
  const cat = catalogue({ 'provider.openai': [{ kind: 'secret', credentialRef: 'openai', tools: 'full', approval: 'unconditional' }] })
  const result = compile(['provider.openai'], cat, resolver)
  assert.equal(result.kind, 'denied')
  assert.equal(result.kind === 'denied' && result.reason, 'unresolvable_credential')
})

test('a required-approval capability is denied when the deployment cannot serve approvals', () => {
  const cat = catalogue({
    'tool.github.write': [{ kind: 'connection', credentialRef: 'github-app', tools: ['git_push'], approval: 'required' }],
  })
  const result = compile(['tool.github.write'], cat, resolver, { approvalSupported: false })
  assert.equal(result.kind === 'denied' && result.reason, 'approval_unavailable')
})

test('AUTH-004 shape: a credential two capabilities both need survives compiling with only one of them', () => {
  const cat = catalogue({
    'tool.github.read': [{ kind: 'connection', credentialRef: 'github-app', tools: ['get_repo'], approval: 'unconditional' }],
    'tool.github.list': [{ kind: 'connection', credentialRef: 'github-app', tools: ['list_repos'], approval: 'unconditional' }],
  })
  const both = compile(['tool.github.read', 'tool.github.list'], cat, resolver)
  const onlyOne = compile(['tool.github.read'], cat, resolver)
  assert.equal(both.kind, 'compiled')
  assert.equal(onlyOne.kind, 'compiled')
  const oneGrant = [...(onlyOne as { grants: ReadonlySet<Authorization> }).grants]
  assert.equal(oneGrant.length, 1)
  assert.deepEqual([...oneGrant[0]!.tools as Set<string>], ['get_repo'], 'removing tool.github.list must not also remove get_repo, which tool.github.read still needs')
})

test('union before difference: two capabilities on the same credential merge into one authorization with the union of tools', () => {
  const cat = catalogue({
    a: [{ kind: 'connection', credentialRef: 'github-app', tools: ['get_repo'], approval: 'unconditional' }],
    b: [{ kind: 'connection', credentialRef: 'github-app', tools: ['list_repos'], approval: 'unconditional' }],
  })
  const result = compile(['a', 'b'], cat, resolver)
  assert.equal(result.kind, 'compiled')
  const grants = [...(result as { grants: ReadonlySet<Authorization> }).grants]
  assert.equal(grants.length, 1, 'one credential, one merged authorization — not two separate grants of the same connection')
  assert.deepEqual(new Set(grants[0]!.tools as Set<string>), new Set(['get_repo', 'list_repos']))
})

test('an unconditional grant that would silently bypass another capability’s approval gate is rejected, not silently resolved', () => {
  const cat = catalogue({
    full: [{ kind: 'secret', credentialRef: 'anthropic', tools: 'full', approval: 'unconditional' }],
    gated: [{ kind: 'secret', credentialRef: 'anthropic', tools: 'full', approval: 'required' }],
  })
  const result = compile(['full', 'gated'], cat, resolver)
  assert.equal(result.kind === 'denied' && result.reason, 'unrepresentable_combination')
})

test('an unconditional subset and a disjoint required subset both survive as two authorizations on the same credential', () => {
  const cat = catalogue({
    read: [{ kind: 'connection', credentialRef: 'github-app', tools: ['get_repo'], approval: 'unconditional' }],
    write: [{ kind: 'connection', credentialRef: 'github-app', tools: ['git_push'], approval: 'required' }],
  })
  const result = compile(['read', 'write'], cat, resolver)
  assert.equal(result.kind, 'compiled')
  const grants = [...(result as { grants: ReadonlySet<Authorization> }).grants]
  assert.equal(grants.length, 2)
  const byApproval = Object.fromEntries(grants.map((g) => [g.approval, [...(g.tools as Set<string>)]]))
  assert.deepEqual(byApproval['unconditional'], ['get_repo'])
  assert.deepEqual(byApproval['required'], ['git_push'])
})

test('an unconditional grant already covering a tool absorbs an overlapping required entry for the same tool', () => {
  const cat = catalogue({
    read: [{ kind: 'connection', credentialRef: 'github-app', tools: ['get_repo', 'list_repos'], approval: 'unconditional' }],
    alsoRead: [{ kind: 'connection', credentialRef: 'github-app', tools: ['get_repo'], approval: 'required' }],
  })
  const result = compile(['read', 'alsoRead'], cat, resolver)
  assert.equal(result.kind, 'compiled')
  const grants = [...(result as { grants: ReadonlySet<Authorization> }).grants]
  assert.equal(grants.length, 1, 'get_repo is already unconditionally allowed — no approval ever fires for it, so no separate gated authorization is emitted')
})

test('AUTH-008 shape: the compiled result is bound to the catalogue revision id', () => {
  const cat = catalogue({ 'provider.anthropic': [{ kind: 'secret', credentialRef: 'anthropic', tools: 'full', approval: 'unconditional' }] }, 'revision-xyz')
  const result = compile(['provider.anthropic'], cat, resolver)
  assert.equal(result.kind === 'compiled' && result.revisionId, 'revision-xyz')
})

test('AUTH-009: requesting no capabilities compiles to the empty set — model/harness selection adds no implicit grant', () => {
  const cat = catalogue({ 'provider.anthropic': [{ kind: 'secret', credentialRef: 'anthropic', tools: 'full', approval: 'unconditional' }] })
  const result = compile([], cat, resolver)
  assert.equal(result.kind, 'compiled')
  assert.equal(result.kind === 'compiled' && result.grants.size, 0)
  assert.ok(equals(new Set(), (result as { grants: ReadonlySet<Authorization> }).grants))
})

test('a duplicated capability id compiles exactly as if requested once', () => {
  const cat = catalogue({ 'provider.anthropic': [{ kind: 'secret', credentialRef: 'anthropic', tools: 'full', approval: 'unconditional' }] })
  const once = compile(['provider.anthropic'], cat, resolver)
  const twice = compile(['provider.anthropic', 'provider.anthropic'], cat, resolver)
  assert.equal(once.kind, 'compiled')
  assert.equal(twice.kind, 'compiled')
  assert.ok(equals((once as { grants: ReadonlySet<Authorization> }).grants, (twice as { grants: ReadonlySet<Authorization> }).grants))
})

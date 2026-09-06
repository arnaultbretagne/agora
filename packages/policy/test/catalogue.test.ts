import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadCapabilityCatalogue, UnmappedCapabilityError } from '../src/catalogue.js'

function writeCatalogue(capabilities: readonly string[], mappings: Record<string, unknown>): { capabilitiesPath: string; grantMappingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agora-policy-test-'))
  const capabilitiesPath = join(dir, 'capabilities.json')
  const grantMappingsPath = join(dir, 'grant-mappings.json')
  writeFileSync(capabilitiesPath, JSON.stringify({ capabilities: capabilities.map((id) => ({ id, description: 'test' })) }))
  writeFileSync(grantMappingsPath, JSON.stringify({ mappings }))
  return { capabilitiesPath, grantMappingsPath }
}

test('the real reviewed catalogue files load and cross-validate', () => {
  const capabilitiesPath = new URL('../../../../contracts/catalogue/capabilities.json', import.meta.url).pathname
  const grantMappingsPath = new URL('../../../../contracts/catalogue/grant-mappings.json', import.meta.url).pathname
  const catalogue = loadCapabilityCatalogue(capabilitiesPath, grantMappingsPath)
  assert.ok(catalogue.capabilities.has('provider.anthropic'))
  assert.ok(catalogue.capabilities.has('tool.github.write'))
  assert.equal(catalogue.revisionId.length, 64, 'a sha256 hex digest')
  assert.ok(catalogue.grantsFor('provider.anthropic')!.length > 0)
})

test('loading is deterministic: the same files produce the same revision id', () => {
  const files = writeCatalogue(['a'], { a: [{ kind: 'secret', credentialRef: 'x', tools: 'full', approval: 'unconditional' }] })
  const first = loadCapabilityCatalogue(files.capabilitiesPath, files.grantMappingsPath)
  const second = loadCapabilityCatalogue(files.capabilitiesPath, files.grantMappingsPath)
  assert.equal(first.revisionId, second.revisionId)
})

test('AUTH-008 shape: a materially different catalogue produces a distinct revision id', () => {
  const files = writeCatalogue(['a'], { a: [{ kind: 'secret', credentialRef: 'x', tools: 'full', approval: 'unconditional' }] })
  const revisedFiles = writeCatalogue(['a'], { a: [{ kind: 'secret', credentialRef: 'y', tools: 'full', approval: 'unconditional' }] })
  const before = loadCapabilityCatalogue(files.capabilitiesPath, files.grantMappingsPath)
  const after = loadCapabilityCatalogue(revisedFiles.capabilitiesPath, revisedFiles.grantMappingsPath)
  assert.notEqual(before.revisionId, after.revisionId)
})

test('a registered capability with no grant-mappings entry fails loading rather than compiling to nothing', () => {
  const files = writeCatalogue(['a', 'b'], { a: [{ kind: 'secret', credentialRef: 'x', tools: 'full', approval: 'unconditional' }] })
  assert.throws(() => loadCapabilityCatalogue(files.capabilitiesPath, files.grantMappingsPath), UnmappedCapabilityError)
})

test('a grant-mappings entry for an unregistered capability fails loading', () => {
  const files = writeCatalogue(['a'], {
    a: [{ kind: 'secret', credentialRef: 'x', tools: 'full', approval: 'unconditional' }],
    ghost: [{ kind: 'secret', credentialRef: 'y', tools: 'full', approval: 'unconditional' }],
  })
  assert.throws(() => loadCapabilityCatalogue(files.capabilitiesPath, files.grantMappingsPath), /ghost/)
})

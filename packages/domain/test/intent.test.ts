import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import type { CatalogueView } from '../src/index.js'
import { validateIntentShape } from '../src/index.js'

const catalogue: CatalogueView = {
  harnesses: new Set(['claude-code', 'codex']),
  capabilities: new Set(['workspace.read', 'provider.invoke']),
  models: (harness) => {
    if (harness === 'claude-code') return ['claude-sonnet-4-5', 'claude-haiku-4-5']
    if (harness === 'codex') return ['gpt-5-codex']
    return []
  },
  efforts: (_harness, model) => (model === 'claude-sonnet-4-5' ? ['default', 'high'] : ['default']),
}

const validOn = {
  power: 'on',
  harness: 'claude-code',
  capabilities: ['workspace.read', 'provider.invoke'],
  model: 'claude-sonnet-4-5',
  effort: 'high',
  persona: 'default',
}

test('a complete on Intent against the catalogue is valid and keeps the registered field names', () => {
  const result = validateIntentShape(validOn, catalogue)
  assert.equal(result.valid, true)
  if (result.valid) {
    assert.equal(result.intent.power, 'on')
    assert.equal(result.intent.harness, 'claude-code')
    assert.deepEqual([...result.intent.capabilities], ['workspace.read', 'provider.invoke'])
    assert.equal(result.intent.model, 'claude-sonnet-4-5')
    assert.equal(result.intent.effort, 'high')
    assert.equal(result.intent.persona, 'default')
  }
})

test('persona must equal the frozen default', () => {
  const result = validateIntentShape({ ...validOn, persona: 'assistant' }, catalogue)
  assert.equal(result.valid, false)
  if (!result.valid) {
    assert.equal(result.errors[0]?.field, 'persona')
  }
})

test('effort must be a string level, not another type', () => {
  const result = validateIntentShape({ ...validOn, effort: 3 }, catalogue)
  assert.equal(result.valid, false)
  if (!result.valid) {
    assert.equal(result.errors[0]?.field, 'effort')
    assert.equal(result.errors[0]?.code, 'type')
  }
})

test('an on Intent is validated against the catalogue for harness, model, effort and capabilities', () => {
  const unknownHarness = validateIntentShape({ ...validOn, harness: 'mystery' }, catalogue)
  assert.equal(unknownHarness.valid, false)
  const unknownModel = validateIntentShape({ ...validOn, model: 'gpt-5-codex' }, catalogue)
  assert.equal(unknownModel.valid, false)
  const invalidEffortForModel = validateIntentShape({ ...validOn, effort: 'ultrathink' }, catalogue)
  assert.equal(invalidEffortForModel.valid, false)
  const unknownCapability = validateIntentShape({ ...validOn, capabilities: ['workspace.read', 'network.tunnel'] }, catalogue)
  assert.equal(unknownCapability.valid, false)
  if (!unknownCapability.valid) {
    assert.equal(unknownCapability.errors[0]?.code, 'catalogue')
    assert.equal(unknownCapability.errors[0]?.field, 'capabilities')
  }
})

test('an off Intent keeps retained selections without depending on the catalogue', () => {
  const off = {
    power: 'off',
    harness: 'claude-code',
    capabilities: ['workspace.read'],
    model: 'claude-sonnet-4-5',
    effort: 'high',
    persona: 'default',
  }
  const withRetiredEntries = validateIntentShape(
    { ...off, harness: 'retired-harness', model: 'retired-model', capabilities: ['retired.capability'] },
    catalogue,
  )
  assert.equal(withRetiredEntries.valid, true)
})

test('duplicate capability ids are a shape error', () => {
  const result = validateIntentShape({ ...validOn, capabilities: ['workspace.read', 'workspace.read'] }, catalogue)
  assert.equal(result.valid, false)
  if (!result.valid) {
    assert.equal(result.errors[0]?.code, 'value')
  }
})

test('missing fields and non-object input are reported without throwing', () => {
  const empty = validateIntentShape({}, catalogue)
  assert.equal(empty.valid, false)
  if (!empty.valid) {
    assert.equal(empty.errors.length, 6)
  }
  for (const input of [null, 42, 'intent', []]) {
    const result = validateIntentShape(input, catalogue)
    assert.equal(result.valid, false)
  }
})

test('every valid schema fixture passes validateIntentShape and every invalid fixture fails it', async () => {
  const fixturesDir = new URL('../../../../contracts/schemas/fixtures/intent/', import.meta.url)
  const entries = await readdir(fixturesDir)
  assert.ok(entries.length >= 4)
  for (const entry of entries) {
    const instance = JSON.parse(await readFile(new URL(entry, fixturesDir), 'utf8'))
    const result = validateIntentShape(instance, catalogue)
    if (entry.startsWith('valid-')) {
      assert.equal(result.valid, true, `${entry} should pass validateIntentShape`)
    } else if (entry.startsWith('invalid-')) {
      assert.equal(result.valid, false, `${entry} should fail validateIntentShape`)
    }
  }
})

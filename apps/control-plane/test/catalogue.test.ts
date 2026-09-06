import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogueRevisionSet, loadCatalogueView } from '../src/catalogue.js'

const harnessDefinitionsPath = new URL('../../../../contracts/catalogue/harness-definitions.json', import.meta.url).pathname
const capabilitiesPath = new URL('../../../../contracts/catalogue/capabilities.json', import.meta.url).pathname

test('loadCatalogueView reads the real reviewed harness and capability catalogues', () => {
  const view = loadCatalogueView(harnessDefinitionsPath, capabilitiesPath)
  assert.ok(view.harnesses.has('claude-code'))
  assert.ok(view.capabilities.has('provider.anthropic'))
  const models = view.models('claude-code')
  assert.ok(models.includes('sonnet'))
  assert.ok(!models.includes('default'), 'the alias model is deliberately excluded from the reviewed set')
  assert.ok(view.efforts('claude-code', 'sonnet').includes('high'))
})

test('an unknown harness or model reports no models/efforts rather than throwing', () => {
  const view = loadCatalogueView(harnessDefinitionsPath, capabilitiesPath)
  assert.deepEqual(view.models('unknown-harness'), [])
  assert.deepEqual(view.efforts('claude-code', 'unknown-model'), [])
})

test('catalogueRevisionSet is deterministic and changes when the underlying files change', () => {
  const first = catalogueRevisionSet(harnessDefinitionsPath, capabilitiesPath)
  const second = catalogueRevisionSet(harnessDefinitionsPath, capabilitiesPath)
  assert.deepEqual(first, second)
})

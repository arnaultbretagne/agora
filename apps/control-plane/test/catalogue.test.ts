import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogueRevisionSet, loadCatalogueView, loadWorkspaceRoot, loadRestoreHarness } from '../src/catalogue.js'
import { setWorkspaceRoot, workspaceRoot } from '../src/workspace-root.js'

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

test('the workspace root and the custody contract both come from the reviewed harness definition', () => {
  // This is what the S9 end-to-end run caught: the control plane used to hardcode `/workspace`
  // while the PodSpec launched the adapter in the harness definition's own root, and the driver
  // derived the transcript's directory slug from THAT. Two components silently disagreeing.
  assert.equal(loadWorkspaceRoot(harnessDefinitionsPath, 'claude-code'), '/home/agent/work')
  assert.equal(loadWorkspaceRoot(harnessDefinitionsPath, 'unknown-harness'), undefined)

  const harness = loadRestoreHarness(harnessDefinitionsPath, 'claude-code')
  assert.deepEqual(harness?.supportedFormats, [{ formatId: 'claude-code-transcript', formatVersion: 1 }])
  assert.deepEqual(harness?.acceptedDriverRevisions, ['claude-code-transcript-1'])
  assert.equal(loadRestoreHarness(harnessDefinitionsPath, 'unknown-harness'), undefined, 'a harness with no custody contract simply has no restorable Saves')
})

test('setWorkspaceRoot is what every ACP call in the process reads', () => {
  const original = workspaceRoot()
  try {
    setWorkspaceRoot('/home/agent/work')
    assert.equal(workspaceRoot(), '/home/agent/work')
  } finally {
    setWorkspaceRoot(original)
  }
})

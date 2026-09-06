import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeAnchor, type AnchorEvidence } from '../src/anchor.js'

const HARNESS: NonNullable<AnchorEvidence['harness']> = {
  harnessId: 'claude-code',
  supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }],
  acceptedDriverRevisions: ['claude-code-transcript-1'],
  workspaceDeps: {},
}

const SAVE: NonNullable<AnchorEvidence['save']> = {
  id: 'save-1',
  harnessId: 'claude-code',
  formatId: 'claude-code-transcript',
  formatVersion: 1,
  driverRevision: 'claude-code-transcript-1',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  workspaceDeps: {},
}

test('a Save this harness can read is compatible', () => {
  assert.equal(normalizeAnchor({ save: SAVE, harness: HARNESS, invalidated: false }), 'compatible')
})

test('no Anchor is `none` — there is nothing to restore, which is not the same as a failure', () => {
  assert.equal(normalizeAnchor({ save: null, harness: HARNESS, invalidated: false }), 'none')
})

test('CONT-008: a verified invalidation makes the Anchor none, however healthy the Save looks', () => {
  assert.equal(normalizeAnchor({ save: SAVE, harness: HARNESS, invalidated: true }), 'none')
})

test('a format or driver revision the deployed harness does not accept is none', () => {
  assert.equal(normalizeAnchor({ save: { ...SAVE, formatVersion: 2 }, harness: HARNESS, invalidated: false }), 'none')
  assert.equal(normalizeAnchor({ save: { ...SAVE, driverRevision: 'claude-code-transcript-2' }, harness: HARNESS, invalidated: false }), 'none')
  assert.equal(normalizeAnchor({ save: { ...SAVE, harnessId: 'codex' }, harness: HARNESS, invalidated: false }), 'none')
})

test('an image digest difference alone stays compatible — an upgrade is normal, a format change is not', () => {
  // The digest says which build wrote the bytes; the format and driver say whether they can be read.
  assert.equal(normalizeAnchor({ save: { ...SAVE, imageDigest: `sha256:${'b'.repeat(64)}` }, harness: HARNESS, invalidated: false }), 'compatible')
})

test('CONT-011: an unversioned or unavailable workspace dependency is none, never an attempted resume', () => {
  assert.equal(normalizeAnchor({ save: { ...SAVE, workspaceDeps: { repo: '' } }, harness: HARNESS, invalidated: false }), 'none')
  assert.equal(normalizeAnchor({ save: { ...SAVE, workspaceDeps: { repo: 'v2' } }, harness: HARNESS, invalidated: false }), 'none')
  assert.equal(
    normalizeAnchor({ save: { ...SAVE, workspaceDeps: { repo: 'v2' } }, harness: { ...HARNESS, workspaceDeps: { repo: 'v2' } }, invalidated: false }),
    'compatible',
  )
})

test('an unknown harness definition is none rather than a guess in either direction', () => {
  assert.equal(normalizeAnchor({ save: SAVE, harness: null, invalidated: false }), 'none')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeModel, normalizeEffort } from '../src/config.js'
import { normalizeSync } from '../src/sync.js'

test('normalizeModel/Effort: report the fresh snapshot values verbatim', () => {
  assert.equal(normalizeModel({ model: 'sonnet', effort: 'high' }), 'sonnet')
  assert.equal(normalizeEffort({ model: 'sonnet', effort: 'high' }), 'high')
})

test('normalizeModel/Effort: no snapshot (not live) is undefined, never a guessed default', () => {
  assert.equal(normalizeModel(null), null)
  assert.equal(normalizeEffort(null), null)
})

// normalizeSync's own contract now lives in sync.test.ts (S9); these keep the two cases this file
// has always asserted, in the shape the evidence takes today.
const empty = { delivery: 'none', proof: 'incorporated', lineageIntact: true } as const

test('normalizeSync: the empty opening range (W = H) is always current', () => {
  assert.equal(normalizeSync({ descriptor: { w: 0, h: 0 }, ...empty }), 'current')
  assert.equal(normalizeSync({ descriptor: { w: 5, h: 5 }, ...empty }), 'current')
})

test('normalizeSync: no descriptor at all is unavailable', () => {
  assert.equal(normalizeSync(null), null)
})

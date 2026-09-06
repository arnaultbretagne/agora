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

test('normalizeSync: the empty opening range (W = H) is always current', () => {
  assert.equal(normalizeSync({ w: 0, h: 0 }), 'current')
  assert.equal(normalizeSync({ w: 5, h: 5 }), 'current')
})

test('normalizeSync: a non-empty range (W < H) is unavailable in S8 — S9\'s native proof isn\'t wired yet, never guessed stale', () => {
  assert.equal(normalizeSync({ w: 0, h: 5 }), null)
})

test('normalizeSync: no descriptor at all is unavailable', () => {
  assert.equal(normalizeSync(null), null)
})

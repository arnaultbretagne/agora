import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSubstrate, InvalidSubstrate, SUBSTRATES } from '../lib/substrate.js'

test('resolveSubstrate: no override -> the platform default (policy)', () => {
  assert.equal(resolveSubstrate(undefined, 'shared'), 'shared')
  assert.equal(resolveSubstrate(undefined, 'isolated'), 'isolated')
})

test('resolveSubstrate: a valid override wins over the default (override)', () => {
  assert.equal(resolveSubstrate('isolated', 'shared'), 'isolated')
  assert.equal(resolveSubstrate('shared', 'isolated'), 'shared')
})

test('resolveSubstrate: an invalid override throws InvalidSubstrate (validation -> 400)', () => {
  assert.throws(() => resolveSubstrate('not-a-substrate', 'shared'), InvalidSubstrate)
  assert.equal(SUBSTRATES.includes('not-a-substrate'), false)
})

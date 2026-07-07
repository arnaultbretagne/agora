import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSubstrate, normalizeSubstrateDefault, SUBSTRATES } from '../lib/substrate.js'

test('normalizeSubstrateDefault: absent/empty -> shared; a valid value passes through', () => {
  assert.equal(normalizeSubstrateDefault(undefined), 'shared')
  assert.equal(normalizeSubstrateDefault(''), 'shared')
  assert.equal(normalizeSubstrateDefault('shared'), 'shared')
  assert.equal(normalizeSubstrateDefault('isolated'), 'isolated')
})

test('normalizeSubstrateDefault: a bad config value throws (fail loud at boot)', () => {
  assert.throws(() => normalizeSubstrateDefault('not-a-substrate'), /invalid AGORA_SUBSTRATE_DEFAULT/)
  assert.equal(SUBSTRATES.includes('not-a-substrate'), false)
})

test('resolveSubstrate: pure policy — returns the platform default, ignores the conversation', () => {
  // The running content can never influence its own sandboxing: the decision is the
  // platform's, so nothing about the conversation changes the answer today.
  assert.equal(resolveSubstrate({ id: 'c-x' }, 'shared'), 'shared')
  assert.equal(resolveSubstrate({ id: 'c-x', substrate: 'isolated' }, 'shared'), 'shared')
  assert.equal(resolveSubstrate(undefined, 'isolated'), 'isolated')
})

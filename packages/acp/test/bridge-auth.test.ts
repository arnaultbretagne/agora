import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeTokenExpiry, bridgeTokenNeedsRenewal, mintBridgeToken, verifyBridgeToken } from '../src/bridge-auth.js'

const SECRET = 'shared-secret'

test('a token minted for one incarnation verifies for that same incarnation', () => {
  const token = mintBridgeToken('inc-1', SECRET)
  assert.deepEqual(verifyBridgeToken(token, 'inc-1', SECRET), { ok: true, claims: { incarnation: 'inc-1', exp: (verifyBridgeToken(token, 'inc-1', SECRET) as { ok: true; claims: { exp: number } }).claims.exp } })
})

test('a token minted for one incarnation is refused by another\'s Pod (no cross-incarnation replay)', () => {
  const token = mintBridgeToken('inc-1', SECRET)
  assert.deepEqual(verifyBridgeToken(token, 'inc-2', SECRET), { ok: false, reason: 'wrong_incarnation' })
})

test('a token signed with the wrong secret is refused', () => {
  const token = mintBridgeToken('inc-1', 'a-different-secret')
  assert.deepEqual(verifyBridgeToken(token, 'inc-1', SECRET), { ok: false, reason: 'bad_signature' })
})

test('an expired token is refused', () => {
  const mintedAt = Date.parse('2026-01-01T00:00:00.000Z')
  const token = mintBridgeToken('inc-1', SECRET, 60, mintedAt)
  const justBefore = verifyBridgeToken(token, 'inc-1', SECRET, mintedAt + 59_000)
  assert.equal(justBefore.ok, true)
  const afterExpiry = verifyBridgeToken(token, 'inc-1', SECRET, mintedAt + 60_000)
  assert.deepEqual(afterExpiry, { ok: false, reason: 'expired' })
})

test('a malformed token is refused, never throws', () => {
  assert.deepEqual(verifyBridgeToken('not-a-token', 'inc-1', SECRET), { ok: false, reason: 'malformed' })
  assert.deepEqual(verifyBridgeToken('', 'inc-1', SECRET), { ok: false, reason: 'malformed' })
})

test('a tampered payload (same signature) is refused', () => {
  const token = mintBridgeToken('inc-1', SECRET)
  const [payload, signature] = token.split('.')
  const tamperedPayload = Buffer.from(JSON.stringify({ incarnation: 'inc-2', exp: 9999999999 })).toString('base64url')
  assert.deepEqual(verifyBridgeToken(`${tamperedPayload}.${signature}`, 'inc-2', SECRET), { ok: false, reason: 'bad_signature' })
  void payload
})

test('a token is due for renewal before it expires, not after — the holder never starts work with a spent one', () => {
  const mintedAt = Date.parse('2026-01-01T00:00:00.000Z')
  const token = mintBridgeToken('inc-1', SECRET, 3600, mintedAt)
  assert.equal(bridgeTokenNeedsRenewal(token, 300, mintedAt), false)
  // 55 minutes in: 5 minutes left, which is exactly the margin — renew.
  assert.equal(bridgeTokenNeedsRenewal(token, 300, mintedAt + 55 * 60_000), true)
  // And long after expiry, which is the state the live cluster was stuck in for two hours.
  assert.equal(bridgeTokenNeedsRenewal(token, 300, mintedAt + 7200_000), true)
})

test('a missing or unreadable token is due for renewal, never treated as valid', () => {
  assert.equal(bridgeTokenNeedsRenewal(null), true)
  assert.equal(bridgeTokenNeedsRenewal(undefined), true)
  assert.equal(bridgeTokenNeedsRenewal('not-a-token'), true)
  assert.equal(bridgeTokenExpiry('not-a-token'), null)
})

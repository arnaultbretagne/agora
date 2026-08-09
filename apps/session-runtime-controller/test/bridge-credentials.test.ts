import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BridgeCredentialIssuer } from '../src/bridge-credentials.js'

const endpointFor = (sessionId: string) => `wss://runtime.internal/${sessionId}`

test('repeating the same request id returns the same still-unused credential', () => {
  const issuer = new BridgeCredentialIssuer({ ttlMs: 60_000 })
  const first = issuer.mint('session-a', 'req-1', endpointFor, 1_000)
  const second = issuer.mint('session-a', 'req-1', endpointFor, 1_500)
  assert.equal(first.credential, second.credential)
})

test('an expired credential is never revived — the same request id after expiry mints a new one', () => {
  const issuer = new BridgeCredentialIssuer({ ttlMs: 1_000 })
  const first = issuer.mint('session-a', 'req-1', endpointFor, 1_000)
  const second = issuer.mint('session-a', 'req-1', endpointFor, 5_000) // well past expiry
  assert.notEqual(first.credential, second.credential)
  assert.equal(issuer.verify('session-a', first.credential, 5_000), false)
})

test('required: Session A cannot connect using Session B bridge credential', () => {
  const issuer = new BridgeCredentialIssuer({ ttlMs: 60_000 })
  const forA = issuer.mint('session-a', 'req-1', endpointFor, 1_000)
  assert.equal(issuer.verify('session-a', forA.credential, 1_500), true)
  assert.equal(issuer.verify('session-b', forA.credential, 1_500), false)
})

test('verify rejects a forged/tampered credential', () => {
  const issuer = new BridgeCredentialIssuer({ ttlMs: 60_000 })
  const forA = issuer.mint('session-a', 'req-1', endpointFor, 1_000)
  const tampered = forA.credential.replace(/\.[^.]+$/, '.tampered-signature')
  assert.equal(issuer.verify('session-a', tampered, 1_500), false)
})

test('revokeSession invalidates all credentials for that session', () => {
  const issuer = new BridgeCredentialIssuer({ ttlMs: 60_000 })
  const forA = issuer.mint('session-a', 'req-1', endpointFor, 1_000)
  issuer.revokeSession('session-a')
  const reminted = issuer.mint('session-a', 'req-1', endpointFor, 1_500)
  assert.notEqual(forA.credential, reminted.credential)
})

test('required: revokeSession invalidates verification of an already-minted, still-unexpired credential', () => {
  const issuer = new BridgeCredentialIssuer({ ttlMs: 60_000 })
  const forA = issuer.mint('session-a', 'req-1', endpointFor, 1_000)
  assert.equal(issuer.verify('session-a', forA.credential, 1_500), true)
  issuer.revokeSession('session-a')
  assert.equal(issuer.verify('session-a', forA.credential, 1_500), false)
})

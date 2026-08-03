import assert from 'node:assert/strict'
import { test } from 'node:test'
import type pg from 'pg'
import { cancelSession } from '@agora/acp'
import { createControlPlane } from '../src/app.js'

test('createControlPlane wires bootstrapSession/promptSession/cancelSession to the given pool', () => {
  // Shape/wiring only — real behavior is covered end-to-end by packages/acp's own test suite
  // against a real Postgres; this pool is never actually used for I/O here.
  const fakePool = {} as pg.Pool
  const controlPlane = createControlPlane(fakePool)

  assert.equal(controlPlane.pool, fakePool)
  assert.equal(typeof controlPlane.bootstrapSession, 'function')
  assert.equal(typeof controlPlane.promptSession, 'function')
  assert.equal(controlPlane.cancelSession, cancelSession)
})

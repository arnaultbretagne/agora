import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSpec } from '../lib/supervisor.js'

const OPTS = {
  convId: 'c-1', runId: 'c-1-r1', nativeSessionId: 'uuid-1', resumeFrom: undefined,
  hubUrl: 'ws://test/ws/channel', token: 't1', channelLogDir: undefined,
}

test('spawnSpec carries substrate/group through to the supervisor payload (agent-runtime ADR 0010)', () => {
  const spec = spawnSpec({ kind: 'claude', model: 'sonnet' }, { ...OPTS, substrate: 'isolated', group: 'c-1' })
  assert.equal(spec.substrate, 'isolated')
  assert.equal(spec.group, 'c-1')
})

test('spawnSpec: shared substrate still carries the (undefined-safe) fields', () => {
  const spec = spawnSpec({ kind: 'claude', model: 'sonnet' }, { ...OPTS, substrate: 'shared', group: 'c-1' })
  assert.equal(spec.substrate, 'shared')
  assert.equal(spec.group, 'c-1')
})

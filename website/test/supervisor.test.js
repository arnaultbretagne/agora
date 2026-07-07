import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSpec } from '../lib/supervisor.js'

const OPTS = {
  convId: 'c-1', runId: 'c-1-r1', nativeSessionId: 'uuid-1', resumeFrom: undefined,
  hubUrl: 'ws://test/ws/channel', token: 't1', channelLogDir: undefined,
}

test('spawnSpec carries the group (co-location key) to the supervisor payload, and no substrate (agent-runtime ADR 0010)', () => {
  const spec = spawnSpec({ kind: 'claude', model: 'sonnet' }, { ...OPTS, group: 'c-1' })
  assert.equal(spec.group, 'c-1', 'the manager routes on the group to get-or-create the loge')
  assert.equal('substrate' in spec, false, 'placement is the manager’s call — the hub sends no substrate')
})

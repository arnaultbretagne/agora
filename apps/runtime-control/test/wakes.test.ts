import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readWakes, WakeLog } from '../src/wakes.js'

test('WakeLog: a first-ever poll (no cursor) always relists rather than trusting an empty buffer', async () => {
  const log = new WakeLog()
  log.push('w1')
  const response = await readWakes(log, null, async () => ['w1', 'w2'])
  assert.equal(response.resync, true)
  assert.deepEqual(response.events.map((e) => e.workstreamId).sort(), ['w1', 'w2'])
})

test('WakeLog: a known, current cursor gets only what changed since it', async () => {
  const log = new WakeLog()
  log.push('w1')
  const first = await readWakes(log, null, async () => [])
  log.push('w2')
  const incremental = await readWakes(log, first.cursor, async () => {
    throw new Error('must not relist on a trusted cursor')
  })
  assert.equal(incremental.resync, false)
  assert.deepEqual(incremental.events.map((e) => e.workstreamId), ['w2'])
})

test('WakeLog: a cursor older than everything retained triggers a relist instead of a silent gap', async () => {
  const log = new WakeLog(2)
  for (let i = 0; i < 5; i += 1) log.push(`w${i}`)
  const response = await readWakes(log, '1', async () => ['w4'])
  assert.equal(response.resync, true, 'cursor 1 was trimmed out of the bounded buffer')
})

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { start } from '../server.js'

// The listener split (agora ADR 0002 amendment; agent-broker plan P1): the channel
// WS gets its own :8601 listener serving ONLY /ws/channel (+ a probe health), while
// the human UI/API stays on :8600. A loge reaches the channel without reaching the
// human run-lifecycle API. Ephemeral ports (0) so the test never collides.

const { server, channelServer } = start({ port: 0, channelPort: 0, host: '127.0.0.1' })
const ready = (s) => (s.listening ? Promise.resolve() : once(s, 'listening'))
await Promise.all([ready(server), ready(channelServer)])
const HUMAN = server.address().port
const CHAN = channelServer.address().port

after(() => { server.close(); channelServer.close() })

const status = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).status
const wsOutcome = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('error', () => resolve('refused'))
  })

// ── channel plane :8601 (loge-facing) ────────────────────────────────────
test('channel plane serves only a minimal health probe', async () => {
  assert.equal(await status(CHAN, '/healthz'), 200)
})
test('channel plane refuses the human API (no /api)', async () => {
  assert.equal(await status(CHAN, '/api/conversations'), 404)
})
test('channel plane refuses static / UI assets', async () => {
  assert.equal(await status(CHAN, '/index.html'), 404)
})
test('channel plane accepts /ws/channel', async () => {
  assert.equal(await wsOutcome(`ws://127.0.0.1:${CHAN}/ws/channel`), 'open')
})
test('channel plane refuses /ws/client (the browser plane)', async () => {
  assert.equal(await wsOutcome(`ws://127.0.0.1:${CHAN}/ws/client`), 'refused')
})

// ── human plane :8600 (unchanged) ────────────────────────────────────────
test('human plane still serves the API', async () => {
  assert.equal(await status(HUMAN, '/api/conversations'), 200)
})
test('human plane still accepts /ws/channel during the transition', async () => {
  assert.equal(await wsOutcome(`ws://127.0.0.1:${HUMAN}/ws/channel`), 'open')
})
test('human plane still accepts /ws/client', async () => {
  assert.equal(await wsOutcome(`ws://127.0.0.1:${HUMAN}/ws/client`), 'open')
})

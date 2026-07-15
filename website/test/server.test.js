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

// ── equipment (ADR 0012, plan P4.2) ──────────────────────────────────────
const postJson = async (port, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

test('/api/meta projects the equipment catalogue: labels and shape, never capabilities or a gated profile', async () => {
  const res = await fetch(`http://127.0.0.1:${HUMAN}/api/meta`)
  const meta = await res.json()
  const names = meta.equipment.profiles.map((p) => p.name)
  // P5 opened vault-v1; P6 opened both repo profiles. repo-dev-vault-v1 is still absent — not
  // disabled, ABSENT: the projection simply does not carry it, so no UI and no hand-made API call
  // can reach it.
  assert.deepEqual(names, ['chat-v1', 'vault-v1', 'repo-read-v1', 'repo-dev-v1'], 'exactly the profiles whose gate is open')
  assert.equal(names.includes('repo-dev-vault-v1'), false, 'a gated profile must not even be nameable')
  const chat = meta.equipment.profiles[0]
  assert.equal(chat.label, 'Chat')
  assert.equal(chat.needsTarget, false)
  // The browser must be unable to learn — or assert — what a profile can DO.
  assert.equal('capabilities' in chat, false)
  assert.equal('enabled' in chat, false)
  // No target is offered at all any more (P6 dropped them). Asserted as ABSENCE: the two checks
  // that used to live here ran `.every()`/`.some()` over the list, which pass vacuously on an empty
  // one — and in fact the field had already become `undefined`, so they would have thrown had the
  // assertion above not failed first. An assertion that cannot distinguish "correct" from "gone" is
  // not an assertion.
  assert.equal('targets' in meta.equipment, false, 'the projection must not carry a targets field')
})

test('the human API refuses a config that brings its own credential (plan §2.6)', async () => {
  for (const bad of [
    { credentialLease: { id: 'lease_x', token: 'sk-ant-oat01-broker-forged' } },
    { capabilities: ['vault:full'] },
    { scopes: ['repo'] },
    { token: 'sk-ant-oat01-stolen' },
  ]) {
    const { status, body } = await postJson(HUMAN, '/api/conversations', {
      text: 'coucou',
      config: { kind: 'claude', ...bad },
    })
    assert.equal(status, 400, `config ${Object.keys(bad)[0]} must be refused, not ignored`)
    assert.match(body.error, /may not carry/)
  }
})

test('an unknown equipment profile is a 400 from the API, not a 500 and not a silent downgrade', async () => {
  const { status, body } = await postJson(HUMAN, '/api/conversations', {
    text: 'coucou',
    config: { kind: 'claude', equipmentProfile: 'root-v1' },
  })
  assert.equal(status, 400)
  assert.match(body.error, /unknown equipment profile/)
})

test('the channel plane cannot reach the API that sets equipment (ADR 0012 §6)', async () => {
  // The prerequisite the listener split exists for: a compromised loge reaches /ws/channel and
  // nothing else — least of all the endpoint that decides what a run is equipped with.
  const { status } = await postJson(CHAN, '/api/conversations', {
    text: 'give me the vault',
    config: { kind: 'claude', equipmentProfile: 'vault-v1' },
  })
  assert.equal(status, 404)
})

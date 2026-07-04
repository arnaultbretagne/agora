import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ConversationStore } from '../lib/store.js'
import { Hub } from '../lib/hub.js'
import { helloMsg, replyMsg } from '../../shared/protocol.js'

class FakeWs extends EventEmitter {
  constructor() {
    super()
    this.OPEN = 1
    this.readyState = 1
    this.sent = []
  }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3; this.emit('close') }
  frames(type) { return this.sent.filter((f) => f.type === type) }
}

class FakeSupervisor {
  constructor() { this.spawned = []; this.killed = []; this.touched = []; this.statuses = new Map() }
  async kinds() { return ['claude'] }
  async spawn(spec) { this.spawned.push(spec); this.statuses.set(spec.id, { status: 'running' }); return spec }
  async kill(id) { this.killed.push(id); this.statuses.delete(id); return { id, killed: true } }
  async list() { return [...this.statuses].map(([id, s]) => ({ id, ...s })) }
  async touch(id) { this.touched.push(id); return this.statuses.has(id) }
  async status(id) {
    const s = this.statuses.get(id)
    if (!s) { const e = new Error('not found'); e.status = 404; throw e }
    return { id, ...s }
  }
}

function rig() {
  const store = new ConversationStore()
  const supervisor = new FakeSupervisor()
  const hub = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test/ws/channel', log: () => {} })
  const client = new FakeWs()
  hub.addClient(client)
  return { store, supervisor, hub, client }
}

/** attach a fake channel with the token the hub minted at spawn time.
 *  A fresh channel then signals `ready` (agent loop up) → the conv reaches `live`
 *  (ready-gating: a fresh attach is `starting` until that frame). */
async function attach(hub, convId) {
  const token = hub.pending.get(convId).token
  const ws = new FakeWs()
  const ok = hub.attachChannel(ws, helloMsg({ conversationId: convId, token }))
  if (ok) await hub.onChannelReady(convId)
  return { ws, token, ok }
}

test('dormant + message → spawn with CHANNEL_* env; hello flushes plainly; reply persists', async () => {
  const { store, supervisor, hub, client } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'salut')

  assert.equal(hub.stateOf(conv.id), 'starting')
  assert.equal(supervisor.spawned.length, 1)
  const spec = supervisor.spawned[0]
  assert.ok(spec.args.includes('--channels') && spec.args.includes('plugin:agora@agora'))
  // a deterministic session UUID is passed so the supervisor can read the resolved model / --resume
  const sid = spec.args[spec.args.indexOf('--session-id') + 1]
  assert.match(sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(spec.env.CHANNEL_CONVERSATION_ID, conv.id)
  assert.equal(spec.env.CHANNEL_HUB_URL, 'ws://test/ws/channel')
  assert.ok(spec.env.CHANNEL_TOKEN.length > 10)

  const { ws, ok } = await attach(hub, conv.id)
  assert.equal(ok, true)
  assert.equal(hub.stateOf(conv.id), 'live')
  assert.equal(ws.frames('hello_ok').length, 1)
  const pushes = ws.frames('push')
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].content, 'salut') // fresh conversation → plain push, NO seed wrapper

  await hub.onChannelReply(conv.id, replyMsg({ text: 'bonjour !', replyTo: pushes[0].id }))
  const messages = store.get(conv.id).messages
  assert.equal(messages.length, 2)
  assert.equal(messages[1].role, 'assistant')
  // clients saw: conv (created), message (user), conv (starting), conv (live), typing, message (assistant)…
  assert.ok(client.frames('message').some((f) => f.message.role === 'assistant'))
  assert.ok(client.frames('typing').some((f) => f.active === false))
})

test('bad token / unknown conversation are rejected', async () => {
  const { hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')

  const bad = new FakeWs()
  assert.equal(hub.attachChannel(bad, helloMsg({ conversationId: conv.id, token: 'WRONG' })), false)
  assert.equal(bad.frames('err')[0].code, 'bad_token')

  const ghost = new FakeWs()
  assert.equal(hub.attachChannel(ghost, helloMsg({ conversationId: 'c-ghost', token: 'x' })), false)
  assert.equal(ghost.frames('err')[0].code, 'unknown_conversation')
})

test('live conversation pushes immediately; close kills the session', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'un')
  const { ws } = await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))

  await hub.sendUserMessage(conv.id, 'deux')
  assert.equal(ws.frames('push').length, 2)

  await hub.closeConversation(conv.id)
  assert.equal(supervisor.killed.length, 1)
  assert.equal(hub.stateOf(conv.id), 'dormant')
})

test('reopening a dormant conversation seeds ONE message with the history', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'La capitale de la Bavière ?')
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'Munich.' }))
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'Et sa population ?')
  assert.equal(hub.stateOf(conv.id), 'starting')
  assert.equal(supervisor.spawned.length, 2)
  assert.notEqual(supervisor.spawned[1].id, supervisor.spawned[0].id, 'fresh session id per spawn')
  assert.notEqual(supervisor.spawned[1].env.CHANNEL_TOKEN, supervisor.spawned[0].env.CHANNEL_TOKEN)

  const { ws } = await attach(hub, conv.id)
  const pushes = ws.frames('push')
  assert.equal(pushes.length, 1, 'exactly one seed push')
  assert.match(pushes[0].content, /\[conversation resumed\]/)
  assert.match(pushes[0].content, /\[user\] La capitale de la Bavière \?/)
  assert.match(pushes[0].content, /\[assistant\] Munich\./)
  assert.match(pushes[0].content, /\[user\] Et sa population \?$/)
  assert.equal(pushes[0].meta.seed, 'true')
})

test('channel drop parks the token; the SAME runtime can re-claim; exited runtime reaps to dormant', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  const first = await attach(hub, conv.id)
  assert.equal(hub.stateOf(conv.id), 'live')

  // transient drop (hub keeps the session running) → token parked, re-hello works
  first.ws.close()
  await new Promise((r) => setImmediate(r))
  assert.equal(hub.stateOf(conv.id), 'starting') // parked, awaiting re-claim
  const again = new FakeWs()
  assert.equal(hub.attachChannel(again, helloMsg({ conversationId: conv.id, token: first.token })), true)
  assert.equal(hub.stateOf(conv.id), 'live')

  // now the runtime truly dies: supervisor reports exited → reap to dormant
  const sessionId = supervisor.spawned[0].id
  supervisor.statuses.set(sessionId, { status: 'exited', exitCode: 0 })
  again.close()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.stateOf(conv.id), 'dormant')
})

test('liveness reconcile tears down a stale-green pipe (runtime gone under a live socket)', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  const { ws } = await attach(hub, conv.id)
  assert.equal(hub.stateOf(conv.id), 'live')

  // the runtime dies but the channel socket does NOT drop (the stale-green bug):
  // the supervisor no longer knows the session → the liveness net must tear it down.
  supervisor.statuses.delete(supervisor.spawned[0].id)
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv.id), 'dormant')
  assert.equal(ws.readyState, 3, 'the stale socket was closed')
})

test('liveness reconcile surfaces a crashed runtime as error', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  await attach(hub, conv.id)
  // non-zero exit under a live pipe = a crash → error (a clean exit / gone → dormant)
  supervisor.statuses.set(supervisor.spawned[0].id, { status: 'exited', exitCode: 1 })
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv.id), 'error')
})

test('idle-reap: supervisor forgets the session (404) → channel drops → dormant, not stuck starting', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  const { ws } = await attach(hub, conv.id)
  assert.equal(hub.stateOf(conv.id), 'live')

  // the supervisor idle-reaps: it KILLS + FORGETS the session (→ status 404), and the
  // channel WS then drops. The ws-close handler re-parks in pending; #reapIfExited must
  // read the 404 as "gone" and clear it → dormant (before the fix it stuck at 'starting').
  supervisor.statuses.delete(supervisor.spawned[0].id)
  ws.close()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.stateOf(conv.id), 'dormant')
})

test('runtime crash (non-zero exit) → channel drops → error', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  const { ws } = await attach(hub, conv.id)
  supervisor.statuses.set(supervisor.spawned[0].id, { status: 'exited', exitCode: 137 })
  ws.close()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.stateOf(conv.id), 'error')
})

test('delete kills, removes, and broadcasts', async () => {
  const { store, supervisor, hub, client } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  await attach(hub, conv.id)
  await hub.deleteConversation(conv.id)
  assert.equal(store.get(conv.id), undefined)
  assert.equal(supervisor.killed.length, 1)
  assert.ok(client.frames('conv_deleted').some((f) => f.conversationId === conv.id))
})

test('hub restart: reconcile re-arms persisted leases; re-claim does NOT re-seed', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'retiens le mot: zèbre')
  const { token } = await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'noté' }))
  assert.deepEqual(store.get(conv.id).pipe, { token, sessionId: supervisor.spawned[0].id })

  // "restart": a brand-new hub over the same store/supervisor (empty memory)
  const hub2 = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test', log: () => {} })
  clearInterval(hub2.sweeper)
  await hub2.reconcile()
  assert.equal(hub2.stateOf(conv.id), 'starting') // parked, awaiting re-hello

  const ws = new FakeWs()
  assert.equal(hub2.attachChannel(ws, helloMsg({ conversationId: conv.id, token })), true)
  assert.equal(hub2.stateOf(conv.id), 'live')
  assert.equal(ws.frames('push').length, 0, 're-claimed runtime must NOT be seeded')

  // messages flow again through the re-claimed pipe
  await hub2.sendUserMessage(conv.id, 'quel était le mot ?')
  assert.equal(ws.frames('push').length, 1)
  assert.equal(ws.frames('push')[0].content, 'quel était le mot ?')
})

test('reconcile clears leases of dead runtimes; close works from the lease after restart', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv.id, 'x')
  await attach(hub, conv.id)
  const sessionId = supervisor.spawned[0].id

  // runtime died while the hub was away
  supervisor.statuses.set(sessionId, { status: 'exited', exitCode: 1 })
  const hub2 = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test', log: () => {} })
  clearInterval(hub2.sweeper)
  await hub2.reconcile()
  assert.equal(hub2.stateOf(conv.id), 'dormant')
  assert.equal(store.get(conv.id).pipe, undefined)

  // and a still-running one can be closed via the persisted lease alone
  const conv2 = await hub.createConversation({ kind: 'claude' })
  await hub.sendUserMessage(conv2.id, 'y')
  const hub3 = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test', log: () => {} })
  clearInterval(hub3.sweeper)
  await hub3.closeConversation(conv2.id)
  assert.ok(supervisor.killed.includes(supervisor.spawned[1].id))
})

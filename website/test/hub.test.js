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
  constructor() { this.spawned = []; this.killed = []; this.touched = []; this.statuses = new Map(); this.anchorsDeleted = []; this.spawnErrors = [] }
  async kinds() { return ['claude'] }
  /** Queue an error to throw on the NEXT spawn() call (shift order) — lets a test simulate a
   *  resume bet failing (409 anchor_transcript_missing) with fine-grained control over exactly
   *  which attempt(s) fail. */
  async spawn(spec) {
    if (this.spawnErrors.length > 0) throw this.spawnErrors.shift()
    this.spawned.push(spec)
    this.statuses.set(spec.id, { status: 'running' })
    return spec
  }
  async kill(id) { this.killed.push(id); this.statuses.delete(id); return { id, killed: true } }
  async list() { return [...this.statuses].map(([id, s]) => ({ id, ...s })) }
  async touch(id) { this.touched.push(id); return this.statuses.has(id) }
  async status(id) {
    const s = this.statuses.get(id)
    if (!s) { const e = new Error('not found'); e.status = 404; throw e }
    return { id, ...s }
  }
  async anchorsDelete(uuids) { this.anchorsDeleted.push(...uuids) }
}

function rig(opts = {}) {
  const store = new ConversationStore()
  const supervisor = new FakeSupervisor()
  const hub = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test/ws/channel', log: () => {}, ...opts })
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

test('a conversation is born WITH its first message (ADR 0010): spawn, hello, plain push, reply', async () => {
  const { store, supervisor, hub, client } = rig()
  const conv = await hub.startConversation('salut', { kind: 'claude' })

  assert.equal(store.get(conv.id).messages.length, 1, 'first message persisted at birth')
  assert.equal(store.get(conv.id).title, 'salut', 'title derives from the first user turn')
  assert.equal(hub.stateOf(conv.id), 'starting')
  assert.equal(supervisor.spawned.length, 1)
  const spec = supervisor.spawned[0]
  assert.ok(spec.args.includes('--channels') && spec.args.includes('plugin:agora@agora'))
  // a deterministic native UUID is passed so the supervisor can read the resolved model / --resume
  const native = spec.args[spec.args.indexOf('--session-id') + 1]
  assert.match(native, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(spec.env.CHANNEL_CONVERSATION_ID, conv.id)
  assert.equal(spec.env.CHANNEL_HUB_URL, 'ws://test/ws/channel')
  assert.ok(spec.env.CHANNEL_TOKEN.length > 10)
  // the spawn was journalled as a run (ADR 0010): id doubles as the supervisor session id
  const run = store.getRun(conv.id, spec.id)
  assert.ok(run, 'run journalled at spawn')
  assert.equal(run.kind, 'claude')
  assert.equal(run.nativeSessionId, native)
  assert.equal(run.resume, false)

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
  assert.equal(messages[1].runId, spec.id, 'the assistant message points at its producing run')
  assert.ok(client.frames('message').some((f) => f.message.role === 'assistant'))
  assert.ok(client.frames('typing').some((f) => f.active === false))
})

test('substrate flows from platform policy into the spawn call, and is never persisted on the run', async () => {
  // Default policy = shared: the spawn carries substrate:'shared' + the opaque group id...
  const shared = rig()
  const sConv = await shared.hub.startConversation('un', { kind: 'claude' })
  assert.equal(shared.supervisor.spawned[0].substrate, 'shared')
  assert.equal(shared.supervisor.spawned[0].group, sConv.id, 'group is the opaque conversation id, never interpreted')
  // ...but the run journals no substrate — placement is not a stored fact (ADR 0011 superseded)
  assert.equal(shared.store.getRun(sConv.id, shared.supervisor.spawned[0].id).substrate, undefined)

  // A hub whose platform default is isolated spawns isolated — same conversation code path,
  // the difference is pure policy, decided at spawn, not a conversation attribute.
  const iso = rig({ substrateDefault: 'isolated' })
  const iConv = await iso.hub.startConversation('deux', { kind: 'claude' })
  assert.equal(iso.supervisor.spawned[0].substrate, 'isolated')
  assert.equal(iso.supervisor.spawned[0].group, iConv.id)
  assert.equal(iso.store.getRun(iConv.id, iso.supervisor.spawned[0].id).substrate, undefined)
  assert.equal(iso.store.get(iConv.id).substrate, undefined, 'the conversation stores no substrate either')
})

test('a reply moves the anchor (ADR 0007/0010); a spawn without a reply leaves it untouched', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  const spec = supervisor.spawned[0]
  const nativeUuid = spec.args[spec.args.indexOf('--session-id') + 1]

  assert.deepEqual(store.get(conv.id).anchors, {}, 'no anchor before any reply — spawn alone must not set it')
  await attach(hub, conv.id)
  assert.deepEqual(store.get(conv.id).anchors, {}, 'still nothing — attach/ready is not a reply either')

  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  const seqAfterFirst = store.get(conv.id).seq
  assert.deepEqual(store.get(conv.id).anchors.claude, { runId: spec.id, syncedSeq: seqAfterFirst })

  // a second turn on the SAME runtime bumps syncedSeq but keeps pointing at the same run
  await hub.sendUserMessage(conv.id, 'deux')
  await hub.onChannelReply(conv.id, replyMsg({ text: 'encore' }))
  assert.equal(store.get(conv.id).anchors.claude.runId, spec.id)
  assert.ok(store.get(conv.id).anchors.claude.syncedSeq > seqAfterFirst)

  // the runtime dies; the next spawn RESUMES the anchored native session (new run, same uuid) —
  // and since it never replies, the anchor keeps pointing at the PROVEN run
  const anchorBefore = { ...store.get(conv.id).anchors.claude }
  await hub.closeConversation(conv.id)
  await hub.sendUserMessage(conv.id, 'trois')
  assert.equal(supervisor.spawned.length, 2)
  const spec2 = supervisor.spawned[1]
  assert.ok(spec2.args.includes('--resume'), 'an anchor exists → the new run resumes it')
  assert.equal(spec2.args[spec2.args.indexOf('--resume') + 1], nativeUuid)
  assert.equal(store.getRun(conv.id, spec2.id).nativeSessionId, nativeUuid, 'the new run inherits the native uuid')
  assert.deepEqual(store.get(conv.id).anchors.claude, anchorBefore, 'no reply yet ⇒ prior anchor untouched')
})

test('bad token / unknown conversation are rejected', async () => {
  const { hub } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })

  const bad = new FakeWs()
  assert.equal(hub.attachChannel(bad, helloMsg({ conversationId: conv.id, token: 'WRONG' })), false)
  assert.equal(bad.frames('err')[0].code, 'bad_token')

  const ghost = new FakeWs()
  assert.equal(hub.attachChannel(ghost, helloMsg({ conversationId: 'c-ghost', token: 'x' })), false)
  assert.equal(ghost.frames('err')[0].code, 'unknown_conversation')
})

test('live conversation pushes immediately (same config = same run); close kills the session', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  const { ws } = await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))

  await hub.sendUserMessage(conv.id, 'deux')
  assert.equal(ws.frames('push').length, 2)
  assert.equal(supervisor.spawned.length, 1, 'no config change → same run')

  await hub.closeConversation(conv.id)
  assert.equal(supervisor.killed.length, 1)
  assert.equal(hub.stateOf(conv.id), 'dormant')
})

test('reopening after one reply resumes with an EMPTY delta — plain push, no seed frame (ADR 0007)', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('La capitale de la Bavière ?', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'Munich.' }))
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'Et sa population ?')
  assert.equal(hub.stateOf(conv.id), 'starting')
  assert.equal(supervisor.spawned.length, 2)
  assert.notEqual(supervisor.spawned[1].id, supervisor.spawned[0].id, 'fresh run id per spawn')
  assert.notEqual(supervisor.spawned[1].env.CHANNEL_TOKEN, supervisor.spawned[0].env.CHANNEL_TOKEN)
  // a proven anchor exists from the first reply → this spawn RESUMES the same native session
  const firstNative = supervisor.spawned[0].args[supervisor.spawned[0].args.indexOf('--session-id') + 1]
  assert.ok(supervisor.spawned[1].args.includes('--resume'))
  assert.equal(supervisor.spawned[1].args[supervisor.spawned[1].args.indexOf('--resume') + 1], firstNative)
  assert.ok(!supervisor.spawned[1].args.includes('--session-id'), 'same-file branch: no --session-id alongside --resume')

  const { ws } = await attach(hub, conv.id)
  const pushes = ws.frames('push')
  assert.equal(pushes.length, 1, 'exactly one push')
  // nothing was missed since the anchor (the resumed session already holds turn 1 itself) —
  // a plain push, never a seed frame
  assert.equal(pushes[0].content, 'Et sa population ?')
  assert.equal(pushes[0].meta.seed, undefined)
})

test('resume with a NON-EMPTY delta: one delta-seed push (missed turns only, never full history)', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok un' }))
  await hub.sendUserMessage(conv.id, 'deux')
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok deux' }))
  // simulate the anchor lagging (still the SAME run, just behind on syncedSeq) — realistic if
  // an earlier anchor update raced with more turns; constructed directly here since the point
  // is to exercise computeDelta's non-empty branch deterministically
  const run1 = supervisor.spawned[0].id
  await store.setAnchor(conv.id, 'claude', { runId: run1, syncedSeq: 2 })
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'trois')
  const spec = supervisor.spawned[supervisor.spawned.length - 1]
  assert.ok(spec.args.includes('--resume'))

  const { ws } = await attach(hub, conv.id)
  const pushes = ws.frames('push')
  assert.equal(pushes.length, 1)
  assert.match(pushes[0].content, /^\[conversation resumed — native session restored\]/)
  assert.match(pushes[0].content, /<missed-turns>/)
  assert.match(pushes[0].content, /\[user\] deux/)
  assert.match(pushes[0].content, /\[assistant\] ok deux/)
  assert.doesNotMatch(pushes[0].content, /<history>/)
  assert.match(pushes[0].content, /\[user\] trois$/)

  // the reply after resuming moves the anchor to the NEW run — which carries the SAME native uuid
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok trois' }))
  assert.equal(store.get(conv.id).anchors.claude.runId, spec.id)
  assert.equal(store.getRun(conv.id, spec.id).nativeSessionId, store.getRun(conv.id, run1).nativeSessionId)
  assert.ok(store.get(conv.id).anchors.claude.syncedSeq > 2)
})

test('resume-death fallback: a dead anchor (before any hello) falls back to fresh + full re-seed', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'deux')
  assert.ok(supervisor.spawned[1].args.includes('--resume'))

  // the resumed session dies (missing transcript, say) BEFORE any channel ever attaches —
  // reconcileLiveness's pending loop must catch it (aged past the spawn-settle window:
  // absence from the supervisor's list only reads as death once the POST can't be in flight)
  supervisor.statuses.delete(supervisor.spawned[1].id)
  hub.pending.get(conv.id).since -= 10_000
  await hub.reconcileLiveness()

  assert.equal(store.get(conv.id).anchors.claude, undefined, 'the dead anchor is cleared')
  assert.equal(supervisor.spawned.length, 3, 'the fallback spawned a third attempt')
  assert.ok(supervisor.spawned[2].args.includes('--session-id'))
  assert.ok(!supervisor.spawned[2].args.includes('--resume'), 'the retry is fresh, never another resume')

  const { ws } = await attach(hub, conv.id)
  const pushes = ws.frames('push')
  assert.equal(pushes.length, 1)
  assert.match(pushes[0].content, /^\[conversation resumed\]/, 'anchor 0 ⇒ the ADR 0005 floor: full history')
  assert.match(pushes[0].content, /<history>/)
})

test('resume-death fallback caps at ONE automatic retry per send', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'deux')
  supervisor.statuses.delete(supervisor.spawned[1].id)
  hub.pending.get(conv.id).since -= 10_000
  await hub.reconcileLiveness() // → fallback spawns a third, fresh attempt
  assert.equal(supervisor.spawned.length, 3)

  // that fresh retry ALSO dies before ever attaching — must NOT trigger a second automatic retry
  supervisor.statuses.delete(supervisor.spawned[2].id)
  hub.pending.get(conv.id).since -= 10_000
  await hub.reconcileLiveness()
  assert.equal(supervisor.spawned.length, 3, 'no further automatic spawn — follows the normal error paths')
})

test('409 anchor_transcript_missing (synchronous, from the manager): one forceFresh retry, then succeeds', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  const err409 = Object.assign(new Error('supervisor POST /sessions → 409: anchor_transcript_missing'), { status: 409 })
  supervisor.spawnErrors.push(err409) // the resume bet itself fails synchronously, at spawn time

  await hub.sendUserMessage(conv.id, 'deux')

  assert.equal(store.get(conv.id).anchors.claude, undefined, 'the dead anchor is cleared, like any other fallback')
  assert.equal(hub.stateOf(conv.id), 'starting', 'the retry succeeded — never surfaced as error')
  assert.equal(supervisor.spawned.length, 2, 'only the successful forceFresh retry is recorded (the 409 threw before ever being pushed)')
  assert.ok(supervisor.spawned[1].args.includes('--session-id'))
  assert.ok(!supervisor.spawned[1].args.includes('--resume'), 'forceFresh — never bets on the missing anchor again')
})

test('409 anchor_transcript_missing: exactly one retry — a second 409 surfaces as spawn_failed', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  const spawnedBefore = supervisor.spawned.length // the birth spawn above already succeeded once
  const err409 = () => Object.assign(new Error('supervisor POST /sessions → 409: anchor_transcript_missing'), { status: 409 })
  supervisor.spawnErrors.push(err409(), err409()) // both the resume bet AND the forceFresh retry fail

  await hub.sendUserMessage(conv.id, 'deux')

  assert.equal(hub.stateOf(conv.id), 'error')
  assert.match(store.get(conv.id).error.reason, /spawn_failed/)
  assert.equal(supervisor.spawned.length, spawnedBefore, 'neither reopen attempt ever reached a running state')
})

test('a pending absent from the supervisor list right after spawn is NOT judged dead (settle window)', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'deux') // resume attempt, pending entry seconds old
  supervisor.statuses.delete(supervisor.spawned[1].id)
  await hub.reconcileLiveness() // absence ≠ death while the spawn POST could still be in flight
  assert.equal(supervisor.spawned.length, 2, 'no premature fallback inside the settle window')
  assert.equal(hub.stateOf(conv.id), 'starting')
})

test('isolated substrate: an in-flight spawn survives well past the plain settle window', async () => {
  // Incident 2026-07-05 (P4.1, live): the manager's get-or-create-loge dance can legitimately
  // take far longer than the shared substrate's near-instant spawn — a liveness tick firing
  // mid-spawn must not judge it dead just because SPAWN_SETTLE_MS (tuned for `shared`) elapsed.
  // The settle-window choice keys off the resolved policy stashed in the pending entry, not a
  // stored conversation attribute — so an isolated-policy hub gets the long window.
  const { supervisor, hub } = rig({ substrateDefault: 'isolated' })
  const conv = await hub.startConversation('un', { kind: 'claude' })
  assert.equal(hub.pending.get(conv.id).isolated, true, 'pending entry reflects the resolved isolated policy')

  supervisor.statuses.delete(supervisor.spawned[0].id) // still absent from the list: loge not ready yet
  hub.pending.get(conv.id).since -= 10_000 // past the plain 5s SPAWN_SETTLE_MS, well within the isolated one
  await hub.reconcileLiveness()

  assert.equal(hub.stateOf(conv.id), 'starting', 'still legitimately spawning — must not be judged dead yet')
  assert.equal(hub.pending.has(conv.id), true)
})

test('shared substrate: the same 10s absence IS already a verdict (contrast case)', async () => {
  const { supervisor, hub } = rig() // default policy = shared
  const conv = await hub.startConversation('un', { kind: 'claude' })
  assert.equal(hub.pending.get(conv.id).isolated, false, 'pending entry reflects the resolved shared policy')

  supervisor.statuses.delete(supervisor.spawned[0].id)
  hub.pending.get(conv.id).since -= 10_000
  await hub.reconcileLiveness()

  assert.equal(hub.stateOf(conv.id), 'dormant', 'shared spawns settle fast — 10s absence is a real verdict')
})

test('slow boot: a running-but-unattached pending is left alone under the cap; the late hello then attaches correctly', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  // claude is booting slowly (host contention): session running, no channel, 5 min in
  hub.pending.get(conv.id).since -= 300_000
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv.id), 'starting', 'running means booting, not dead — keep waiting')
  assert.equal(supervisor.killed.length, 0)

  // the late hello finds its pending intact (token + seed decision + flags) and works normally
  const { ws, ok } = await attach(hub, conv.id)
  assert.equal(ok, true)
  assert.equal(hub.stateOf(conv.id), 'live')
  assert.equal(ws.frames('push')[0].content, 'un')
})

test('a running runtime whose channel never attaches is abandoned at the cap: visible error, no kill, zombie fenced', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  const token = hub.pending.get(conv.id).token
  hub.pending.get(conv.id).since -= 700_000 // past the 10 min attach cap
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv.id), 'error', 'after minutes of `starting`, the give-up must be visible')
  assert.equal(store.get(conv.id).live, undefined, 'lease cleared')
  assert.equal(supervisor.killed.length, 0, 'no lifecycle kill (ADR 0008) — the supervisor idle-reaps')

  // a hello arriving after the abandon is fenced out (its token no longer matches anything)
  const late = new FakeWs()
  assert.equal(hub.attachChannel(late, helloMsg({ conversationId: conv.id, token })), false)
  assert.equal(late.frames('err')[0].code, 'bad_token')

  // a new user message clears the error and starts a fresh attempt, like any other error
  await hub.sendUserMessage(conv.id, 'deux')
  assert.equal(hub.stateOf(conv.id), 'starting')
  assert.equal(supervisor.spawned.length, 2)
})

test('a fresh spawn that dies before its channel ever attaches is classified within a poll tick', async () => {
  const { supervisor, hub } = rig()
  // crash (exit code reported by the supervisor) → error, no settle window needed
  const conv = await hub.startConversation('un', { kind: 'claude' })
  supervisor.statuses.set(supervisor.spawned[0].id, { status: 'exited', exitCode: 1 })
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv.id), 'error')

  // gone without a trace (reaped/forgotten) → dormant, once past the settle window
  const conv2 = await hub.startConversation('deux', { kind: 'claude' })
  supervisor.statuses.delete(supervisor.spawned[1].id)
  hub.pending.get(conv2.id).since -= 10_000
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv2.id), 'dormant')
})

test('a resume that attaches (and goes ready) but crashes before ever replying still falls back to fresh', async () => {
  // The channel/MCP layer can connect in tens of ms — well before claude's own --resume logic
  // discovers a missing transcript and exits. This reproduces that: the death is discovered via
  // the ws-close path (#reapIfExited), not the pending-scan, and must not get stuck as a permanent
  // `error` pointing at a dead anchor (every retry would otherwise resume the same dead uuid).
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  await hub.sendUserMessage(conv.id, 'deux')
  assert.ok(supervisor.spawned[1].args.includes('--resume'))
  const { ws } = await attach(hub, conv.id) // attaches + ready — but never replies

  // the resumed process crashes right after attaching; its stdio closing is what the channel
  // reports as its own ws dropping
  supervisor.statuses.set(supervisor.spawned[1].id, { status: 'exited', exitCode: 1 })
  ws.close()
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(store.get(conv.id).anchors.claude, undefined, 'dead anchor cleared, not left dangling')
  assert.equal(supervisor.spawned.length, 3, 'fell back to a third, fresh attempt')
  assert.ok(supervisor.spawned[2].args.includes('--session-id'))
  assert.ok(!supervisor.spawned[2].args.includes('--resume'))
  assert.notEqual(hub.stateOf(conv.id), 'error', 'never surfaces as a stuck error')
})

test('an anchor for a different kind is invisible — no anchor found ⇒ fresh + full seed (anchor 0)', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok' }))
  await hub.closeConversation(conv.id)

  // a DIFFERENT harness kind has its own anchor (anchors are keyed per kind) — it must be
  // invisible when this conv reopens as claude, same as if it had never resumed before
  await store.setAnchor(conv.id, 'codex', { runId: 'not-a-real-run', syncedSeq: 99 })
  await store.clearAnchor(conv.id, 'claude')

  await hub.sendUserMessage(conv.id, 'deux')
  const spec = supervisor.spawned[supervisor.spawned.length - 1]
  assert.ok(spec.args.includes('--session-id'), 'fresh — the codex anchor does not apply to claude')
  assert.ok(!spec.args.includes('--resume'))

  const { ws } = await attach(hub, conv.id)
  const pushes = ws.frames('push')
  assert.match(pushes[0].content, /^\[conversation resumed\]/)
  assert.match(pushes[0].content, /<history>/)
})

test('channel drop parks the token; the SAME runtime can re-claim; exited runtime reaps to dormant', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })
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
  const runId = supervisor.spawned[0].id
  supervisor.statuses.set(runId, { status: 'exited', exitCode: 0 })
  again.close()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.stateOf(conv.id), 'dormant')
})

test('liveness reconcile tears down a stale-green pipe (runtime gone under a live socket)', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })
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
  const conv = await hub.startConversation('x', { kind: 'claude' })
  await attach(hub, conv.id)
  // non-zero exit under a live pipe = a crash → error (a clean exit / gone → dormant)
  supervisor.statuses.set(supervisor.spawned[0].id, { status: 'exited', exitCode: 1 })
  await hub.reconcileLiveness()
  assert.equal(hub.stateOf(conv.id), 'error')
})

test('idle-reap: supervisor forgets the session (404) → channel drops → dormant, not stuck starting', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })
  const { ws } = await attach(hub, conv.id)
  assert.equal(hub.stateOf(conv.id), 'live')

  // the supervisor idle-reaps: it KILLS + FORGETS the session (→ status 404), and the
  // channel WS then drops. The ws-close handler re-parks in pending; #reapIfExited must
  // read the 404 as "gone" and clear it → dormant.
  supervisor.statuses.delete(supervisor.spawned[0].id)
  ws.close()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.stateOf(conv.id), 'dormant')
})

test('runtime crash (non-zero exit) → channel drops → error', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })
  const { ws } = await attach(hub, conv.id)
  supervisor.statuses.set(supervisor.spawned[0].id, { status: 'exited', exitCode: 137 })
  ws.close()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.stateOf(conv.id), 'error')
})

test('delete kills, removes, and broadcasts', async () => {
  const { store, supervisor, hub, client } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })
  await attach(hub, conv.id)
  const nativeSessionId = store.get(conv.id).runs[0].nativeSessionId
  await hub.deleteConversation(conv.id)
  assert.equal(store.get(conv.id), undefined)
  assert.equal(supervisor.killed.length, 1)
  assert.ok(client.frames('conv_deleted').some((f) => f.conversationId === conv.id))
  // agora ADR 0011 / agent-runtime ADR 0010 §4: best-effort purge of the manager's anchor custody
  assert.deepEqual(supervisor.anchorsDeleted, [nativeSessionId])
})

test('hub restart: reconcile re-arms persisted leases; re-claim does NOT re-seed', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('retiens le mot: zèbre', { kind: 'claude' })
  const { token } = await attach(hub, conv.id)
  const runId = supervisor.spawned[0].id
  const nativeUuid = supervisor.spawned[0].args[supervisor.spawned[0].args.indexOf('--session-id') + 1]
  await hub.onChannelReply(conv.id, replyMsg({ text: 'noté' }))
  assert.deepEqual(store.get(conv.id).live, { runId, token })

  // "restart": a brand-new hub over the same store/supervisor (empty memory)
  const hub2 = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test', log: () => {} })
  await hub2.reconcile()
  assert.equal(hub2.stateOf(conv.id), 'starting') // parked, awaiting re-hello

  const ws = new FakeWs()
  assert.equal(hub2.attachChannel(ws, helloMsg({ conversationId: conv.id, token })), true)
  assert.equal(hub2.stateOf(conv.id), 'live')
  assert.equal(ws.frames('push').length, 0, 're-claimed runtime must NOT be seeded')

  // messages flow again through the re-claimed pipe — the anchor keeps tracking the SAME
  // run across the restart (the persisted lease carries the runId through re-claim)
  await hub2.sendUserMessage(conv.id, 'quel était le mot ?')
  assert.equal(ws.frames('push').length, 1)
  assert.equal(ws.frames('push')[0].content, 'quel était le mot ?')
  await hub2.onChannelReply(conv.id, replyMsg({ text: 'zèbre' }))
  assert.equal(store.get(conv.id).anchors.claude.runId, runId, 'anchor survives the hub restart')
  assert.equal(store.getRun(conv.id, runId).nativeSessionId, nativeUuid)
})

test('reconcile clears leases of dead runtimes; close works from the lease after restart', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('x', { kind: 'claude' })
  await attach(hub, conv.id)
  const runId = supervisor.spawned[0].id

  // runtime died while the hub was away
  supervisor.statuses.set(runId, { status: 'exited', exitCode: 1 })
  const hub2 = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test', log: () => {} })
  await hub2.reconcile()
  assert.equal(hub2.stateOf(conv.id), 'dormant')
  assert.equal(store.get(conv.id).live, undefined)

  // and a still-running one can be closed via the persisted lease alone
  const conv2 = await hub.startConversation('y', { kind: 'claude' })
  const hub3 = new Hub(store, supervisor, { hubUrlForChannels: 'ws://test', log: () => {} })
  await hub3.closeConversation(conv2.id)
  assert.ok(supervisor.killed.includes(supervisor.spawned[1].id))
})

test('a message with a DIFFERENT config kills the live runtime and respawns — resuming the anchor', async () => {
  const { store, supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude', model: 'sonnet' })
  await attach(hub, conv.id)
  const run1 = supervisor.spawned[0].id
  await hub.onChannelReply(conv.id, replyMsg({ text: 'réponse', replyTo: 'm1' }))

  // the next message asks for opus: the sonnet runtime is closed, a new run materialises the
  // config, and — the anchor having survived — it RESUMES the same native session
  await hub.sendUserMessage(conv.id, 'deux', { kind: 'claude', model: 'opus' })
  assert.deepEqual(supervisor.killed, [run1])
  assert.equal(supervisor.spawned.length, 2)
  const spec2 = supervisor.spawned[1]
  assert.equal(spec2.args[spec2.args.indexOf('--model') + 1], 'opus')
  assert.ok(spec2.args.includes('--resume'))
  assert.equal(store.getRun(conv.id, spec2.id).model, 'opus', 'the run journals the config as fact')
  assert.equal(hub.stateOf(conv.id), 'starting')

  // the pending message is re-delivered at attach — answered by the NEW config
  const { ws } = await attach(hub, conv.id)
  assert.equal(ws.frames('push').length, 1)
  assert.equal(ws.frames('push')[0].content, 'deux')
})

test('a message with the SAME config rides the live runtime — no kill, no respawn', async () => {
  const { supervisor, hub } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude', model: 'sonnet', effort: 'high' })
  const { ws } = await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok', replyTo: 'm1' }))

  await hub.sendUserMessage(conv.id, 'deux', { kind: 'claude', model: 'sonnet', effort: 'high' })
  assert.equal(supervisor.killed.length, 0)
  assert.equal(supervisor.spawned.length, 1)
  assert.equal(ws.frames('push').length, 2)

  // omitted config is sticky too (no comparison, plain push)
  await hub.sendUserMessage(conv.id, 'trois')
  assert.equal(supervisor.spawned.length, 1)
  assert.equal(ws.frames('push').length, 3)
})

test('title/pinned patch never touches the runtime; summary derives config from the last run', async () => {
  const { supervisor, hub, store } = rig()
  const conv = await hub.startConversation('un', { kind: 'claude', model: 'sonnet', effort: 'high' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'ok', replyTo: 'm1' }))

  await hub.patchConversation(conv.id, { title: 'renommée', pinned: true })
  assert.equal(supervisor.killed.length, 0)
  assert.equal(store.get(conv.id).title, 'renommée')

  const s = hub.summary(store.get(conv.id))
  assert.equal(s.kind, 'claude')
  assert.equal(s.model, 'sonnet')
  assert.equal(s.effort, 'high')
})

test('onChannelSetTitle records the topic as a fact on the live run; summary derives it', async () => {
  const { store, hub } = rig()
  const conv = await hub.startConversation('parle-moi du kouign-amann et de son histoire', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'volontiers' }))

  await hub.onChannelSetTitle(conv.id, { title: '  Histoire du kouign-amann  ' })
  assert.equal(hub.summary(store.get(conv.id)).title, 'Histoire du kouign-amann', 'trimmed, derived in summary')
  assert.equal(store.get(conv.id).runs[0].nativeTitle, 'Histoire du kouign-amann', 'a fact on the run')
  assert.match(store.get(conv.id).title, /^parle-moi du kouign/, 'stored auto title untouched')

  // no live pipe (dormant) → a stray frame is ignored, never crashes
  await hub.closeConversation(conv.id)
  await hub.onChannelSetTitle(conv.id, { title: 'trop tard' })
  assert.equal(hub.summary(store.get(conv.id)).title, 'Histoire du kouign-amann')
})

test('the conversation names itself: pty title → run nativeTitle → summary; a manual rename wins for good', async () => {
  const { store, supervisor, hub } = rig()
  clearInterval(hub.liveness)
  const conv = await hub.startConversation('parle-moi des fromages de Bretagne s il te plait', { kind: 'claude' })
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 'volontiers' }))
  const run1 = supervisor.spawned[0].id
  assert.match(hub.summary(store.get(conv.id)).title, /^parle-moi des fromages/, 'floor: first-message truncation')

  // the supervisor reports the topic claude titled its tab with → fact on the run, display derives
  supervisor.statuses.get(run1).title = 'Fromages bretons'
  await hub.reconcileLiveness()
  assert.equal(hub.summary(store.get(conv.id)).title, 'Fromages bretons')
  assert.notEqual(store.get(conv.id).title, 'Fromages bretons', 'stored auto title untouched — display is derived')

  // a config switch spawns r2, which has not titled itself yet → the newest titled run still shows
  await hub.sendUserMessage(conv.id, 'et en opus ?', { kind: 'claude', model: 'opus' })
  assert.equal(hub.summary(store.get(conv.id)).title, 'Fromages bretons')

  // r2 titles itself in turn → newest titled run wins
  await attach(hub, conv.id)
  const run2 = supervisor.spawned[1].id
  supervisor.statuses.get(run2).title = 'Fromages bretons, la suite'
  await hub.reconcileLiveness()
  assert.equal(hub.summary(store.get(conv.id)).title, 'Fromages bretons, la suite')

  // a manual rename outranks any native title, including future ones
  await hub.patchConversation(conv.id, { title: 'Kig ha farz' })
  supervisor.statuses.get(run2).title = 'Autre sujet'
  await hub.reconcileLiveness()
  assert.equal(hub.summary(store.get(conv.id)).title, 'Kig ha farz')
})

test('resolvedModel lives on the run; messages and summary derive it (no stamping, no backfill)', async () => {
  const { store, supervisor, hub } = rig()
  clearInterval(hub.liveness)
  const conv = await hub.startConversation('un', { kind: 'claude', model: 'sonnet' })
  await attach(hub, conv.id)
  const run1 = supervisor.spawned[0].id

  // reply lands BEFORE the supervisor could read the transcript — nothing is lost:
  // the message points at its run; the value arrives on the run later
  await hub.onChannelReply(conv.id, replyMsg({ text: 'réponse', replyTo: 'm1' }))
  assert.equal(store.get(conv.id).messages[1].runId, run1)
  assert.equal(hub.summary(store.get(conv.id)).resolvedModel, null, 'unknown until the run learns it')

  // next liveness tick: the supervisor reports the model → ONE write on the run,
  // and every message pointing at it is retroactively resolved
  supervisor.statuses.get(run1).model = 'claude-sonnet-5'
  await hub.reconcileLiveness()
  assert.equal(store.getRun(conv.id, run1).resolvedModel, 'claude-sonnet-5')
  assert.equal(hub.summary(store.get(conv.id)).resolvedModel, 'claude-sonnet-5')

  // a config switch spawns run2 (opus): per-message truth stays per-run
  await hub.sendUserMessage(conv.id, 'deux', { kind: 'claude', model: 'opus' })
  const run2 = supervisor.spawned[1].id
  await attach(hub, conv.id)
  await hub.onChannelReply(conv.id, replyMsg({ text: 're', replyTo: 'm3' }))
  supervisor.statuses.get(run2).model = 'claude-opus-4-8'
  await hub.reconcileLiveness()
  const msgs = store.get(conv.id).messages
  assert.equal(store.getRun(conv.id, msgs[1].runId).resolvedModel, 'claude-sonnet-5')
  assert.equal(store.getRun(conv.id, msgs[3].runId).resolvedModel, 'claude-opus-4-8')
  assert.equal(hub.summary(store.get(conv.id)).resolvedModel, 'claude-opus-4-8')
})

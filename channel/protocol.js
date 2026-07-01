/**
 * agora `shared/` — the WS protocol between the channel (pipe) and the website (hub),
 * plus the hub→browser-client event vocabulary (ADR 0003: shared/ = the protocol,
 * compiled into both artefacts; ADR 0005: the hub persists both sides as it streams).
 *
 * Wire shape is dictated by what the pipe actually carries (spike S1/S2):
 * whole user-facing turns — one clean `reply` per inbound push, no streaming.
 *
 * NOTE (delivery): the channel is copied out of the repo when installed as a plugin,
 * so it ships its own byte-identical copy of this file (`channel/protocol.js`).
 * `npm run sync-shared` refreshes it; a test asserts the copies never drift.
 */

export const PROTOCOL_VERSION = 1

/* ------------------------------------------------------------------ *
 *  channel ⟷ hub                                                      *
 * ------------------------------------------------------------------ */

/** channel → hub, first frame: claim the conversation this pipe serves. */
export function helloMsg({ conversationId, token, session }) {
  return { type: 'hello', v: PROTOCOL_VERSION, conversationId, token, session }
}

/** hub → channel: the claim is accepted; the pipe is live. */
export function helloOkMsg() {
  return { type: 'hello_ok', v: PROTOCOL_VERSION }
}

/** hub → channel: a user-facing message to push into the live session. */
export function pushMsg({ id, content, meta }) {
  return { type: 'push', id, content, meta: meta ?? {} }
}

/** channel → hub: the agent's outbound turn (its `reply` tool call). */
export function replyMsg({ text, replyTo, ts }) {
  return { type: 'reply', text, replyTo, ts: ts ?? new Date().toISOString() }
}

/** either direction: terminal error (the receiver may close the socket). */
export function errMsg(code, message) {
  return { type: 'err', code, message }
}

/* ------------------------------------------------------------------ *
 *  hub → browser client (push only; client actions go over REST)      *
 * ------------------------------------------------------------------ */

export function snapshotEvent(conversations) {
  return { type: 'snapshot', v: PROTOCOL_VERSION, conversations }
}

export function convEvent(conv) {
  return { type: 'conv', conv }
}

export function convDeletedEvent(conversationId) {
  return { type: 'conv_deleted', conversationId }
}

export function messageEvent(conversationId, message) {
  return { type: 'message', conversationId, message }
}

/** the agent is (or is no longer) working on a reply for this conversation. */
export function typingEvent(conversationId, active) {
  return { type: 'typing', conversationId, active }
}

/* ------------------------------------------------------------------ *
 *  Parsing / validation                                               *
 * ------------------------------------------------------------------ */

const CHANNEL_TO_HUB = {
  hello: (m) => typeof m.conversationId === 'string' && m.conversationId.length > 0
    && typeof m.token === 'string' && m.v === PROTOCOL_VERSION,
  reply: (m) => typeof m.text === 'string',
  err: (m) => typeof m.message === 'string',
}

const HUB_TO_CHANNEL = {
  hello_ok: () => true,
  push: (m) => typeof m.id === 'string' && typeof m.content === 'string',
  err: (m) => typeof m.message === 'string',
}

function parseWith(table, raw) {
  let msg
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'not a protocol message' }
  }
  const check = table[msg.type]
  if (!check) return { ok: false, error: `unknown type: ${msg.type}` }
  if (!check(msg)) return { ok: false, error: `malformed ${msg.type}` }
  return { ok: true, msg }
}

/** Parse a frame arriving at the hub from a channel. */
export function parseChannelFrame(raw) {
  return parseWith(CHANNEL_TO_HUB, raw)
}

/** Parse a frame arriving at the channel from the hub. */
export function parseHubFrame(raw) {
  return parseWith(HUB_TO_CHANNEL, raw)
}

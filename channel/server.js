#!/usr/bin/env node
/**
 * agora channel — the pipe between one claude runtime and the hub (ADR 0002).
 *
 * Two faces:
 *   - claude side: MCP server over stdio (claude spawns us), declaring the
 *     `claude/channel` capability. Inbound = `notifications/claude/channel`
 *     pushes into the live session; outbound = the `reply` tool.
 *   - hub side: a WS client to the website. The hub owns the history (ADR 0005);
 *     we relay whole turns, we store nothing.
 *
 * Config comes from the environment the supervisor set at spawn (CHANNEL_*):
 *   CHANNEL_HUB_URL          ws(s)://host:port/ws/channel
 *   CHANNEL_CONVERSATION_ID  the hub conversation this pipe serves
 *   CHANNEL_TOKEN            per-spawn secret proving we are the expected pipe
 *
 * Hub-down behaviour (spike S5 said this is OUR job): outbound replies are
 * buffered and re-delivered after reconnect; the WS client reconnects forever
 * with capped backoff. stdout is the MCP transport — logs go to stderr only.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, helloMsg, replyMsg, readyMsg, setTitleMsg, unresponsiveMsg, parseHubFrame } from './protocol.js'

const HUB_URL = process.env.CHANNEL_HUB_URL
const CONVERSATION_ID = process.env.CHANNEL_CONVERSATION_ID
const TOKEN = process.env.CHANNEL_TOKEN ?? ''

const LOG_FILE = process.env.CHANNEL_LOG // optional file sink (observability)
function log(event, data = {}) {
  const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`
  process.stderr.write(`[agora-channel] ${line}`)
  if (LOG_FILE) { try { appendFileSync(LOG_FILE, line) } catch { /* best effort */ } }
}

if (!HUB_URL || !CONVERSATION_ID) {
  log('fatal', { error: 'CHANNEL_HUB_URL and CHANNEL_CONVERSATION_ID are required' })
  process.exit(1)
}

/* ---------------------------------------------------------------- *
 *  claude face: the MCP channel server                              *
 * ---------------------------------------------------------------- */

const mcp = new Server(
  { name: 'agora', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'You are connected to agora, the web hub where your user talks to you. ' +
      `User messages arrive as <channel source="agora" chat_id="${CONVERSATION_ID}"> events. ` +
      'ALWAYS answer with the `reply` tool — anything you print outside of it never reaches the user. ' +
      'Reply once per user message, with your complete final answer (markdown is fine). ' +
      'Right after your FIRST reply, call `set_title` with a short topic naming this conversation; ' +
      'call it again only if the topic clearly changes later. ' +
      'A message may open with a [conversation resumed] block containing the prior history: treat it ' +
      'as your own past conversation and answer the new message in that context.',
  },
)

let claudeReady = false // claude has enumerated our tools → its loop can receive channel events

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!claudeReady) {
    claudeReady = true
    log('claude_ready')
    sendToHub(readyMsg()) // tell the hub the agent loop is up → conversation `starting` → `live`
    deliverInbound()
  }
  return {
    tools: [
      {
        name: 'reply',
        description:
          'Send your answer to the user on the agora hub. This is the ONLY way the user sees your ' +
          'response. Pass reply_to (the message_id of the user message) to correlate.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Your complete answer (markdown supported).' },
            reply_to: { type: 'string', description: 'message_id of the user message being answered.' },
          },
          required: ['text'],
        },
      },
      {
        name: 'set_title',
        description:
          'Name this conversation on the agora hub: a short topic label (3–6 words, no trailing ' +
          'punctuation) in the language of the conversation. Call it right after your FIRST reply, ' +
          'then again only when the topic clearly changes.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The topic label, e.g. "Migration de la table orders".' },
          },
          required: ['title'],
        },
      },
    ],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'set_title') {
    const title = String(req.params.arguments?.title ?? '').trim()
    if (!title) {
      return { content: [{ type: 'text', text: 'set_title needs a non-empty `title`' }], isError: true }
    }
    // orthogonal to the push/reply ack cycle: naming the conversation answers nothing
    const delivered = sendToHub(setTitleMsg({ title }))
    log('set_title', { title, delivered })
    return {
      content: [{ type: 'text', text: delivered ? 'title set' : 'queued (hub offline, will re-deliver)' }],
    }
  }
  if (req.params.name !== 'reply') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  const { text, reply_to } = req.params.arguments ?? {}
  if (typeof text !== 'string' || text.length === 0) {
    return { content: [{ type: 'text', text: 'reply needs a non-empty `text`' }], isError: true }
  }
  clearAck() // claude answered → stop re-delivering the pending inbound
  const frame = replyMsg({ text, replyTo: typeof reply_to === 'string' ? reply_to : undefined })
  const delivered = sendToHub(frame)
  log('reply', { chars: text.length, delivered })
  return {
    content: [{ type: 'text', text: delivered ? 'delivered' : 'queued (hub offline, will re-deliver)' }],
  }
})

/* ---------------------------------------------------------------- *
 *  hub face: WS client with reconnect + outbound buffer (S5)        *
 * ---------------------------------------------------------------- */

let ws = null
let ready = false // hello_ok received on the current socket
let attempts = 0
let closing = false
const outbox = [] // frames waiting for a live, hello_ok'd socket

/* Inbound delivery to claude, made robust against the STARTUP RACE: a channel
 * notification fired before claude's agent loop is ready is silently dropped
 * (spike: "events arrive only while the session is open"). We therefore (a) hold
 * inbound until claude proves ready by enumerating our tools (ListTools), and
 * (b) re-deliver the latest unanswered push a few times until claude's `reply`
 * acknowledges it. `reply` = the ack: the spike proved exactly one reply per
 * inbound, so a still-unanswered push after several seconds means it was dropped. */
const inboundQueue = []
let pendingAck = null // { push, tries, timer } awaiting a reply
const ACK_RETRY_MS = 9000
const ACK_MAX_TRIES = 3

function enqueueInbound(push) {
  inboundQueue.push(push)
  deliverInbound()
}

function deliverInbound() {
  if (!claudeReady) return
  while (inboundQueue.length > 0) {
    const push = inboundQueue.shift()
    notify(push)
    armAck(push)
  }
}

function notify(push) {
  Promise.resolve(mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: push.content,
      meta: {
        chat_id: CONVERSATION_ID,
        message_id: push.id,
        user: String(push.meta?.user ?? 'user'),
        ts: String(push.meta?.ts ?? new Date().toISOString()),
      },
    },
  })).catch((err) => log('notify_failed', { id: push.id, error: err?.message }))
}

function armAck(push) {
  clearAck()
  pendingAck = { push, tries: 0, timer: null }
  scheduleAck()
}

function scheduleAck() {
  if (!pendingAck) return
  pendingAck.timer = setTimeout(() => {
    if (!pendingAck) return
    if (pendingAck.tries >= ACK_MAX_TRIES) {
      log('ack_giveup', { id: pendingAck.push.id, tries: pendingAck.tries })
      sendToHub(unresponsiveMsg({ messageId: pendingAck.push.id, tries: pendingAck.tries }))
      clearAck()
      return
    }
    pendingAck.tries += 1
    log('redeliver', { id: pendingAck.push.id, try: pendingAck.tries })
    notify(pendingAck.push)
    scheduleAck()
  }, ACK_RETRY_MS)
  pendingAck.timer.unref?.()
}

function clearAck() {
  if (pendingAck?.timer) clearTimeout(pendingAck.timer)
  pendingAck = null
}

function sendToHub(frame) {
  if (ready && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame))
    return true
  }
  outbox.push(frame)
  return false
}

function flushOutbox() {
  while (outbox.length > 0 && ready && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outbox.shift()))
  }
  if (outbox.length === 0) log('outbox_flushed')
}

let reconnectTimer = null

function scheduleReconnect() {
  if (closing || reconnectTimer) return // one pending reconnect at a time
  attempts += 1
  const delay = Math.min(500 * 2 ** Math.min(attempts, 4), 8000)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
  reconnectTimer.unref?.()
}

function connect() {
  if (closing) return
  log('ws_connecting', { url: HUB_URL, attempt: attempts + 1 })
  const sock = new WebSocket(HUB_URL)
  ws = sock
  let settled = false // guard: 'error' and 'close' both fire — react to the pair once

  const onDown = (why) => (err) => {
    if (settled) return
    settled = true
    if (sock !== ws) return // a newer socket already superseded this one
    if (ready) log('ws_down', { why, error: err?.message })
    ready = false
    scheduleReconnect()
  }

  sock.on('open', () => {
    sock.send(JSON.stringify(helloMsg({ conversationId: CONVERSATION_ID, token: TOKEN })))
  })

  sock.on('message', (raw) => {
    const parsed = parseHubFrame(raw)
    if (!parsed.ok) {
      log('ws_bad_frame', { error: parsed.error })
      return
    }
    const msg = parsed.msg
    if (msg.type === 'hello_ok') {
      ready = true
      attempts = 0
      log('ws_ready', { v: PROTOCOL_VERSION })
      // on EVERY (re)connect, re-assert readiness if claude's loop is already up — a reconnect
      // (e.g. after a hub restart) re-claims the pipe as `starting` and needs telling we're ready.
      if (claudeReady) sendToHub(readyMsg())
      flushOutbox()
      return
    }
    if (msg.type === 'push') {
      log('push', { id: msg.id, chars: msg.content.length })
      enqueueInbound(msg)
      return
    }
    if (msg.type === 'err') {
      log('hub_error', { code: msg.code, message: msg.message })
      if (msg.code === 'bad_token' || msg.code === 'unknown_conversation') {
        // unrecoverable claim: reconnecting would loop on the same refusal
        closing = true
        sock.close()
      }
    }
  })

  sock.on('close', onDown('close'))
  sock.on('error', onDown('error'))
}

/* ---------------------------------------------------------------- *
 *  wire-up                                                          *
 * ---------------------------------------------------------------- */

const transport = new StdioServerTransport()
await mcp.connect(transport)
log('mcp_connected', { conversationId: CONVERSATION_ID })

// When claude truly goes away its stdio to us closes — exit so the hub sees the
// pipe drop and reaps the conversation. We gate ONLY on stdin end/close (the
// definitive "claude is gone" signal); we do NOT hook mcp.onclose, which can
// fire on benign MCP-level transport churn and would kill a healthy channel.
const die = (why) => () => {
  log('claude_gone', { why })
  closing = true
  try { ws?.close() } catch { /* already closed */ }
  process.exit(0)
}
process.stdin.on('end', die('stdin_end'))
process.stdin.on('close', die('stdin_close'))

connect()

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('signal', { sig })
    closing = true
    try { ws?.close() } catch { /* already closed */ }
    process.exit(0)
  })
}

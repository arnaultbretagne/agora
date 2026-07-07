#!/usr/bin/env node
/**
 * agora website — the hub process (ADR 0001/0004).
 *
 * Surfaces:
 *   - UI + REST for humans/clients (`public/` + /api/*)         — the façade
 *   - WS /ws/client : push events to browsers (snapshot, message, typing…)
 *   - WS /ws/channel: the pipes — each claude runtime's channel connects here
 *   - outbound: the supervisor API (spawn/kill runtimes)         — control plane
 *
 * Env: PORT (8600), HOST (127.0.0.1), DATA_DIR (./data), SUPERVISOR_URL
 * (http://127.0.0.1:8080), CHANNEL_HUB_URL (what spawned channels are told to
 * dial back — ws://127.0.0.1:PORT/ws/channel by default). No auth here: in
 * deployment the human façade sits behind the OIDC gate (infra-k8s ADR 0021).
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { parseChannelFrame, errMsg } from '../shared/protocol.js'
import { ConversationStore } from './lib/store.js'
import { PgConversationStore } from './lib/pg-store.js'
import { SupervisorClient } from './lib/supervisor.js'
import { Hub } from './lib/hub.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT ?? 8600)
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, 'data')
const SUPERVISOR_URL = process.env.SUPERVISOR_URL ?? 'http://127.0.0.1:8080'
const CHANNEL_HUB_URL = process.env.CHANNEL_HUB_URL ?? `ws://127.0.0.1:${PORT}/ws/channel`
const CHANNEL_LOG_DIR = process.env.CHANNEL_LOG_DIR || undefined
const PUBLIC_DIR = join(__dirname, 'public')

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL && process.env.NODE_ENV === 'production') {
  console.error('[website] FATAL: NODE_ENV=production without DATABASE_URL (ADR 0009 — no silent memory store)')
  process.exit(1)
}
const store = DATABASE_URL ? await PgConversationStore.open(DATABASE_URL) : new ConversationStore()
if (!DATABASE_URL) console.warn('[website] MEMORY store — conversations will NOT survive a restart')
const supervisor = new SupervisorClient(SUPERVISOR_URL)
const hub = new Hub(store, supervisor, {
  hubUrlForChannels: CHANNEL_HUB_URL,
  channelLogDir: CHANNEL_LOG_DIR,
})

/* ------------------------------------------------------------------ *
 *  HTTP: static + REST                                                *
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const path = normalize(join(PUBLIC_DIR, rel))
  if (!path.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' })
  if (!existsSync(path) || !statSync(path).isFile()) return sendJson(res, 404, { error: 'not found' })
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method ?? 'GET'
  try {
    if (path === '/healthz') return sendJson(res, 200, { ok: true })

    if (path === '/api/meta' && method === 'GET') {
      let kinds = ['claude']
      let supervisorUp = true
      const capabilities = {}
      try {
        kinds = await supervisor.kinds()
        // Per-kind capabilities are DISCOVERED by the supervisor (models from the harness's
        // own catalogue, efforts per model, agents scanned) — never a list we curate here.
        for (const k of kinds) {
          try {
            capabilities[k] = await supervisor.capabilities(k)
          } catch {
            capabilities[k] = { models: [], agents: [], defaults: {} }
          }
        }
      } catch {
        supervisorUp = false
      }
      return sendJson(res, 200, { kinds, capabilities, supervisorUp })
    }

    if (path === '/api/conversations') {
      if (method === 'GET') {
        return sendJson(res, 200, { conversations: store.list().map((c) => hub.summary(c)) })
      }
      if (method === 'POST') {
        const body = await readJson(req)
        // ADR 0010: a conversation is born WITH its first message — no empty conversations.
        // `config` {kind, model, effort, agent} is the message's execution config, not
        // conversation state; it materialises as the first run.
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return sendJson(res, 400, { error: '`text` (non-empty string) is required' })
        }
        // Where a run executes (isolation) is neither a caller input nor a hub concern: the
        // manager owns placement entirely (ADR 0011 superseded). The hub only forwards config.
        const conv = await hub.startConversation(body.text, body.config)
        return sendJson(res, 201, hub.full(store.get(conv.id)))
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    }

    const m = path.match(/^\/api\/conversations\/([^/]+)(?:\/([a-z]+))?$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const sub = m[2]
      const conv = store.get(id)
      if (!conv) return sendJson(res, 404, { error: 'unknown conversation' })

      if (!sub) {
        if (method === 'GET') return sendJson(res, 200, hub.full(conv))
        if (method === 'PATCH') {
          const body = await readJson(req)
          return sendJson(res, 200, hub.summary(await hub.patchConversation(id, body)))
        }
        if (method === 'DELETE') {
          await hub.deleteConversation(id)
          return sendJson(res, 200, { deleted: id })
        }
      }
      if (sub === 'messages' && method === 'POST') {
        const body = await readJson(req)
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return sendJson(res, 400, { error: '`text` (non-empty string) is required' })
        }
        // `config` (optional) = this message's execution config (ADR 0010): same as the live
        // run → plain push into it; different → the runtime is closed and a new run spawned.
        const message = await hub.sendUserMessage(id, body.text, body.config)
        return sendJson(res, 202, { message, state: hub.stateOf(id) })
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    }

    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' })
    if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    return serveStatic(res, path)
  } catch (err) {
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON body' })
    console.error(`[website] ${method} ${path} failed:`, err)
    return sendJson(res, 500, { error: err.message })
  }
})

/* ------------------------------------------------------------------ *
 *  WS: /ws/client (browsers) + /ws/channel (pipes)                    *
 * ------------------------------------------------------------------ */

const clientWss = new WebSocketServer({ noServer: true })
const channelWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname === '/ws/client') {
    clientWss.handleUpgrade(req, socket, head, (ws) => hub.addClient(ws))
  } else if (pathname === '/ws/channel') {
    channelWss.handleUpgrade(req, socket, head, (ws) => acceptChannel(ws))
  } else {
    socket.destroy()
  }
})

function acceptChannel(ws) {
  let conversationId = null
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  ws.on('message', (raw) => {
    const parsed = parseChannelFrame(raw)
    if (!parsed.ok) {
      ws.send(JSON.stringify(errMsg('bad_frame', parsed.error)))
      return
    }
    const msg = parsed.msg
    if (msg.type === 'hello') {
      if (hub.attachChannel(ws, msg)) conversationId = msg.conversationId
      return
    }
    if (!conversationId) {
      ws.send(JSON.stringify(errMsg('not_attached', 'hello first')))
      return
    }
    if (msg.type === 'reply') hub.onChannelReply(conversationId, msg).catch((e) => console.error('[website] channel frame failed:', e))
    if (msg.type === 'ready') hub.onChannelReady(conversationId).catch((e) => console.error('[website] channel frame failed:', e))
    if (msg.type === 'set_title') hub.onChannelSetTitle(conversationId, msg).catch((e) => console.error('[website] channel frame failed:', e))
    if (msg.type === 'unresponsive') hub.onChannelUnresponsive(conversationId, msg).catch((e) => console.error('[website] channel frame failed:', e))
    if (msg.type === 'err') console.error(`[website] channel ${conversationId} error: ${msg.message}`)
  })
}

// heartbeat: reap dead channel sockets so conversations fall back to dormant
setInterval(() => {
  for (const ws of channelWss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 20_000).unref()

server.listen(PORT, HOST, () => {
  console.log(`[website] agora hub on http://${HOST}:${PORT}`)
  console.log(`[website] supervisor: ${SUPERVISOR_URL} — channels dial back: ${CHANNEL_HUB_URL}`)
  console.log(`[website] store: ${DATABASE_URL ? 'postgres' : 'memory'} (${store.list().length} conversations)`)
  // re-arm the pipe leases of runtimes that survived a hub restart
  hub.reconcile().catch((err) => console.error('[website] reconcile failed:', err.message))
})

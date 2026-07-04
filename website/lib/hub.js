/**
 * The hub (ADR 0004): aggregates conversations, drives the supervisor
 * (control plane), routes messages between clients and pipes (data plane).
 * No agent logic lives here — the hub relays and records.
 *
 * Pipe lifecycle for one conversation:
 *   send on dormant → spawn runtime (supervisor) → conv `starting`, messages queue
 *   channel hello(conv, token) → conv `live` → flush queue (seeded if history exists)
 *   claude replies (reply tool → channel → WS) → persist + broadcast, typing off
 *   channel socket drops → conv `dormant` (the channel auto-reconnects if its
 *     runtime still lives — the conv simply goes live again on re-hello)
 *   close → supervisor kill → dormant. Reopen later = re-seed (ADR 0005).
 */
import { randomUUID } from 'node:crypto'
import {
  helloOkMsg, pushMsg, errMsg,
  snapshotEvent, convEvent, convDeletedEvent, messageEvent, typingEvent,
} from '../../shared/protocol.js'
import { buildSeedContent } from './seed.js'
import { spawnSpec } from './supervisor.js'

const TYPING_TIMEOUT_MS = 180_000

export class Hub {
  /**
   * @param {import('./store.js').ConversationStore} store
   * @param {import('./supervisor.js').SupervisorClient} supervisor
   * @param {{hubUrlForChannels: string, log?: (msg: string) => void}} opts
   */
  constructor(store, supervisor, opts) {
    this.store = store
    this.supervisor = supervisor
    this.hubUrlForChannels = opts.hubUrlForChannels
    this.channelLogDir = opts.channelLogDir // optional: per-session channel log sink
    this.log = opts.log ?? ((m) => console.log(`[hub] ${m}`))

    /** live pipes: convId → {ws, sessionId, token} */
    this.pipes = new Map()
    /**
     * spawned or awaiting re-claim, channel not hello'd yet:
     * convId → {token, sessionId, queue: string[] (msg ids), fresh, since}
     * `fresh` = a brand-new runtime (seed on attach); a re-claim of a running
     * runtime is NOT fresh (it already holds its context — never re-seed it).
     */
    this.pending = new Map()
    /** browser sockets */
    this.clients = new Set()
    /** convId → typing-clear timer */
    this.typingTimers = new Map()

    // sweep pendings whose channel never (re)appears — a spawn that never came up
    this.sweeper = setInterval(() => this.#sweepPending().catch((e) => this.log(`sweep error: ${e.message}`)), 30_000)
    this.sweeper.unref?.()

    // terminal-liveness safety net (ADR 0008): a live pipe can sit atop a DEAD runtime,
    // because the channel's WS does not always drop when claude dies (a wedged/half-dead
    // claude keeps stdio open → stale-green). Poll the supervisor and tear down any pipe
    // whose session is gone/exited. Idle-reaping itself now lives in the supervisor
    // (idleTtlMs passed at spawn), NOT here.
    const livenessEvery = Number(process.env.LIVENESS_INTERVAL_MS ?? 3000)
    this.liveness = setInterval(() => this.reconcileLiveness().catch((e) => this.log(`liveness error: ${e.message}`)), livenessEvery)
    this.liveness.unref?.()
  }

  /**
   * After a hub restart: re-arm the persisted pipe leases. Running runtimes
   * get parked in `pending` (their channel re-hellos within seconds); dead
   * ones are cleaned up to `dormant`.
   */
  async reconcile() {
    for (const conv of this.store.list()) {
      const lease = conv.pipe
      if (!lease) continue
      let status = 'unknown'
      try {
        status = (await this.supervisor.status(lease.sessionId)).status
      } catch { /* 404 or supervisor down → treat as gone */ }
      if (status === 'running') {
        this.pending.set(conv.id, { ...lease, queue: [], fresh: false, since: Date.now() })
        this.log(`reconciled ${conv.id}: session ${lease.sessionId} still running, awaiting re-hello`)
      } else {
        await this.store.setPipe(conv.id, undefined)
        this.log(`reconciled ${conv.id}: session ${lease.sessionId} gone → dormant`)
      }
    }
  }

  async #sweepPending() {
    for (const [convId, p] of [...this.pending]) {
      if (Date.now() - p.since < 120_000) continue
      // The channel never (re)claimed this session. Drop the pending → `dormant`; we do
      // NOT kill (ADR 0008 — the hub initiates no kills): the supervisor idle-reaps the
      // runtime's RAM on its own. A late hello can still re-claim via the persisted lease.
      this.pending.delete(convId)
      await this.store.setPipe(convId, undefined)
      this.#broadcastConv(convId)
      this.log(`swept ${convId}: channel never claimed session ${p.sessionId} (supervisor will idle-reap)`)
    }
  }

  /**
   * Terminal-liveness safety net (ADR 0008). A pipe is `live` in the hub's eyes, but the
   * runtime behind it may have died WITHOUT the channel WS dropping (a wedged/half-dead
   * claude keeps stdio open — the exact stale-green incident). Poll the supervisor and tear
   * down any pipe whose session is no longer running — the one death the event path misses.
   * `exitCode` present ⇒ a crash ⇒ `error`; gone / clean exit ⇒ `dormant`.
   */
  async reconcileLiveness() {
    let sessions
    try { sessions = await this.supervisor.list() } catch { return } // supervisor blip → skip this tick
    const byId = new Map(sessions.map((s) => [s.id, s]))
    for (const [convId, pipe] of [...this.pipes]) {
      const s = byId.get(pipe.sessionId)
      if (s && s.status === 'running') {
        // Record the concrete model the runtime resolved (supervisor reads it from the native
        // transcript). Only broadcasts on a change, not every tick.
        if (s.model && (await this.store.setResolvedModel(convId, s.model))) this.#broadcastConv(convId)
        continue // healthy — nothing else to do
      }
      // Delete the pipe BEFORE closing the socket so the ws-close handler (which would
      // re-park it in pending) sees the pipe already gone and no-ops — this method is authoritative.
      this.pipes.delete(convId)
      try { pipe.ws.close() } catch { /* already down */ }
      this.pending.delete(convId)
      this.#setTyping(convId, false)
      if (s && s.status === 'exited' && s.exitCode != null && s.exitCode !== 0) {
        await this.store.setError(convId, `runtime exited (${s.exitCode})`)
      } else {
        await this.store.setPipe(convId, undefined) // clean dormant
      }
      this.#broadcastConv(convId)
      this.log(`liveness: ${convId} session ${pipe.sessionId} ${s ? s.status : 'gone'} → ${this.stateOf(convId)}`)
    }
  }

  /* ------------------------------------------------------------ *
   *  runtime state as exposed to clients                          *
   * ------------------------------------------------------------ */

  stateOf(convId) {
    // error is a persisted OUTCOME → it wins over the live/derived states until cleared
    if (this.store.get(convId)?.error) return 'error'
    const pipe = this.pipes.get(convId)
    // a connected pipe is `live` only once the channel signalled readiness (agent loop up,
    // seed digested); before that it's still `starting` (socket up ≠ agent ready)
    if (pipe) return pipe.ready ? 'live' : 'starting'
    if (this.pending.has(convId)) return 'starting'
    return 'dormant'
  }

  summary(conv) {
    const last = conv.messages[conv.messages.length - 1]
    return {
      id: conv.id,
      title: conv.title,
      pinned: conv.pinned,
      kind: conv.kind,
      model: conv.model,
      resolvedModel: conv.resolvedModel ?? null, // concrete id the runtime actually ran (audit truth)
      effort: conv.effort ?? null,
      agent: conv.agent ?? null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      state: this.stateOf(conv.id),
      messageCount: conv.messages.length,
      lastText: last ? last.text.slice(0, 120) : '',
    }
  }

  full(conv) {
    return { ...this.summary(conv), messages: conv.messages }
  }

  /* ------------------------------------------------------------ *
   *  browser clients                                              *
   * ------------------------------------------------------------ */

  addClient(ws) {
    this.clients.add(ws)
    ws.send(JSON.stringify(snapshotEvent(this.store.list().map((c) => this.summary(c)))))
    ws.on('close', () => this.clients.delete(ws))
  }

  broadcast(event) {
    const raw = JSON.stringify(event)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(raw)
    }
  }

  #broadcastConv(convId) {
    const conv = this.store.get(convId)
    if (conv) this.broadcast(convEvent(this.summary(conv)))
  }

  #setTyping(convId, active) {
    clearTimeout(this.typingTimers.get(convId))
    this.typingTimers.delete(convId)
    if (active) {
      const timer = setTimeout(() => {
        this.typingTimers.delete(convId)
        this.broadcast(typingEvent(convId, false))
      }, TYPING_TIMEOUT_MS)
      timer.unref?.()
      this.typingTimers.set(convId, timer)
    }
    this.broadcast(typingEvent(convId, active))
  }

  /* ------------------------------------------------------------ *
   *  data plane: user → pipe                                      *
   * ------------------------------------------------------------ */

  /** Persist a user message and get it to the runtime (spawning one if needed). */
  async sendUserMessage(convId, text) {
    const conv = this.store.get(convId)
    if (!conv) throw new Error(`unknown conversation: ${convId}`)

    const message = await this.store.addMessage(convId, { role: 'user', text })
    await this.store.clearError(convId) // a new user message is a fresh attempt → drop any prior error
    this.broadcast(messageEvent(convId, message))
    this.#broadcastConv(convId) // title/updatedAt moved

    const pipe = this.pipes.get(convId)
    if (pipe) {
      pipe.ws.send(JSON.stringify(pushMsg({
        id: message.id,
        content: text,
        meta: { user: 'user', ts: message.ts },
      })))
      this.#setTyping(convId, true)
      return message
    }

    const pending = this.pending.get(convId)
    if (pending) {
      pending.queue.push(message.id)
      return message
    }

    await this.#spawnFor(conv, [message.id])
    return message
  }

  async #spawnFor(conv, queuedIds) {
    const token = randomUUID()
    const attempt = await this.store.bumpSpawn(conv.id)
    const sessionId = `${conv.id}-r${attempt}`
    await this.store.clearError(conv.id) // a spawn attempt clears the prior error
    this.pending.set(conv.id, { token, sessionId, queue: [...queuedIds], fresh: true, since: Date.now() })
    this.#broadcastConv(conv.id) // → starting
    try {
      await this.supervisor.spawn(spawnSpec(conv, {
        sessionId,
        hubUrl: this.hubUrlForChannels,
        token,
        channelLogDir: this.channelLogDir,
      }))
      await this.store.setPipe(conv.id, { token, sessionId })
      this.log(`spawned ${conv.kind} session ${sessionId} for ${conv.id}`)
    } catch (err) {
      // spawn failure is a visible OUTCOME, not a thrown 500: mark the conv `error` (retry-able)
      this.pending.delete(conv.id)
      await this.store.setError(conv.id, `spawn_failed: ${err.message}`)
      this.#broadcastConv(conv.id) // → error
      this.log(`runtime spawn failed for ${conv.id}: ${err.message}`)
    }
  }

  /* ------------------------------------------------------------ *
   *  data plane: pipe side                                        *
   * ------------------------------------------------------------ */

  /** A channel socket claims a conversation. Returns true if accepted. */
  attachChannel(ws, { conversationId, token }) {
    const conv = this.store.get(conversationId)
    if (!conv) {
      ws.send(JSON.stringify(errMsg('unknown_conversation', `no conversation ${conversationId}`)))
      ws.close()
      return false
    }
    const pending = this.pending.get(conversationId)
    const previous = this.pipes.get(conversationId)
    // three legitimate claim paths: a spawn in flight, a live-socket takeover,
    // or (after a hub restart) the lease persisted with the conversation
    const expected = pending?.token ?? previous?.token ?? conv.pipe?.token
    if (!expected || token !== expected) {
      ws.send(JSON.stringify(errMsg('bad_token', 'channel token mismatch')))
      ws.close()
      this.log(`rejected channel claim for ${conversationId} (bad token)`)
      return false
    }

    if (previous && previous.ws !== ws) {
      try { previous.ws.close() } catch { /* already down */ }
    }
    const sessionId = pending?.sessionId ?? previous?.sessionId ?? conv.pipe?.sessionId
    const fresh = pending?.fresh ?? false
    // A FRESH runtime is not proven up yet → `starting` until its `ready` frame (or first reply).
    // A RE-CLAIM is an already-running, already-ready runtime whose channel merely reconnected: it
    // will NOT re-emit `ready` (that fires once, on first ListTools), so mark it ready now — else it
    // would be stuck `starting` forever after every hub restart.
    this.pipes.set(conversationId, { ws, sessionId, token: expected, ready: !fresh })
    this.pending.delete(conversationId)
    ws.send(JSON.stringify(helloOkMsg()))
    this.log(`channel attached for ${conversationId} (session ${sessionId}${fresh ? ', fresh' : ', re-claim'})`)
    this.#broadcastConv(conversationId) // → starting (awaiting ready)

    ws.on('close', () => {
      if (this.pipes.get(conversationId)?.ws === ws) {
        this.pipes.delete(conversationId)
        // keep the token reachable for a re-hello of the SAME runtime: park it
        // back in pending with an empty queue (the channel reconnects on its own)
        this.pending.set(conversationId, { token: expected, sessionId, queue: [], fresh: false, since: Date.now() })
        this.#setTyping(conversationId, false)
        this.#broadcastConv(conversationId)
        this.log(`channel down for ${conversationId}`)
        // if the runtime is truly gone, drop back to dormant
        this.#reapIfExited(conversationId, sessionId)
      }
    })

    this.#deliverBacklog(conv, { fresh })
    return true
  }

  async #reapIfExited(conversationId, sessionId) {
    let verdict // 'dormant' | 'error' | undefined (= leave state as-is)
    try {
      const info = await this.supervisor.status(sessionId)
      // exited: a non-zero code is an unexpected crash → error; a clean exit → dormant.
      if (info.status === 'exited') verdict = info.exitCode ? 'error' : 'dormant'
    } catch (err) {
      // 404 = the supervisor no longer knows this session (idle-reaped or killed → gone) → dormant.
      // Any other failure (supervisor unreachable) is transient → leave the state untouched.
      if (err?.status === 404) verdict = 'dormant'
      else return
    }
    if (!verdict || this.pending.get(conversationId)?.sessionId !== sessionId) return
    this.pending.delete(conversationId)
    if (verdict === 'error') await this.store.setError(conversationId, 'runtime exited')
    else await this.store.setPipe(conversationId, undefined)
    this.#broadcastConv(conversationId) // → dormant / error
    this.log(`session ${sessionId} gone — ${conversationId} ${verdict}`)
  }

  /**
   * On attach: deliver whatever the runtime hasn't seen. A FRESH runtime gets
   * the seed (history replay, ADR 0005) when history exists; a re-claimed
   * runtime already holds its context and gets plain pushes only.
   */
  #deliverBacklog(conv, { fresh }) {
    const pipe = this.pipes.get(conv.id)
    if (!pipe) return
    const lastAssistant = conv.messages.findLastIndex((m) => m.role === 'assistant')
    const newUserMessages = conv.messages.slice(lastAssistant + 1).filter((m) => m.role === 'user')
    if (newUserMessages.length === 0) return

    const history = conv.messages.slice(0, conv.messages.length - newUserMessages.length)
    const latest = newUserMessages[newUserMessages.length - 1]

    if (fresh && history.length > 0) {
      // resumed conversation → ONE seed push carrying history + the new turns (ADR 0005)
      const content = buildSeedContent(conv, history, newUserMessages)
      pipe.ws.send(JSON.stringify(pushMsg({
        id: latest.id,
        content,
        meta: { user: 'user', ts: latest.ts, seed: 'true' },
      })))
      this.log(`seeded ${conv.id} (${history.length} history turns, ${newUserMessages.length} new)`)
    } else {
      for (const m of newUserMessages) {
        pipe.ws.send(JSON.stringify(pushMsg({ id: m.id, content: m.text, meta: { user: 'user', ts: m.ts } })))
      }
    }
    this.#setTyping(conv.id, true)
  }

  /** The agent's outbound turn arrived over a channel. */
  async onChannelReply(conversationId, { text, replyTo }) {
    const conv = this.store.get(conversationId)
    if (!conv) return
    const message = await this.store.addMessage(conversationId, { role: 'assistant', text, replyTo })
    // a real reply proves the agent is healthy → ready, and clears any error
    const pipe = this.pipes.get(conversationId)
    if (pipe) {
      pipe.ready = true
      this.supervisor.touch(pipe.sessionId) // completed turn → reset the supervisor's idle clock (ADR 0008)
    }
    await this.store.clearError(conversationId)
    this.#setTyping(conversationId, false)
    this.broadcast(messageEvent(conversationId, message))
    this.#broadcastConv(conversationId)
  }

  /** The channel signals claude's agent loop is up → the pipe is truly ready (`live`, not `starting`). */
  async onChannelReady(conversationId) {
    const pipe = this.pipes.get(conversationId)
    if (!pipe || pipe.ready) return
    pipe.ready = true
    await this.store.clearError(conversationId) // becoming ready clears a prior error
    this.#broadcastConv(conversationId) // → live
    this.log(`channel ready for ${conversationId}`)
  }

  /** The channel gave up re-delivering an unanswered push → the agent is stuck. Mark `error`. */
  async onChannelUnresponsive(conversationId, { messageId } = {}) {
    if (!this.store.get(conversationId)) return
    await this.store.setError(conversationId, 'unresponsive')
    this.#setTyping(conversationId, false)
    this.#broadcastConv(conversationId) // → error
    this.log(`channel unresponsive for ${conversationId} (push ${messageId ?? '?'})`)
  }

  /* ------------------------------------------------------------ *
   *  control plane                                                *
   * ------------------------------------------------------------ */

  async createConversation({ kind, model, effort, agent }) {
    const kinds = await this.supervisor.kinds()
    if (kind && !kinds.includes(kind)) throw new Error(`unknown kind: ${kind} (known: ${kinds.join(', ')})`)
    const conv = await this.store.create({ kind, model, effort, agent })
    this.broadcast(convEvent(this.summary(conv)))
    return conv
  }

  /** Kill the runtime; the conversation stays (dormant), reopenable by re-seed. */
  async closeConversation(convId) {
    const sessionId = this.pipes.get(convId)?.sessionId
      ?? this.pending.get(convId)?.sessionId
      ?? this.store.get(convId)?.pipe?.sessionId
    const pipe = this.pipes.get(convId)
    this.pipes.delete(convId)
    this.pending.delete(convId)
    if (pipe) { try { pipe.ws.close() } catch { /* already down */ } }
    if (sessionId) await this.supervisor.kill(sessionId)
    if (this.store.get(convId)) await this.store.setPipe(convId, undefined)
    this.#setTyping(convId, false)
    this.#broadcastConv(convId)
    this.log(`closed ${convId} (session ${sessionId ?? 'none'})`)
  }

  async deleteConversation(convId) {
    await this.closeConversation(convId)
    await this.store.delete(convId)
    this.broadcast(convDeletedEvent(convId))
  }

  async patchConversation(convId, fields) {
    const conv = await this.store.patch(convId, fields)
    this.#broadcastConv(convId)
    return conv
  }
}

/**
 * The hub (ADR 0004): aggregates conversations, drives the supervisor
 * (control plane), routes messages between clients and pipes (data plane).
 * No agent logic lives here — the hub relays and records.
 *
 * Data model (ADR 0010, "runs as facts"): a conversation is identity + state;
 * every spawn freezes its execution config into a RUN (`<convId>-rN`, also the
 * supervisor session id); messages point at their producing run; the resume
 * anchor per kind is a mutable pointer into the runs journal. Execution config
 * is never stored as intent — it travels with each message and is compared to
 * the live run's: same → plain push (same run, warm cache); different → the
 * live runtime is closed (product-command kill, ADR 0008 amendment) and a new
 * run materialises the config.
 *
 * Pipe lifecycle for one conversation:
 *   send on dormant → spawn runtime (supervisor) → conv `starting`, messages queue
 *   channel hello(conv, token) → conv `live` → flush queue (seeded if history exists)
 *   claude replies (reply tool → channel → WS) → persist + broadcast, typing off
 *   channel socket drops → conv `dormant` (the channel auto-reconnects if its
 *     runtime still lives — the conv simply goes live again on re-hello)
 *   close → supervisor kill → dormant. Reopen later = anchor + delta resume when a proven
 *     anchor exists (ADR 0007), else full re-seed (ADR 0005) — the correctness floor.
 */
import { randomUUID } from 'node:crypto'
import {
  helloOkMsg, pushMsg, errMsg,
  snapshotEvent, convEvent, convDeletedEvent, messageEvent, typingEvent,
} from '../../shared/protocol.js'
import { buildSeedContent, computeDelta, buildDeltaSeedContent } from './seed.js'
import { spawnSpec } from './supervisor.js'

const TYPING_TIMEOUT_MS = 180_000

/** A pending absent from the supervisor's list may just be a spawn POST still in flight —
 *  absence only reads as death once the entry is older than this (an explicit `exited`
 *  report needs no such settling: it is a positive verdict). */
const SPAWN_SETTLE_MS = 5000

/** Same idea, but for a substrate=isolated spawn (agora ADR 0011): the hub's spawn POST doesn't
 *  return until the manager finishes its whole get-or-create-loge dance — pod create + gVisor +
 *  readiness wait, up to LOGE_READY_TIMEOUT_MS (agent-runtime ADR 0010 §1.4, 90s default) — all
 *  BEFORE the run is visible in any session list. Found live 2026-07-05 (P4.1): a liveness tick
 *  firing mid-spawn saw the run absent, aged past the plain SPAWN_SETTLE_MS, and prematurely
 *  judged a legitimately in-flight isolated spawn dead. Bounded (not unbounded) so a genuinely
 *  hung spawn still eventually gets judged. */
const ISOLATED_SPAWN_SETTLE_MS = Number(process.env.ISOLATED_SPAWN_SETTLE_MS ?? 120_000)

/** Server-side floor when a message carries no config and no run exists yet (bare API use). */
const DEFAULT_CONFIG = { kind: 'claude', model: 'default' }

/** The four spawn knobs, normalised: '' → undefined for the optional ones. */
function normalizeConfig(config) {
  if (!config || typeof config !== 'object') return undefined
  const kind = typeof config.kind === 'string' && config.kind ? config.kind : undefined
  const model = typeof config.model === 'string' && config.model ? config.model : undefined
  const effort = typeof config.effort === 'string' && config.effort ? config.effort : undefined
  const agent = typeof config.agent === 'string' && config.agent ? config.agent : undefined
  if (!kind && !model && !effort && !agent) return undefined
  return { kind: kind ?? DEFAULT_CONFIG.kind, model: model ?? DEFAULT_CONFIG.model, effort, agent }
}

/** Does this config match the one frozen into a run? (undefined-safe on the optionals) */
function sameConfig(config, run) {
  return config.kind === run.kind && config.model === run.model
    && (config.effort ?? null) === (run.effort ?? null)
    && (config.agent ?? null) === (run.agent ?? null)
}

const configOfRun = (run) => ({ kind: run.kind, model: run.model, effort: run.effort, agent: run.agent })

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

    /**
     * live pipes: convId → {ws, runId, token, ready, resume, retriedFresh, replied}.
     * runId doubles as the supervisor session id AND the runs-journal key (everything
     * per-run — kind, native uuid, resolved model — derefs through the store). resume/
     * retriedFresh/replied: whether THIS spawn reattached an anchor, already used its one
     * fallback retry, and has proven itself via a reply — see reconcileLiveness/#reapIfExited.
     */
    this.pipes = new Map()
    /**
     * spawned or awaiting re-claim, channel not hello'd yet:
     * convId → {token, runId, queue: string[] (msg ids), fresh, since,
     *           resume?, anchorSeq?, retriedFresh?}
     * `fresh` = a brand-new runtime (seed on attach); a re-claim of a running runtime is NOT
     * fresh (it already holds its context — never re-seed it). `resume`/`anchorSeq` (ADR 0007,
     * only meaningful when `fresh`) = this spawn reattached a proven anchor instead of
     * starting cold; `retriedFresh` marks a pending entry AS the one automatic fallback
     * retry (reconcileLiveness), capping it at one.
     */
    this.pending = new Map()
    /** browser sockets */
    this.clients = new Set()
    /** convId → typing-clear timer */
    this.typingTimers = new Map()

    // how long a spawned-but-never-attached runtime may stay `starting` before the attempt
    // is abandoned (the channel is judged never-coming). Wide enough for slow cold starts
    // under host contention (90s+ observed 2026-07-04), far under the supervisor's idle reap.
    this.pendingAttachCapMs = Number(process.env.PENDING_ATTACH_CAP_MS ?? 600_000)

    // terminal-liveness safety net (ADR 0008): a live pipe can sit atop a DEAD runtime,
    // because the channel's WS does not always drop when claude dies (a wedged/half-dead
    // claude keeps stdio open → stale-green). Poll the supervisor and tear down any pipe
    // whose session is gone/exited; the same poll settles pending attempts (dead → verdict,
    // alive past the attach cap → abandoned). Idle-reaping itself now lives in the supervisor
    // (idleTtlMs passed at spawn), NOT here.
    const livenessEvery = Number(process.env.LIVENESS_INTERVAL_MS ?? 3000)
    this.liveness = setInterval(() => this.reconcileLiveness().catch((e) => this.log(`liveness error: ${e.message}`)), livenessEvery)
    this.liveness.unref?.()
  }

  /**
   * After a hub restart: re-arm the persisted runtime leases. Running runtimes
   * get parked in `pending` (their channel re-hellos within seconds); dead
   * ones are cleaned up to `dormant`.
   */
  async reconcile() {
    for (const conv of this.store.list()) {
      const lease = conv.live
      if (!lease) continue
      let status = 'unknown'
      try {
        status = (await this.supervisor.status(lease.runId)).status
      } catch { /* 404 or supervisor down → treat as gone */ }
      if (status === 'running') {
        this.pending.set(conv.id, { ...lease, queue: [], fresh: false, since: Date.now() })
        this.log(`reconciled ${conv.id}: run ${lease.runId} still running, awaiting re-hello`)
      } else {
        await this.store.setLive(conv.id, undefined)
        this.log(`reconciled ${conv.id}: run ${lease.runId} gone → dormant`)
      }
    }
  }

  /**
   * Terminal-liveness safety net (ADR 0008). A pipe is `live` in the hub's eyes, but the
   * runtime behind it may have died WITHOUT the channel WS dropping (a wedged/half-dead
   * claude keeps stdio open — the exact stale-green incident). Poll the supervisor and tear
   * down any pipe whose session is no longer running — the one death the event path misses.
   * `exitCode` present ⇒ a crash ⇒ `error`; gone / clean exit ⇒ `dormant`.
   * The same poll then settles `pending` attempts (see the loop below): dead → verdict or
   * ADR 0007 fallback; alive but never-attached past the cap → abandoned visibly.
   */
  async reconcileLiveness() {
    let sessions
    try { sessions = await this.supervisor.list() } catch { return } // supervisor blip → skip this tick
    const byId = new Map(sessions.map((s) => [s.id, s]))
    for (const [convId, pipe] of [...this.pipes]) {
      const s = byId.get(pipe.runId)
      if (s && s.status === 'running') {
        // Harness-native facts read back off the runtime (ADR 0010 — facts live on the run,
        // everything else derives): the concrete model it resolved (from the run's own
        // transcript lines, transcriptBase-guarded) and the topic title it gave itself
        // (claude's terminal-title escapes, read off the PTY — re-written as topics drift).
        let changed = false
        if (s.model && (await this.store.setRunResolvedModel(convId, pipe.runId, s.model))) changed = true
        if (s.title && (await this.store.setRunNativeTitle(convId, pipe.runId, s.title))) changed = true
        if (changed) this.#broadcastConv(convId)
        continue // healthy — nothing else to do
      }
      // Delete the pipe BEFORE closing the socket so the ws-close handler (which would
      // re-park it in pending) sees the pipe already gone and no-ops — this method is authoritative.
      this.pipes.delete(convId)
      try { pipe.ws.close() } catch { /* already down */ }
      this.pending.delete(convId)
      this.#setTyping(convId, false)
      // A resume that reached the channel/MCP layer (ws attached, hello'd) but crashed BEFORE ever
      // proving itself with a reply (e.g. the transcript went missing mid-flight — the channel can
      // connect in tens of ms, well before claude's own resume logic discovers the failure and
      // exits) must fall back to fresh, same as a resume that never attached at all — not surface
      // as a plain error the conversation can never escape (its anchor would still point at the
      // same dead transcript on every retry).
      if (pipe.resume && !pipe.replied && !pipe.retriedFresh) {
        await this.#fallbackToFreshResume(convId, pipe.runId)
        continue
      }
      if (s && s.status === 'exited' && s.exitCode != null && s.exitCode !== 0) {
        await this.store.setError(convId, `runtime exited (${s.exitCode})`)
      } else {
        await this.store.setLive(convId, undefined) // clean dormant
      }
      this.#broadcastConv(convId)
      this.log(`liveness: ${convId} run ${pipe.runId} ${s ? s.status : 'gone'} → ${this.stateOf(convId)}`)
    }

    // Pending verdicts — same authority rule as the pipes above (ADR 0008: no verdict
    // without the supervisor). A pending entry is a spawn (or re-claim) whose channel hasn't
    // attached yet; only the supervisor can say whether that's "claude still booting" or
    // "already dead":
    //   dead + unproven resume → the ADR 0007 fallback (clear the anchor, one fresh retry)
    //   dead otherwise         → classify error/dormant now, within a poll tick
    //   running, under the cap → claude is slow, not dead: leave the pending intact, so a
    //                            late hello still finds its token, seed decision and flags
    //   running, over the cap  → the channel is never coming (wedged plugin): abandon the
    //                            attempt visibly (error), clear the lease so the zombie is
    //                            fenced out. No kill — the supervisor idle-reaps it.
    for (const [convId, p] of [...this.pending]) {
      const s = byId.get(p.runId)
      const age = Date.now() - p.since
      if (s?.status === 'running') {
        if (age < this.pendingAttachCapMs) continue
        this.pending.delete(convId)
        await this.store.setLive(convId, undefined)
        await this.store.setError(convId, 'channel_never_attached')
        this.#broadcastConv(convId)
        this.log(`abandoned ${convId}: run ${p.runId} alive but its channel never attached — supervisor will idle-reap`)
        continue
      }
      // spawn POST may still be in flight — absence is not a verdict yet (isolated substrate:
      // the manager's get-or-create-loge dance can legitimately take much longer, ADR 0011)
      if (!s && age < (p.isolated ? ISOLATED_SPAWN_SETTLE_MS : SPAWN_SETTLE_MS)) continue
      if (p.resume && !p.retriedFresh) {
        await this.#fallbackToFreshResume(convId, p.runId)
        continue
      }
      this.pending.delete(convId)
      if (s?.status === 'exited' && s.exitCode != null && s.exitCode !== 0) {
        await this.store.setError(convId, `runtime exited (${s.exitCode})`)
      } else {
        await this.store.setLive(convId, undefined)
      }
      this.#broadcastConv(convId)
      this.log(`liveness: ${convId} pending run ${p.runId} ${s ? s.status : 'gone'} → ${this.stateOf(convId)}`)
    }
  }

  /**
   * Clear a dead anchor and retry once, fresh (ADR 0007's resume-death fallback). Shared by
   * every path that can discover a dead resume attempt: the pending-scan above, `#reapIfExited`
   * (a resume that died right after attach, via the ws-close event), and the pipe-liveness loop
   * above (a resume that died without its ws ever closing — the stale-green case). The retry
   * keeps the dead run's config (that's what the user asked for) — only the anchor is dropped.
   */
  async #fallbackToFreshResume(convId, runId) {
    const conv = this.store.get(convId)
    this.pending.delete(convId)
    if (!conv) return
    const run = this.store.getRun(convId, runId)
    this.log(`resume anchor dead for ${convId} — falling back to fresh`)
    if (run) await this.store.clearAnchor(convId, run.kind)
    await this.#spawnFor(conv, [], { config: run ? configOfRun(run) : undefined, forceFresh: true })
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
    // ADR 0010: the conversation stores no execution config — the UI's selectors derive
    // from the last run (the last materialised fact); resolvedModel is the exact id that
    // produced the most recent assistant turn (derefs message → run).
    const lastRun = conv.runs[conv.runs.length - 1]
    const lastAssistant = conv.messages.findLast((m) => m.role === 'assistant')
    const answeredBy = lastAssistant?.runId ? this.store.getRun(conv.id, lastAssistant.runId) : undefined
    // Displayed title precedence: a hand-given title wins for good; else the topic the
    // runtime last gave itself (the newest run that has one — a fresh run hasn't titled
    // yet); else the stored auto title (first-message truncation, the per-kind floor).
    const title = conv.titleSource === 'user'
      ? conv.title
      : (conv.runs.findLast((r) => r.nativeTitle)?.nativeTitle ?? conv.title)
    return {
      id: conv.id,
      title,
      pinned: conv.pinned,
      kind: lastRun?.kind ?? null,
      model: lastRun?.model ?? null,
      effort: lastRun?.effort ?? null,
      agent: lastRun?.agent ?? null,
      resolvedModel: answeredBy?.resolvedModel ?? null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      state: this.stateOf(conv.id),
      messageCount: conv.messages.length,
      lastText: last ? last.text.slice(0, 120) : '',
    }
  }

  full(conv) {
    return { ...this.summary(conv), messages: conv.messages, runs: conv.runs }
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

  /**
   * A conversation is born WITH its first message (ADR 0010) — there is no empty
   * conversation. The config (if any) materialises as the first run. Where it runs
   * (isolation) is not a conversation attribute at all: the manager owns placement
   * (ADR 0011 superseded), so nothing about it is decided or stored here.
   */
  async startConversation(text, config) {
    const cfg = normalizeConfig(config)
    if (cfg) {
      const kinds = await this.supervisor.kinds()
      if (!kinds.includes(cfg.kind)) throw new Error(`unknown kind: ${cfg.kind} (known: ${kinds.join(', ')})`)
    }
    const conv = await this.store.create()
    await this.sendUserMessage(conv.id, text, cfg)
    return conv
  }

  /**
   * Persist a user message and get it to a runtime running the requested config.
   * `config` is the message's execution config (ADR 0010): omitted → sticky (the live
   * run's, else the last run's, else the server default). A live runtime whose config
   * differs is closed (product-command kill, ADR 0008 amendment) and a new run spawned —
   * this message is then (re)delivered at attach by #deliverBacklog.
   */
  async sendUserMessage(convId, text, config) {
    const conv = this.store.get(convId)
    if (!conv) throw new Error(`unknown conversation: ${convId}`)

    const message = await this.store.addMessage(convId, { role: 'user', text })
    await this.store.clearError(convId) // a new user message is a fresh attempt → drop any prior error
    this.broadcast(messageEvent(convId, message))
    this.#broadcastConv(convId) // title/updatedAt moved

    const requested = normalizeConfig(config)
    const current = this.pipes.get(convId) ?? this.pending.get(convId)
    if (current) {
      const run = this.store.getRun(convId, current.runId)
      if (requested && run && !sameConfig(requested, run)) {
        // The message asks for a different config than the runtime that is up: that runtime
        // would answer with parameters the user no longer wants. Close it now (a turn
        // mid-flight is deliberately abandoned — switching means you want the NEW config's
        // answer) and respawn; the anchor survives, so the new run resumes the same native
        // session under the new flags, and #deliverBacklog re-delivers this message.
        await this.closeConversation(convId)
        await this.#spawnFor(conv, [], { config: requested })
        return message
      }
      const pipe = this.pipes.get(convId)
      if (pipe) {
        pipe.ws.send(JSON.stringify(pushMsg({
          id: message.id,
          content: text,
          meta: { user: 'user', ts: message.ts },
        })))
        this.#setTyping(convId, true)
      } else {
        this.pending.get(convId).queue.push(message.id)
      }
      return message
    }

    await this.#spawnFor(conv, [message.id], { config: requested })
    return message
  }

  /**
   * Spawn a runtime for `config` (falling back to the last run's config, then the server
   * default) and journal it as a run (ADR 0010). forceFresh skips the anchor even if one
   * exists — used by the resume-death fallback net to cap automatic retries at one.
   * @param {{config?: object, forceFresh?: boolean}} [opts]
   */
  async #spawnFor(conv, queuedIds, { config, forceFresh = false } = {}) {
    const lastRun = this.store.lastRun(conv.id)
    const cfg = config ?? (lastRun ? configOfRun(lastRun) : DEFAULT_CONFIG)
    const token = randomUUID()
    // Anchor + delta resume (ADR 0007): reuse the last PROVEN anchor for this kind, unless
    // forceFresh (the caller already knows it's dead). No anchor, or forceFresh → fresh.
    const anchor = !forceFresh ? conv.anchors?.[cfg.kind] : undefined
    const anchorRun = anchor ? this.store.getRun(conv.id, anchor.runId) : undefined
    const resume = Boolean(anchorRun?.nativeSessionId)
    // Same-file confirmed (C0): resuming reattaches the SAME transcript uuid, so the new run
    // inherits the anchor run's native session id — that uuid IS the thing being resumed.
    const native = resume ? anchorRun.nativeSessionId : randomUUID()
    const anchorSeq = resume ? anchor.syncedSeq : 0
    const run = await this.store.addRun(conv.id, { ...cfg, nativeSessionId: native, resume })
    await this.store.clearError(conv.id) // a spawn attempt clears the prior error
    this.pending.set(conv.id, {
      token, runId: run.id, queue: [...queuedIds], fresh: true,
      resume, anchorSeq, retriedFresh: forceFresh, since: Date.now(),
      // Every spawn now goes through the manager's get-or-create-loge path (the hub no longer
      // decides placement — the manager owns isolation). That path is slow (pod create + gVisor +
      // readiness), so a pending entry always takes the generous settle window
      // (ISOLATED_SPAWN_SETTLE_MS). This unconditional `true` is the vestige of the removed
      // substrate flag: whether the hub should be spawn-latency-aware at all — or leave that to
      // the manager — is the open reaper question, deliberately left untouched here.
      isolated: true,
    })
    this.#broadcastConv(conv.id) // → starting
    try {
      await this.supervisor.spawn(spawnSpec(cfg, {
        convId: conv.id,
        runId: run.id,
        nativeSessionId: native,
        resumeFrom: resume ? native : undefined,
        hubUrl: this.hubUrlForChannels,
        token,
        channelLogDir: this.channelLogDir,
        group: conv.id,
      }))
      await this.store.setLive(conv.id, { runId: run.id, token })
      this.log(`spawned ${cfg.kind} run ${run.id} for ${conv.id}${resume ? ' (resume)' : ''}`)
    } catch (err) {
      // The manager's one typed error (agent-runtime ADR 0010 §4): the transcript this resume
      // bet on is gone everywhere (loge-local AND the anchor store). Same remedy as any other
      // dead resume (ADR 0007) — drop the bet, reseed cold, exactly once (forceFresh caps it).
      if (err.status === 409 && !forceFresh && String(err.message).includes('anchor_transcript_missing')) {
        this.pending.delete(conv.id)
        // Drop the now-proven-dead anchor too (like #fallbackToFreshResume) — otherwise every
        // future reopen would repeat this same 409→retry dance instead of going fresh directly.
        if (resume) await this.store.clearAnchor(conv.id, cfg.kind)
        this.log(`anchor transcript missing for ${conv.id} — retrying forceFresh`)
        await this.#spawnFor(conv, queuedIds, { config: cfg, forceFresh: true })
        return
      }
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
    const expected = pending?.token ?? previous?.token ?? conv.live?.token
    if (!expected || token !== expected) {
      ws.send(JSON.stringify(errMsg('bad_token', 'channel token mismatch')))
      ws.close()
      this.log(`rejected channel claim for ${conversationId} (bad token)`)
      return false
    }

    if (previous && previous.ws !== ws) {
      try { previous.ws.close() } catch { /* already down */ }
    }
    const runId = pending?.runId ?? previous?.runId ?? conv.live?.runId
    const fresh = pending?.fresh ?? false
    // anchorSeq (ADR 0007) only matters for THIS attach's backlog decision, never persisted — a
    // re-claim always has fresh=false regardless, so it never reads it (see #deliverBacklog).
    // resume/retriedFresh DO need to live on the pipe past this attach: a resume that reaches the
    // channel but crashes before ever replying must still fall back to fresh (see reconcileLiveness
    // and #reapIfExited) — `replied` starts false and is promoted in onChannelReply, the ONE proof
    // a resume actually worked.
    const resume = pending?.resume ?? false
    const anchorSeq = pending?.anchorSeq ?? 0
    const retriedFresh = pending?.retriedFresh ?? false
    // A FRESH runtime is not proven up yet → `starting` until its `ready` frame (or first reply).
    // A RE-CLAIM is an already-running, already-ready runtime whose channel merely reconnected: it
    // will NOT re-emit `ready` (that fires once, on first ListTools), so mark it ready now — else it
    // would be stuck `starting` forever after every hub restart.
    this.pipes.set(conversationId, {
      ws, runId, token: expected, ready: !fresh, resume, retriedFresh, replied: false,
    })
    this.pending.delete(conversationId)
    ws.send(JSON.stringify(helloOkMsg()))
    this.log(`channel attached for ${conversationId} (run ${runId}${fresh ? ', fresh' : ', re-claim'})`)
    this.#broadcastConv(conversationId) // → starting (awaiting ready)

    ws.on('close', () => {
      const dying = this.pipes.get(conversationId)
      if (dying?.ws === ws) {
        this.pipes.delete(conversationId)
        // keep the token reachable for a re-hello of the SAME runtime: park it back in pending with
        // an empty queue (the channel reconnects on its own). Carry resume/retriedFresh forward
        // (only if not yet proven by a reply) so #reapIfExited can still fall back to fresh if this
        // turns out to be the resume dying rather than a transient drop.
        this.pending.set(conversationId, {
          token: expected, runId, queue: [], fresh: false,
          resume: dying.resume && !dying.replied, retriedFresh: dying.retriedFresh, since: Date.now(),
        })
        this.#setTyping(conversationId, false)
        this.#broadcastConv(conversationId)
        this.log(`channel down for ${conversationId}`)
        // if the runtime is truly gone, drop back to dormant
        this.#reapIfExited(conversationId, runId)
      }
    })

    this.#deliverBacklog(conv, { fresh, resume, anchorSeq })
    return true
  }

  async #reapIfExited(conversationId, runId) {
    let verdict // 'dormant' | 'error' | undefined (= leave state as-is)
    try {
      const info = await this.supervisor.status(runId)
      // exited: a non-zero code is an unexpected crash → error; a clean exit → dormant.
      if (info.status === 'exited') verdict = info.exitCode ? 'error' : 'dormant'
    } catch (err) {
      // 404 = the supervisor no longer knows this session (idle-reaped or killed → gone) → dormant.
      // Any other failure (supervisor unreachable) is transient → leave the state untouched.
      if (err?.status === 404) verdict = 'dormant'
      else return
    }
    const pending = this.pending.get(conversationId)
    if (!verdict || pending?.runId !== runId) return
    // A resume that reached the channel but crashed before ever proving itself (no reply) falls
    // back to fresh instead of surfacing error/dormant — same remediation as reconcileLiveness's
    // fallback net, reached faster here via the ws-close event instead of the next poll tick.
    if (pending.resume && !pending.retriedFresh) {
      await this.#fallbackToFreshResume(conversationId, runId)
      return
    }
    this.pending.delete(conversationId)
    if (verdict === 'error') await this.store.setError(conversationId, 'runtime exited')
    else await this.store.setLive(conversationId, undefined)
    this.#broadcastConv(conversationId) // → dormant / error
    this.log(`run ${runId} gone — ${conversationId} ${verdict}`)
  }

  /**
   * On attach: deliver whatever the runtime hasn't seen. Three cases (ADR 0007's anchor + delta
   * model, `anchor = 0` being the ADR 0005 floor):
   *   - fresh + resume: the native session already holds its own context — inject only the hub
   *     turns it missed (the delta), or a plain push if it missed nothing.
   *   - fresh + !resume: no usable anchor (cross-kind, lost transcript, or never resumed before) —
   *     full history replay, same as ever.
   *   - re-claim (!fresh): an already-running, already-context-holding runtime — never re-seed.
   */
  #deliverBacklog(conv, { fresh, resume, anchorSeq }) {
    const pipe = this.pipes.get(conv.id)
    if (!pipe) return
    const lastAssistant = conv.messages.findLastIndex((m) => m.role === 'assistant')
    const newUserMessages = conv.messages.slice(lastAssistant + 1).filter((m) => m.role === 'user')
    if (newUserMessages.length === 0) return

    const latest = newUserMessages[newUserMessages.length - 1]
    const pushPlain = () => {
      for (const m of newUserMessages) {
        pipe.ws.send(JSON.stringify(pushMsg({ id: m.id, content: m.text, meta: { user: 'user', ts: m.ts } })))
      }
    }
    const pushSeed = (content) => {
      pipe.ws.send(JSON.stringify(pushMsg({
        id: latest.id, content, meta: { user: 'user', ts: latest.ts, seed: 'true' },
      })))
    }

    if (fresh && resume) {
      const delta = computeDelta(conv, anchorSeq, newUserMessages.map((m) => m.id))
      if (delta.length > 0) {
        pushSeed(buildDeltaSeedContent(conv, delta, newUserMessages))
        this.log(`delta-seeded ${conv.id} (${delta.length} missed turns, ${newUserMessages.length} new)`)
      } else {
        pushPlain()
      }
    } else if (fresh) {
      const history = conv.messages.slice(0, conv.messages.length - newUserMessages.length)
      if (history.length > 0) {
        pushSeed(buildSeedContent(conv, history, newUserMessages))
        this.log(`seeded ${conv.id} (${history.length} history turns, ${newUserMessages.length} new)`)
      } else {
        pushPlain()
      }
    } else {
      pushPlain()
    }
    this.#setTyping(conv.id, true)
  }

  /** The agent's outbound turn arrived over a channel. */
  async onChannelReply(conversationId, { text, replyTo }) {
    const conv = this.store.get(conversationId)
    if (!conv) return
    const pipe = this.pipes.get(conversationId)
    // The message points at its producing run (ADR 0010) — model/kind/agent per message all
    // derive from there, retroactively correct once the run's resolvedModel is read.
    const message = await this.store.addMessage(conversationId, {
      role: 'assistant', text, replyTo, runId: pipe?.runId,
    })
    // a real reply proves the agent is healthy → ready, and clears any error
    if (pipe) {
      pipe.ready = true
      pipe.replied = true // proves this run (resumed or fresh) actually works — see reconcileLiveness
      this.supervisor.touch(pipe.runId) // completed turn → reset the supervisor's idle clock (ADR 0008)
      // the reply is the ONE point a native session is proven faithful (ADR 0007) — move the
      // anchor here, never at spawn (a runtime that dies before replying leaves the prior anchor).
      const run = this.store.getRun(conversationId, pipe.runId)
      if (run) await this.store.setAnchor(conversationId, run.kind, { runId: run.id, syncedSeq: conv.seq })
    }
    await this.store.clearError(conversationId)
    this.#setTyping(conversationId, false)
    this.broadcast(messageEvent(conversationId, message))
    this.#broadcastConv(conversationId)
  }

  /** The runtime named its conversation (the channel's `set_title` tool). Recorded as a fact
   *  on the LIVE run (`nativeTitle`, ADR 0010 amendment) — the displayed title derives from
   *  it, and a manual rename (`titleSource = 'user'`) outranks it for good. */
  async onChannelSetTitle(conversationId, { title }) {
    const pipe = this.pipes.get(conversationId)
    if (!pipe || !this.store.get(conversationId)) return
    const topic = String(title).trim().slice(0, 120)
    if (topic && (await this.store.setRunNativeTitle(conversationId, pipe.runId, topic))) {
      this.#broadcastConv(conversationId)
      this.log(`titled ${conversationId}: "${topic}" (run ${pipe.runId})`)
    }
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

  /** Kill the runtime; the conversation stays (dormant), reopenable by resume/re-seed. */
  async closeConversation(convId) {
    const runId = this.pipes.get(convId)?.runId
      ?? this.pending.get(convId)?.runId
      ?? this.store.get(convId)?.live?.runId
    const pipe = this.pipes.get(convId)
    this.pipes.delete(convId)
    this.pending.delete(convId)
    if (pipe) { try { pipe.ws.close() } catch { /* already down */ } }
    if (runId) await this.supervisor.kill(runId)
    if (this.store.get(convId)) await this.store.setLive(convId, undefined)
    this.#setTyping(convId, false)
    this.#broadcastConv(convId)
    this.log(`closed ${convId} (run ${runId ?? 'none'})`)
  }

  async deleteConversation(convId) {
    const conv = this.store.get(convId)
    await this.closeConversation(convId)
    await this.store.delete(convId)
    this.broadcast(convDeletedEvent(convId))
    // Best-effort purge of the manager's anchor custody (agent-runtime ADR 0010 §4) — a miss
    // just means the manager's own TTL sweep backstops it later, never a user-visible failure.
    const uuids = [...new Set((conv?.runs ?? []).map((r) => r.nativeSessionId).filter(Boolean))]
    if (uuids.length > 0) await this.supervisor.anchorsDelete(uuids)
  }

  /** Metadata only (title/pinned) — execution config travels with messages (ADR 0010). */
  async patchConversation(convId, fields) {
    const conv = await this.store.patch(convId, fields)
    this.#broadcastConv(convId)
    return conv
  }
}

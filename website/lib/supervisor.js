/** Bounds every supervisor/manager call (agent-runtime ADR 0010 amendment: read-driven liveness).
 *  With the async manager no call blocks on loge boot any more — spawn returns 202 at once, status/
 *  list are quick — so a call that exceeds this is a wedged endpoint and MUST fail loudly rather
 *  than hang a pending entry forever (that hang was exactly leak #2). */
const REQUEST_TIMEOUT_MS = Number(process.env.SUPERVISOR_REQUEST_TIMEOUT_MS ?? 15_000)

/**
 * Client for the agent-runtime supervisor API (the control plane, ADR 0004 #2):
 * POST/GET/DELETE /sessions + /kinds. The hub is the ONLY caller of this API.
 */
export class SupervisorClient {
  /** @param {string} baseUrl e.g. http://127.0.0.1:8080 */
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  async #json(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    if (!res.ok) {
      const err = new Error(`supervisor ${method} ${path} → ${res.status}: ${data.error ?? text}`)
      err.status = res.status
      throw err
    }
    return data
  }

  async health() {
    return this.#json('GET', '/healthz')
  }

  /** Discovered per-kind capabilities: {models:[{id,name,efforts}], agents:[], defaults}. */
  async capabilities(kind) {
    return this.#json('GET', `/kinds/${encodeURIComponent(kind)}/capabilities`)
  }

  /** Closed registry of runtime kinds baked into the image (ADR 0002). */
  async kinds() {
    try {
      const data = await this.#json('GET', '/kinds')
      if (Array.isArray(data.kinds)) return data.kinds
    } catch (err) {
      if (err.status !== 404) throw err
    }
    return ['claude'] // pre-/kinds supervisor
  }

  async spawn({ kind, id, args, env, idleTtlMs, group }) {
    return this.#json('POST', '/sessions', { kind, id, args, env, idleTtlMs, group })
  }

  /** All sessions the supervisor tracks (one round-trip; drives the liveness reconcile). */
  async list() {
    const data = await this.#json('GET', '/sessions')
    return Array.isArray(data.sessions) ? data.sessions : []
  }

  async status(id) {
    return this.#json('GET', `/sessions/${encodeURIComponent(id)}`)
  }

  /** Heartbeat a session's idle clock (ADR 0008). Best-effort: a miss only risks an early reap. */
  async touch(id) {
    try {
      await this.#json('POST', `/sessions/${encodeURIComponent(id)}/touch`)
    } catch { /* session gone or supervisor blip — not worth surfacing */ }
  }

  async kill(id) {
    try {
      return await this.#json('DELETE', `/sessions/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err.status === 404) return { id, killed: false }
      throw err
    }
  }

  /** Best-effort purge of native transcript anchors at the manager (agent-runtime ADR 0010 §4),
   *  called on conversation deletion. Errors are swallowed: a miss just means the manager's own
   *  TTL sweep backstops it later — never worth failing a delete over. */
  async anchorsDelete(uuids) {
    await Promise.all(uuids.map(async (uuid) => {
      try {
        await this.#json('DELETE', `/anchors/${encodeURIComponent(uuid)}`)
      } catch { /* best-effort */ }
    }))
  }
}

/**
 * The per-kind spawn recipe — product knowledge (which flags wire the channel)
 * kept OUT of the supervisor (ADR 0002: it forwards, it does not interpret).
 * Adding a runtime kind = adding its recipe here + its bridge artefact.
 */
export function spawnSpec(config, { convId, runId, nativeSessionId, resumeFrom, hubUrl, token, channelLogDir, group }) {
  if (config.kind !== 'claude') throw new Error(`no spawn recipe for kind: ${config.kind}`)
  const args = [
    // Resume mode (agora ADR 0007): reattach the native session that's the proven anchor for this
    // conv — C0 (the ADR's verify gate) confirmed `--resume` grows the SAME transcript file rather
    // than forking, so a bare `--resume <uuid>` suffices, no `--session-id` combo needed. Fresh
    // mode: the hub-generated (not claude-self-chosen) uuid names a known transcript path
    // (`~/.claude/projects/<slug>/<uuid>.jsonl`) the supervisor reads for the resolved-model report,
    // and becomes the anchor a future resume reattaches to.
    ...(resumeFrom ? ['--resume', resumeFrom] : ['--session-id', nativeSessionId]),
    '--channels', 'plugin:agora@agora',
    '--allowedTools', 'mcp__plugin_agora_agora__reply,mcp__plugin_agora_agora__set_title',
    // Gate C (agent-runtime README "Headless channel spawn"): since claude 2.1.153/2.1.196 a plugin
    // `.mcp.json` server is `Pending approval` and WON'T spawn headlessly (no operator to answer the
    // prompt) → the channel MCP server never starts → conversation stuck `starting`, silently. Approving
    // it via `.claude.json` is not durable (claude rewrites & strips it on startup). The pod IS the
    // sandbox (ADR 0003, non-root `node`), so bypassing the in-boundary prompt is by design.
    '--dangerously-skip-permissions',
  ]
  if (config.model && config.model !== 'default') args.push('--model', config.model)
  if (config.effort) args.push('--effort', config.effort)
  if (config.agent) args.push('--agent', config.agent)
  const env = {
    CHANNEL_HUB_URL: hubUrl,
    CHANNEL_CONVERSATION_ID: convId,
    CHANNEL_TOKEN: token,
  }
  if (channelLogDir) env.CHANNEL_LOG = `${channelLogDir}/${runId}.channel.log`
  // idleTtlMs (ADR 0008): the supervisor idle-reaps the runtime after this much inactivity.
  // The policy (the harness cache TTL) is the product's; the supervisor treats it as opaque.
  // group (agent-runtime ADR 0010): the opaque co-location key (the conversation id) — meaningless
  // to the supervisor itself; only the manager acts on it, to get-or-create the conversation's loge.
  return { kind: config.kind, id: runId, args, env, idleTtlMs: cacheTtlFor(config.kind), group }
}

/**
 * Per-kind prompt-cache TTL, in ms — the idle window past which keeping a runtime
 * alive stops paying: once the server-side cache lapses, keep-alive ≡ re-seed ≡
 * `--resume` (all a cold reprocess), so the hub reaps the idle runtime to reclaim
 * RAM (see the idle-reaper). This is a HARNESS-NATIVE knob, not a global constant:
 * Claude Code on a Max subscription auto-uses the 1h cache TTL (verified 2026-07-02);
 * an API key defaults to 5m, another kind has its own (or ~0 with no caching).
 */
export function cacheTtlFor(kind) {
  if (kind === 'claude') return Number(process.env.CLAUDE_CACHE_TTL_MS ?? 3_600_000) // 1h (subscription)
  return Number(process.env.DEFAULT_CACHE_TTL_MS ?? 3_600_000)
}

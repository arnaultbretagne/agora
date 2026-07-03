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

  async spawn({ kind, id, args, env, idleTtlMs }) {
    return this.#json('POST', '/sessions', { kind, id, args, env, idleTtlMs })
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
}

/**
 * The per-kind spawn recipe — product knowledge (which flags wire the channel)
 * kept OUT of the supervisor (ADR 0002: it forwards, it does not interpret).
 * Adding a runtime kind = adding its recipe here + its bridge artefact.
 */
export function spawnSpec(conv, { sessionId, hubUrl, token, channelLogDir }) {
  if (conv.kind !== 'claude') throw new Error(`no spawn recipe for kind: ${conv.kind}`)
  const args = [
    '--channels', 'plugin:agora@agora',
    '--allowedTools', 'mcp__plugin_agora_agora__reply',
  ]
  if (conv.model && conv.model !== 'default') args.push('--model', conv.model)
  if (conv.effort) args.push('--effort', conv.effort)
  if (conv.agent) args.push('--agent', conv.agent)
  const env = {
    CHANNEL_HUB_URL: hubUrl,
    CHANNEL_CONVERSATION_ID: conv.id,
    CHANNEL_TOKEN: token,
  }
  if (channelLogDir) env.CHANNEL_LOG = `${channelLogDir}/${sessionId}.channel.log`
  // idleTtlMs (ADR 0008): the supervisor idle-reaps the runtime after this much inactivity.
  // The policy (the harness cache TTL) is the product's; the supervisor treats it as opaque.
  return { kind: conv.kind, id: sessionId, args, env, idleTtlMs: cacheTtlFor(conv.kind) }
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

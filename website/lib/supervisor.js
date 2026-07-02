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

  async spawn({ kind, id, args, env }) {
    return this.#json('POST', '/sessions', { kind, id, args, env })
  }

  async status(id) {
    return this.#json('GET', `/sessions/${encodeURIComponent(id)}`)
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
  const env = {
    CHANNEL_HUB_URL: hubUrl,
    CHANNEL_CONVERSATION_ID: conv.id,
    CHANNEL_TOKEN: token,
  }
  if (channelLogDir) env.CHANNEL_LOG = `${channelLogDir}/${sessionId}.channel.log`
  return { kind: conv.kind, id: sessionId, args, env }
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

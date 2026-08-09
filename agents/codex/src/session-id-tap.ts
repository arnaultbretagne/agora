/**
 * `apps/session-runtime-controller/src/custody.ts` calls plain `GET .../custody` with no Session
 * context in the URL (one Pod = one Session, matching `fake-agent-server.ts`'s own route) — so this
 * process must learn the ACP `sessionId` itself by watching traffic, not from any caller. Taps
 * NDJSON frames flowing in both directions (never buffers/rewrites bytes, never delays forwarding)
 * and calls `onSessionId` as soon as it's known:
 * - a `session/resume`/`session/load` REQUEST already names `params.sessionId` (client-supplied);
 * - a `session/new` RESPONSE names `result.sessionId` (Agent-generated, correlated by request id).
 *
 * Identical logic to `agents/claude-code/src/session-id-tap.ts` — this is plain ACP wire-protocol
 * correlation, not harness-specific (both adapters use the same `session/new`/`resume`/`load`
 * shapes), duplicated per this repo's own per-Agent-directory convention rather than shared.
 */
export function watchForSessionId(onSessionId: (sessionId: string) => void): {
  readonly observeClientToAgent: (frame: Uint8Array) => void
  readonly observeAgentToClient: (frame: Uint8Array) => void
} {
  const pendingNewRequestIds = new Set<string | number>()

  function tryParse(frame: Uint8Array): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(frame))
    } catch {
      return undefined
    }
  }

  return {
    observeClientToAgent(frame) {
      const message = tryParse(frame) as { method?: string; id?: string | number; params?: { sessionId?: string } } | undefined
      if (!message || typeof message !== 'object') return
      if (message.method === 'session/new' && (typeof message.id === 'string' || typeof message.id === 'number')) {
        pendingNewRequestIds.add(message.id)
      }
      if ((message.method === 'session/resume' || message.method === 'session/load') && typeof message.params?.sessionId === 'string') {
        onSessionId(message.params.sessionId)
      }
    },
    observeAgentToClient(frame) {
      const message = tryParse(frame) as { id?: string | number; result?: { sessionId?: string } } | undefined
      if (!message || typeof message !== 'object') return
      if (
        (typeof message.id === 'string' || typeof message.id === 'number') &&
        pendingNewRequestIds.has(message.id) &&
        typeof message.result?.sessionId === 'string'
      ) {
        pendingNewRequestIds.delete(message.id)
        onSessionId(message.result.sessionId)
      }
    },
  }
}

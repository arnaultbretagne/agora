export type RpcKind = 'request' | 'response' | 'notification' | 'batch' | 'invalid'

export interface ClassifiedMessage {
  readonly kind: RpcKind
  readonly method: string | null
  readonly requestId: unknown
}

/** Minimal JSON-RPC shape classification — ACP method-schema validation is out of this plan's scope (see journal.ts). */
export function classifyMessage(payload: unknown): ClassifiedMessage {
  if (Array.isArray(payload)) return { kind: 'batch', method: null, requestId: null }
  if (typeof payload !== 'object' || payload === null) return { kind: 'invalid', method: null, requestId: null }
  const message = payload as Record<string, unknown>
  if ('method' in message && 'id' in message) {
    return { kind: 'request', method: String(message.method), requestId: message.id }
  }
  if ('method' in message) {
    return { kind: 'notification', method: String(message.method), requestId: null }
  }
  if ('id' in message) {
    return { kind: 'response', method: null, requestId: message.id }
  }
  return { kind: 'invalid', method: null, requestId: null }
}

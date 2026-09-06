// HTTP owner transport (S8): the first real wiring from the engine's verb runner to the real
// owners — runtime-control (Pods) and broker (grants). Both expose the identical
// `POST /v1/owner-requests` shape (packages/owner-requests) apps/runtime-control and apps/broker
// already serve; this is a thin, uniform client over it, never owner-specific logic.
import type { OwnerRequest, OwnerResponse } from '@agora/owner-requests'
import type { VerbRunnerTransport } from '@agora/engine'

export interface HttpOwnerTransportOptions {
  readonly runtimeControlBaseUrl: string
  readonly brokerBaseUrl: string
}

const RUNTIME_CONTROL_OPERATIONS = new Set(['create_pod', 'cleanup_pod', 'gate_release'])

export function createHttpOwnerTransport(options: HttpOwnerTransportOptions): VerbRunnerTransport {
  return {
    route: (operation) => (RUNTIME_CONTROL_OPERATIONS.has(operation) ? 'runtime-control' : 'broker'),
    send: async (owner, request) => sendOwnerRequest(owner === 'runtime-control' ? options.runtimeControlBaseUrl : options.brokerBaseUrl, request),
  }
}

/** Exported for callers outside the routed transport (session-opener's own gate_release dispatch: not a tracked verb, just this one owner). */
export async function sendOwnerRequest(baseUrl: string, request: OwnerRequest): Promise<OwnerResponse> {
  try {
    const res = await fetch(`${baseUrl}/v1/owner-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = (await res.json()) as OwnerResponse | { readonly title?: string; readonly detail?: string }
    if (!res.ok) {
      // A non-2xx (the owner is reachable but refused/errored) is `unknown` — the owner may or
      // may not have accepted (CONT-005/ENGINE-008 shape). Never silently a rejection or success.
      const detail = 'detail' in body && typeof body.detail === 'string' ? body.detail : `owner answered ${res.status}`
      return { kind: 'unknown', detail }
    }
    return body as OwnerResponse
  } catch (error) {
    // The owner is unreachable outright (connection refused, DNS failure, timeout) — same
    // `unknown` shape, never a thrown exception the caller would have to separately handle.
    return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) }
  }
}

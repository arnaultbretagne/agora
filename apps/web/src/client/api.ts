/** Thin fetch wrapper over contracts/openapi/product-api.yaml — no framework, native `fetch`/DOM only (see ../../DECISION.md). */

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail?: string
}

export class ApiError extends Error {
  readonly problem: Problem
  constructor(problem: Problem) {
    super(problem.title)
    this.problem = problem
  }
}

function authHeader(): Record<string, string> {
  const principal = localStorage.getItem('agora.principal')
  return principal ? { authorization: `Bearer ${principal}` } : {}
}

function idempotencyKey(): string {
  return crypto.randomUUID()
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeader(), ...(init.headers as Record<string, string> | undefined) },
  })
  if (res.status === 204) return undefined as T
  const body: unknown = await res.json()
  if (!res.ok) throw new ApiError(body as Problem)
  return body as T
}

export interface Workstream {
  readonly id: string
  readonly category: 'discussion' | 'invocation'
  readonly title: string
  readonly pinned: boolean
  readonly role: 'owner' | 'editor' | 'viewer'
  readonly currentSessionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface Session {
  readonly id: string
  readonly workstreamId: string
  readonly ordinal: number
  readonly agentId: string
  readonly phase: string
  readonly current: boolean
  readonly runtimeDefinitionVersion: string
  readonly createdAt: string
  readonly failure: { readonly code: string; readonly detail?: string } | null
  readonly liveSessionRuntime?: { readonly state: string; readonly podUid?: string }
}

export interface WorkstreamDetail extends Workstream {
  readonly sessions: readonly Session[]
  readonly projectionHead: number
}

export interface WorkstreamItem {
  readonly id: string
  readonly workstreamId: string
  readonly sessionId: string
  readonly turnId: string | null
  readonly kind: string
  readonly firstEventId: string
  readonly latestEventId: string
  readonly firstWorkstreamSeq: number
  readonly latestWorkstreamSeq: number
  readonly value: Record<string, unknown>
  readonly contentSha256: string
  readonly updatedAt: string
}

export interface WorkstreamTurn {
  readonly id: string
  readonly workstreamId: string
  readonly sessionId: string
  readonly turnOrdinal: number
  readonly purpose: 'user' | 'handoff'
  readonly status: 'running' | 'completed' | 'cancelled' | 'failed'
  readonly stopReason: string | null
  readonly usage: Record<string, unknown> | null
  readonly startedAt: string
  readonly endedAt: string | null
}

export interface PublicAgent {
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly label: string
  readonly description: string
  readonly availability: 'enabled' | 'unavailable' | 'deprecated'
}

export function listWorkstreams(): Promise<{ items: readonly Workstream[]; nextCursor: string | null }> {
  return request('/v1/workstreams')
}

export function getWorkstream(id: string): Promise<WorkstreamDetail> {
  return request(`/v1/workstreams/${id}`)
}

export function listItems(workstreamId: string): Promise<{ items: readonly WorkstreamItem[]; throughWorkstreamSeq: number; feedPosition: number }> {
  return request(`/v1/workstreams/${workstreamId}/items?limit=200`)
}

export function listTurns(workstreamId: string): Promise<{ turns: readonly WorkstreamTurn[] }> {
  return request(`/v1/workstreams/${workstreamId}/turns?limit=200`)
}

export function listAgents(): Promise<{ items: readonly PublicAgent[] }> {
  return request('/v1/agents')
}

export interface CreateWorkstreamRequest {
  readonly category: 'discussion' | 'invocation'
  readonly agentId: string
  readonly workspace: { readonly workspaceRef: string }
  readonly equipment: { readonly catalogueVersion: string; readonly resources: readonly unknown[] }
  readonly prompt: readonly { readonly type: string; readonly text: string }[]
}

export function createWorkstream(
  body: CreateWorkstreamRequest,
): Promise<{ command: { commandId: string }; workstream: Workstream; session: Session }> {
  return request('/v1/workstreams', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify(body),
  })
}

export function promptSession(sessionId: string, content: readonly { type: string; text: string }[]): Promise<unknown> {
  return request(`/v1/sessions/${sessionId}/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify({ content }),
  })
}

export function suspendSession(sessionId: string): Promise<unknown> {
  return request(`/v1/sessions/${sessionId}/suspend`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } })
}

export function cancelSession(sessionId: string): Promise<unknown> {
  return request(`/v1/sessions/${sessionId}/cancel`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } })
}

export function closeSession(sessionId: string): Promise<unknown> {
  return request(`/v1/sessions/${sessionId}/close`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } })
}

export interface FeedEvent {
  readonly workstreamId: string
  readonly position: number
  readonly throughWorkstreamSeq: number
  readonly operation: 'upsert' | 'remove' | 'status' | 'reset'
  readonly payload: Record<string, unknown>
}

/**
 * `EventSource` cannot send custom headers, so it cannot carry `Authorization: Bearer <principal>`
 * (this repo's fake-auth shim — see server.ts) — a hard platform limitation, not a preference, so
 * this reads the same SSE wire format over `fetch()` instead (the same construction already proven
 * in apps/web/test/server.test.ts's `collectFeedEvents`), with its own reconnect-after-position
 * loop standing in for `EventSource`'s built-in one. Applies each event once, in position order,
 * and reconnects with `?after=<last applied position>` on any drop — the resumable-feed contract
 * (docs/specs/14) itself doesn't depend on which HTTP mechanism carries it.
 */
export function subscribeFeed(
  workstreamId: string,
  initialAfter: number,
  onEvent: (event: FeedEvent) => void,
  onStatus?: (status: 'connected' | 'reconnecting') => void,
): () => void {
  let after = initialAfter
  let stopped = false
  let controller: AbortController | undefined

  async function connectOnce(): Promise<void> {
    controller = new AbortController()
    const res = await fetch(`/v1/workstreams/${workstreamId}/feed?after=${after}`, { headers: authHeader(), signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`feed connection failed: ${res.status}`)
    onStatus?.('connected')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffered.indexOf('\n\n')) !== -1) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        if (frame.startsWith('data: ')) {
          const event = JSON.parse(frame.slice('data: '.length)) as FeedEvent
          after = event.position
          onEvent(event)
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await connectOnce()
      } catch {
        // dropped connection — reconnect with `after` at the last applied position, never redelivering it
      }
      if (stopped) return
      onStatus?.('reconnecting')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  void loop()
  return () => {
    stopped = true
    controller?.abort()
  }
}

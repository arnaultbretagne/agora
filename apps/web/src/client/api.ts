// The product API, by hand, from contracts/api/control-plane.openapi.yaml — no framework, native
// `fetch`/DOM only.
//
// S12 rewrote this file against what the server actually serves. Everything the carried-over shell
// used to call and no server implements is GONE rather than stubbed: an activate/suspend/close/probe
// that answers 404 is worse than an absent function, because it implies a lifecycle the design does
// not have. There is no Session `phase` here for the same reason — a Session is not a state machine
// (ADR 0002), and a field named `phase` is an invitation to treat it as one.

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code?: string
  readonly detail?: string
}

export class ApiError extends Error {
  readonly problem: Problem
  constructor(problem: Problem) {
    super(problem.title)
    this.problem = problem
  }
}

function idempotencyKey(): string {
  return crypto.randomUUID()
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined) },
  })
  if (res.status === 204) return undefined as T
  const body: unknown = await res.json()
  if (!res.ok) throw new ApiError(body as Problem)
  return body as T
}

export interface WorkstreamRecord {
  readonly id: string
  readonly title: string
  readonly ownerPrincipal: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface IntentRequestBody {
  readonly power: 'on' | 'off'
  readonly harness: string
  readonly capabilities: readonly string[]
  readonly model: string
  readonly effort: string
  readonly persona: 'default'
}

export interface IntentAuthoringResult {
  readonly status: 'created' | 'replayed'
  readonly intentSeq: number
}

export interface WorkIntentView {
  readonly intentSeq: number
  readonly workGeneration: number
  readonly dueAt: string
  readonly attemptCount: number
  readonly blockingCause: string | null
  readonly claimed: boolean
  readonly note: string
}

export interface WorkstreamIntentView {
  readonly workstreamId: string
  readonly intent: IntentRequestBody
  readonly intentSeq: number
  readonly revisionSet: Record<string, unknown>
  readonly createdAt: string
  readonly work: WorkIntentView | null
}

/** The principal's Workstreams, creation order (GET /v1/workstreams). */
export function listWorkstreams(): Promise<readonly WorkstreamRecord[]> {
  return request('/v1/workstreams')
}

/** Creates a Workstream owned by the caller; the key replays the same Workstream (200) instead of creating twice. */
export function createWorkstream(body: { readonly title: string }): Promise<WorkstreamRecord> {
  return request('/v1/workstreams', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify(body),
  })
}

export function getWorkstream(id: string): Promise<WorkstreamRecord> {
  return request(`/v1/workstreams/${id}`)
}

/** Title only — the one Workstream field a human owns directly in S2. */
export function patchWorkstream(id: string, patch: { readonly title: string }): Promise<WorkstreamRecord> {
  return request(`/v1/workstreams/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** One complete desired state; the key is the authoring request key (same key + same content replays, different content conflicts). */
export function putIntent(id: string, intent: IntentRequestBody): Promise<IntentAuthoringResult> {
  return request(`/v1/workstreams/${id}/intent`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify(intent),
  })
}

/** Latest Intent event plus the operational work view — scheduling state, never a convergence proof. */
export function getIntent(id: string): Promise<WorkstreamIntentView> {
  return request(`/v1/workstreams/${id}/intent`)
}

/* ---------- S12: the reviewed public values, and what a Session actually is ---------- */

export interface CatalogueModel {
  readonly id: string
  /** Efforts hang off the model they apply to: a model change re-reports the efforts valid for IT. */
  readonly efforts: readonly string[]
}

export interface CatalogueHarness {
  readonly id: string
  readonly models: readonly CatalogueModel[]
}

export interface Catalogue {
  readonly revisionId: string | null
  readonly capabilities: readonly string[]
  readonly harnesses: readonly CatalogueHarness[]
}

/**
 * Every value an Intent may name. The browser selects from these and never invents one; the server
 * validates against the same view, so a selection this endpoint did not offer is refused rather
 * than quietly accepted.
 */
export function getCatalogue(): Promise<Catalogue> {
  return request('/v1/catalogue')
}

export interface SessionView {
  readonly id: string
  readonly ordinal: number
  readonly openedAt: string
  /** `(w, h]` — what the Session was born owing, fixed once (continuity.md). */
  readonly openingRange: { readonly w: number; readonly h: number }
  readonly restoredFromSaveId: string | null
  readonly podUid: string
  readonly provenance: Record<string, unknown>
  readonly contextId: string | null
  readonly processGeneration: number
  readonly attributionEndedAt: string | null
}

export interface LossExposure {
  readonly harnessId: string
  readonly saveId: string
  readonly frontierW: number
  readonly anchoredAt: string
  /** How much of the record is newer than the newest recovery point (CONT-012). */
  readonly factsSinceAnchor: number
}

export interface SessionsView {
  readonly headSeq: number
  readonly sessions: readonly SessionView[]
  readonly lossExposure: readonly LossExposure[]
}

/** The Workstream's Sessions and, with them, how much would be lost if execution ended now. */
export function listSessions(workstreamId: string): Promise<SessionsView> {
  return request(`/v1/workstreams/${workstreamId}/sessions`)
}

/* ---------- legacy product API (retired implementation) ---------- */

/* ---------- S4 conversation contract ---------- */

export interface ConversationItem {
  readonly id: string
  readonly sessionId: string
  readonly kind: string
  readonly entityKey: string
  readonly value: Record<string, unknown>
  readonly firstSeq: number
  readonly latestSeq: number
  readonly updatedAt: string
}


/** The prompt is a command: the key replays the same command; 202 means reserved, not delivered. */
export function listItems(workstreamId: string): Promise<{ readonly items: readonly ConversationItem[] }> {
  return request(`/v1/workstreams/${workstreamId}/items`)
}

export function promptSession(workstreamId: string, text: string): Promise<{ commandId: string; state: string }> {
  return request(`/v1/workstreams/${workstreamId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify({ text }),
  })
}

/**
 * A cancel names the exact turn it means to stop (S8 Step 5): by the time it arrives, that turn may
 * already have finished, and cancelling "whatever is active" would hit the next one. `cancelled`
 * comes back false when the named turn was no longer the active one — a safe no-op, not an error.
 */
export function cancelTurn(workstreamId: string, commandId: string): Promise<{ cancelled: boolean }> {
  return request(`/v1/workstreams/${workstreamId}/cancel`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey() },
    body: JSON.stringify({ commandId }),
  })
}

export interface PermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: string | null
}

/**
 * A request the agent is blocked on, with the options IT offered. The browser picks one of these
 * and nothing else — the same rule the Intent editor follows for the catalogue, for the same
 * reason: a value the server never published is a value nobody reviewed.
 */
export interface PendingPermission {
  readonly permissionId: string
  readonly toolCallId: string | null
  readonly title: string
  readonly options: readonly PermissionOption[]
}

export function listPendingPermissions(workstreamId: string): Promise<{ pending: readonly PendingPermission[] }> {
  return request(`/v1/workstreams/${workstreamId}/permissions/pending`)
}

export function decidePermission(workstreamId: string, permissionId: string, optionId: string): Promise<{ decided: boolean }> {
  return request(`/v1/workstreams/${workstreamId}/permissions/${encodeURIComponent(permissionId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId }),
  })
}

export interface FeedEvent {
  readonly position: number
  readonly operation: 'upsert' | 'remove' | 'status' | 'reset'
  readonly itemId: string | null
  readonly payload: Record<string, unknown>
  readonly throughSeq: number
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
    const res = await fetch(`/v1/workstreams/${workstreamId}/feed?after=${after}`, { signal: controller.signal })
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

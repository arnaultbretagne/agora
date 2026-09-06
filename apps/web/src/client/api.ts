/** Thin fetch wrapper over contracts/openapi/product-api.yaml — no framework, native `fetch`/DOM only (see ../../DECISION.md). */

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
  /** Absent when the Session runs as the harness default — the persona selector reads this to show what is actually in force. */
  readonly persona?: string
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
  /** The only persona values `POST /v1/workstreams` and `POST /v1/workstreams/{id}/sessions` accept for this Agent — anything else is refused with 409 `persona_unavailable`. */
  readonly personas: readonly string[]
}

export interface CatalogueAccessLevel {
  readonly access: string
  readonly label: string
  readonly description?: string
}

export interface CatalogueResource {
  readonly resource: string
  readonly label: string
  readonly description: string
  readonly accessLevels: readonly CatalogueAccessLevel[]
}

export interface EquipmentCatalogue {
  readonly version: string
  readonly resources: readonly CatalogueResource[]
}

export interface EquipmentResourceRequest {
  readonly resource: string
  readonly access: string
}

export interface EquipmentRequest {
  readonly catalogueVersion: string
  readonly resources: readonly EquipmentResourceRequest[]
}

/* ---------- S2 control-plane contract (contracts/api/control-plane.openapi.yaml) ---------- */

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

export function cancelTurn(workstreamId: string): Promise<{ cancelled: boolean }> {
  return request(`/v1/workstreams/${workstreamId}/cancel`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey() } })
}

export function listPendingPermissions(workstreamId: string): Promise<{ pending: readonly string[] }> {
  return request(`/v1/workstreams/${workstreamId}/permissions/pending`)
}

export function decidePermission(workstreamId: string, permissionId: string, optionId: string): Promise<{ decided: boolean }> {
  return request(`/v1/workstreams/${workstreamId}/permissions/${encodeURIComponent(permissionId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId }),
  })
}

/** Title and pin — the only two Workstream fields a human owns directly; everything else about a Workstream is derived from what actually happened to it. */
export function legacyPatchWorkstream(workstreamId: string, patch: { readonly title?: string; readonly pinned?: boolean }): Promise<Workstream> {
  return request(`/v1/workstreams/${workstreamId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify(patch),
  })
}

/** ACP's own union: a select takes a value id, a boolean option takes a state. */
export type ConfigValue = string | boolean

export interface RequestedConfigOption {
  readonly optionId: string
  readonly value: ConfigValue
}

export interface CreateWorkstreamRequest {
  readonly category: 'discussion' | 'invocation'
  readonly agentId: string
  readonly persona?: string
  readonly workspace: { readonly workspaceRef: string }
  readonly equipment: EquipmentRequest
  readonly prompt: readonly { readonly type: string; readonly text: string }[]
  /** Choices made in the composer, where no Agent is running to be told directly — the engine delivers them before the first prompt. */
  readonly configOptions?: readonly RequestedConfigOption[]
}

export interface OpenSessionRequest {
  readonly agentId: string
  readonly persona?: string
  readonly workspace: { readonly workspaceRef: string }
  readonly equipment: EquipmentRequest
  readonly activate: boolean
  /** Carries the configuration across: a new Session for the same conversation would otherwise start on the harness default rather than what the operator is looking at. */
  readonly configOptions?: readonly RequestedConfigOption[]
}

export interface AgentConfigOptions {
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly state: 'known' | 'probing' | 'unknown' | 'unavailable'
  readonly options: readonly unknown[]
  readonly observedAt?: string
  readonly detail?: string
}

/**
 * Persona and equipment are both frozen on a Session's launch envelope, so changing either on a
 * running Workstream is not a mutation — it is a new Session, which is exactly what this opens.
 * With `activate: true` the engine also carries the history across (docs/specs/06), so the operator
 * sees one continuous conversation rather than a restart.
 */
/** Re-materializes a suspended/idle Session's Runtime. Required before prompting one whose ACP connection is gone — see `promptSession`'s `runtime_unavailable`. */
/**
 * The Agent answers with its FULL option set, not just the one that changed, because changing one
 * may change what the others accept — so the response replaces the client's copy wholesale rather
 * than patching a single entry. A refusal arrives as 409 `config_option_rejected`.
 *
 * A Session whose Runtime has been reclaimed answers `{pending: true}` instead: the choice is
 * recorded and delivered when it next resumes. That is a success, not a failure — the caller shows
 * the chosen value and says it takes effect on the next message.
 */
export function legacyCreateWorkstream(
  body: CreateWorkstreamRequest,
): Promise<{ command: { commandId: string }; workstream: Workstream; session: Session }> {
  return request('/v1/workstreams', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey() },
    body: JSON.stringify(body),
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

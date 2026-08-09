import type { SessionId } from '@agora/domain'
import type {
  ACPBridgeEndpoint,
  CustodySnapshotRef,
  ListLaunchableAgentsResult,
  MaterializeSessionRuntimeRequest,
  Problem,
  SessionRuntimeStatus,
} from './types.js'

/**
 * mutualTLS-authenticated internal transport. Callers supply their own `fetch` (workload mTLS
 * identity, never a Browser bearer or OneCLI credential — those never reach this package).
 */
export interface SessionRuntimeControlTransport {
  readonly baseUrl: string
  readonly fetch: typeof fetch
}

export class SessionRuntimeControlError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    // Found live, P11: orchestration.ts's own failClosed only persists `error.message` (never the
    // full `.problem` object) as the Session's durable failure_detail — a bare `problem.title`
    // (e.g. "unexpected controller error") on its own told a live debugging session nothing about
    // WHAT was unexpected. `problem.detail` (when present) carries the real underlying message.
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title)
    this.name = 'SessionRuntimeControlError'
    this.problem = problem
  }
}

async function call<T>(transport: SessionRuntimeControlTransport, path: string, init: RequestInit): Promise<T> {
  const response = await transport.fetch(new URL(path, transport.baseUrl), init)
  if (response.status === 204) return undefined as T
  const body: unknown = await response.json()
  if (!response.ok) throw new SessionRuntimeControlError(body as Problem)
  return body as T
}

function runtimePath(id: SessionId, suffix = ''): string {
  return `/v1/sessions/${encodeURIComponent(id)}/runtime${suffix}`
}

export function listLaunchableAgents(transport: SessionRuntimeControlTransport): Promise<ListLaunchableAgentsResult> {
  return call(transport, '/v1/agents', { method: 'GET' })
}

/** Idempotent by (`sessionId`, `requestId`); accepts no arbitrary process spec (ADR-normative). */
export function materializeSessionRuntime(
  transport: SessionRuntimeControlTransport,
  id: SessionId,
  requestId: string,
  body: MaterializeSessionRuntimeRequest,
): Promise<SessionRuntimeStatus> {
  return call(transport, runtimePath(id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify(body),
  })
}

export function getSessionRuntime(
  transport: SessionRuntimeControlTransport,
  id: SessionId,
): Promise<SessionRuntimeStatus> {
  return call(transport, runtimePath(id), { method: 'GET' })
}

/** Idempotent `DELETE`: already-absent is a normal outcome, not an error. */
export function dematerializeSessionRuntime(
  transport: SessionRuntimeControlTransport,
  id: SessionId,
  requestId: string,
): Promise<SessionRuntimeStatus | undefined> {
  return call(transport, runtimePath(id), { method: 'DELETE', headers: { 'x-request-id': requestId } })
}

export function openACPConnection(
  transport: SessionRuntimeControlTransport,
  id: SessionId,
  requestId: string,
): Promise<ACPBridgeEndpoint> {
  return call(transport, runtimePath(id, '/acp-connections'), { method: 'POST', headers: { 'x-request-id': requestId } })
}

export function captureCustody(
  transport: SessionRuntimeControlTransport,
  id: SessionId,
  requestId: string,
  syncedThroughSeq: number,
): Promise<CustodySnapshotRef> {
  return call(transport, runtimePath(id, '/custody-snapshots'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify({ syncedThroughSeq }),
  })
}

// The owner request protocol (contracts/schemas/owner-request.schema.json; engine.md — Effect
// ownership and late requests). Shared by the engine client side and every owner server side.
import { createHash } from 'node:crypto'

export type TargetKind = 'concrete' | 'reserved'

export interface OwnerTarget {
  readonly kind: TargetKind
  readonly id: string
}

export interface OwnerRequest {
  readonly epoch: number
  readonly workstreamId: string
  readonly attemptKey: string
  readonly operation: string
  readonly target: OwnerTarget
  readonly payload: Record<string, unknown>
  readonly payloadDigest: string
  readonly revisionSet: Record<string, unknown>
}

export type OwnerResponse =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'completed'; readonly result: Record<string, unknown> }
  | { readonly kind: 'rejected_stale_epoch'; readonly recordedEpoch: number }
  | { readonly kind: 'rejected_key_mismatch'; readonly recordedDigest: string }
  | { readonly kind: 'unknown'; readonly detail: string }

/** SHA-256 over the canonical (key-sorted) JSON of the payload — the digest ownership is keyed on. */
export function payloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex')
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Operations that create, widen or activate authority or execution. Retired targets refuse these
 * forever; cleanup operations on the same concrete targets stay authorized (engine.md — retirement).
 */
const POSITIVE_OPERATIONS = new Set([
  'create_pod',
  'start_agent',
  'attach_grant',
  'open_relay',
  'open_context',
  'resume_context',
  'send_prompt',
])

export function isPositiveOperation(operation: string): boolean {
  return POSITIVE_OPERATIONS.has(operation)
}

export function isCleanupOperation(operation: string): boolean {
  return operation.startsWith('cleanup_') || operation === 'detach_grant' || operation === 'close_relay'
}

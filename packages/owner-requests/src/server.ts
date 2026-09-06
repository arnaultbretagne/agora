// OwnerServer helpers (engine.md — Effect ownership): every owner (runtime control S6, broker S7,
// and the S5 fakes) embeds this state machine instead of re-deciding the contract. The owner keeps
// one record per Workstream: the last accepted epoch and, per attempt key, the digest and recorded
// response. The helpers are pure: persistence is the owner's own.
import { type OwnerRequest, type OwnerResponse, isPositiveOperation, isCleanupOperation } from './protocol.js'

export interface OwnerRecord {
  readonly epoch: number
  readonly responses: ReadonlyMap<string, { readonly digest: string; readonly response: OwnerResponse }>
  readonly retiredTargets: ReadonlyMap<string, { readonly positiveBlocked: true }>
}

export function emptyOwnerRecord(): OwnerRecord {
  return { epoch: 0, responses: new Map(), retiredTargets: new Map() }
}

export interface OwnerDecisionInput {
  readonly record: OwnerRecord
  readonly request: OwnerRequest
}

export type OwnerDecision =
  | { readonly kind: 'process' }
  | { readonly kind: 'respond'; readonly response: OwnerResponse }

/** The pure gate every owner runs before touching its own downstream system. */
export function decideOwnerRequest({ record, request }: OwnerDecisionInput): OwnerDecision {
  if (request.epoch < record.epoch) {
    return { kind: 'respond', response: { kind: 'rejected_stale_epoch', recordedEpoch: record.epoch } }
  }
  const existing = record.responses.get(request.attemptKey)
  if (existing !== undefined) {
    if (existing.digest !== request.payloadDigest) {
      return { kind: 'respond', response: { kind: 'rejected_key_mismatch', recordedDigest: existing.digest } }
    }
    return { kind: 'respond', response: existing.response }
  }
  const retired = record.retiredTargets.get(request.target.id)
  if (retired !== undefined && request.target.kind === 'concrete' && isPositiveOperation(request.operation)) {
    // Retired targets refuse positive mutations forever; cleanup on the same concrete target stays
    // authorized (engine.md — retirement survives work-row deletion).
    return { kind: 'respond', response: { kind: 'rejected_stale_epoch', recordedEpoch: record.epoch } }
  }
  if (retired !== undefined && !isPositiveOperation(request.operation) && !isCleanupOperation(request.operation)) {
    return { kind: 'respond', response: { kind: 'rejected_stale_epoch', recordedEpoch: record.epoch } }
  }
  return { kind: 'process' }
}

/** Records the response an owner produced (or retained as unknown) for an attempt key. */
export function recordOwnerResponse(
  record: OwnerRecord,
  request: OwnerRequest,
  response: OwnerResponse,
): OwnerRecord {
  const responses = new Map(record.responses)
  responses.set(request.attemptKey, { digest: request.payloadDigest, response })
  return { ...record, responses, epoch: Math.max(record.epoch, request.epoch) }
}

/** Records a takeover: the owner's last accepted epoch advances to the issued one. */
export function recordEpoch(record: OwnerRecord, epoch: number): OwnerRecord {
  return { ...record, epoch: Math.max(record.epoch, epoch) }
}

export function retireTarget(record: OwnerRecord, targetId: string): OwnerRecord {
  const retiredTargets = new Map(record.retiredTargets)
  retiredTargets.set(targetId, { positiveBlocked: true })
  return { ...record, retiredTargets }
}

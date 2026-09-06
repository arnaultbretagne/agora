// The opening descriptor (S9 Step 5 — continuity.md, 009_sync.md). It fixes, once, what this
// Session's opening range is and which single Handoff command carries it.
//
// "Once" is the point. `(W, H]` is pinned at Session birth (H) and at restore (W); the command that
// delivers it is keyed deterministically by that range, so every completion of the descriptor —
// after a crash, on a later tick, in another process — finds the SAME command instead of reserving
// a second one. A second command for one range is a second delivery of the same prompt, which is
// exactly what CONT-005 forbids.
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { currentOpeningWindow, type OpeningWindow } from '@agora/journal'
import { replayDispatch, reserveDispatch, type DispatchRecord } from '@agora/acp'
import { SEED_POLICY_REVISION, renderHandoff, type RenderedHandoff } from './handoff/renderer.js'

export interface OpeningDescriptor {
  readonly w: number
  readonly h: number
  readonly contextId: string
  readonly saveId: string | null
  readonly seedPolicyRevision: string
  readonly commandId: string | null
  readonly handoffDigest: string | null
}

/**
 * The one request key for this Session's opening range. Deterministic, and deliberately built from
 * the range rather than from a clock or a random id: two processes completing the same descriptor
 * must collide on the `command_dispatches` unique key, not create two commands.
 */
export function openingRequestKey(sessionId: string, window: OpeningWindow): string {
  return `handoff:${sessionId}:${String(window.w)}:${String(window.h)}`
}

/**
 * The command id for a request key, derived rather than generated. The Handoff's descriptive URI
 * embeds the command id, so the id has to exist before the bytes it names are rendered — and a
 * derived id keeps a crashed-and-retried completion landing on the same command.
 */
export function openingCommandId(requestKey: string): string {
  const hex = createHash('sha256').update(requestKey).digest('hex')
  // RFC 4122 layout over the digest: version 5 (name-based), variant 10xx.
  const version = `5${hex.slice(13, 16)}`
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

export interface CompleteDescriptorRequest {
  readonly workstreamId: string
  readonly sessionId: string
  readonly contextId: string
}

export interface CompletedDescriptor {
  readonly descriptor: OpeningDescriptor
  /** The rendered Handoff, or null for an empty range (which dispatches nothing at all). */
  readonly handoff: RenderedHandoff | null
  readonly dispatch: DispatchRecord | null
}

/**
 * Completes the descriptor idempotently: discovers the existing command for this range if there is
 * one, and otherwise renders the Handoff and reserves exactly one. The render happens BEFORE the
 * reservation so a command never exists without the bytes it promises — and it is re-run on a
 * replay only to recover the digest, which is byte-identical by construction (the policy's
 * determinism clause is what makes that safe).
 *
 * Runs in the caller's transaction: the reservation must commit before any transport write.
 */
export async function completeOpeningDescriptor(client: pg.PoolClient, request: CompleteDescriptorRequest): Promise<CompletedDescriptor | null> {
  const window = await currentOpeningWindow(client, request.workstreamId)
  if (window === null) return null

  const empty: OpeningDescriptor = {
    w: window.w,
    h: window.h,
    contextId: request.contextId,
    saveId: window.saveId,
    seedPolicyRevision: SEED_POLICY_REVISION,
    commandId: null,
    handoffDigest: null,
  }
  // CONT-002: an empty range sends no Handoff. Not an empty one — none: an empty prompt would still
  // be a turn to admit, dispatch and prove.
  if (window.h <= window.w) return { descriptor: empty, handoff: null, dispatch: null }

  const requestKey = openingRequestKey(request.sessionId, window)
  const commandId = openingCommandId(requestKey)
  const existing = await replayDispatch(client, request.workstreamId, requestKey)
  const rendered = await renderHandoff(client, { workstreamId: request.workstreamId, commandId, w: window.w, h: window.h })
  if (rendered === null) return { descriptor: empty, handoff: null, dispatch: null }

  if (existing !== null) {
    return {
      descriptor: { ...empty, commandId: existing.id, handoffDigest: rendered.digest },
      handoff: rendered,
      dispatch: existing,
    }
  }

  const reserved = await reserveDispatch(client, {
    id: commandId,
    workstreamId: request.workstreamId,
    sessionId: request.sessionId,
    kind: 'handoff',
    // What was promised, recorded with the command: the range, the policy revision and the digest.
    // Recovery reads these; it never re-derives them from whatever the head happens to be later.
    request: { uri: rendered.uri, w: rendered.w, h: rendered.h, policyRevision: rendered.policyRevision, digest: rendered.digest, degraded: rendered.degraded },
    requestKey,
  })
  return {
    descriptor: { ...empty, commandId: reserved.id, handoffDigest: rendered.digest },
    handoff: rendered,
    dispatch: reserved,
  }
}

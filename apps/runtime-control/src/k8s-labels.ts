// Carried over from archive/pre-design-cleanup-2026-09-05:apps/session-runtime-controller/src/labels.ts
// (findings §7); changes: the S5/S6 identity — workstream, attempt key, incarnation — replaces the
// retired session/agent/grant labels. Every key is fixed; no user-controlled label keys.
import { createHash } from 'node:crypto'

export const LABEL_WORKSTREAM = 'agora.dev/workstream'
export const LABEL_ATTEMPT_KEY_HASH = 'agora.dev/attempt-key'
export const LABEL_INCARNATION = 'agora.dev/incarnation'
export const LABEL_APP = 'agora.dev/app'
export const APP_RUNTIME_CONTROLLED = 'runtime-controlled'

const NAME_SAFE = /[^a-z0-9-]/g

/** A non-reversible correlation label: the attempt key never rides a Pod label verbatim. */
export function attemptKeyLabel(attemptKey: string): string {
  return createHash('sha256').update(attemptKey).digest('hex').slice(0, 32)
}

export function incarnationLabel(workstreamId: string, slot: string): string {
  return createHash('sha256').update(`${workstreamId}:${slot}`).digest('hex').slice(0, 32)
}

export function requiredLabels(input: {
  readonly workstreamId: string
  readonly attemptKey: string
  readonly incarnation: string
}): Record<string, string> {
  return {
    [LABEL_APP]: APP_RUNTIME_CONTROLLED,
    [LABEL_WORKSTREAM]: input.workstreamId,
    [LABEL_ATTEMPT_KEY_HASH]: attemptKeyLabel(input.attemptKey),
    [LABEL_INCARNATION]: input.incarnation,
  }
}

export function podName(workstreamId: string, slot: string): string {
  return `agora-${workstreamId.slice(0, 8)}-${slot.replace(NAME_SAFE, '').slice(0, 20).toLowerCase()}`
}

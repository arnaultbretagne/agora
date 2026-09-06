// observation.session, extended with `live` (S8 Step 2/3; 002 Observation). S6 left the
// launchedContextBound branch as a placeholder (`null`, i.e. "acquisition incomplete") — this is
// the real ACP-facing evidence that replaces it. `unusable` from terminal/expired Pod evidence
// still overrides everything: a Pod that died with a context nominally live is unusable, not live.
import type { PodObservation, SessionObservationValue } from './types.js'

export interface AcpConnectionEvidence {
  readonly connected: boolean
  readonly contextId: string | null
  /** The generation the bound context was created under. */
  readonly contextProcessGeneration: number | null
  /** The Pod's currently observed process generation (S6 SESSION-A06: a restart invalidates evidence even if the Pod UID is unchanged). */
  readonly currentProcessGeneration: number
}

export function normalizeSessionWithAcp(input: {
  readonly pod: PodObservation | null
  readonly startupDeadlineSeconds: number
  readonly podAgeSeconds: number
  readonly acp: AcpConnectionEvidence | null
}): SessionObservationValue | null {
  if (input.pod === null) return null
  if (input.pod.phase === 'Succeeded' || input.pod.phase === 'Failed' || input.pod.startupDeadlineExpired) return 'unusable'
  if (input.acp !== null && input.acp.connected && input.acp.contextId !== null) {
    if (input.acp.contextProcessGeneration !== input.acp.currentProcessGeneration) {
      // The context was bound to a process that no longer exists (SESSION-A06): a lost/replaced
      // context is unusable, never silently treated as absent (which would re-open a second one).
      return 'unusable'
    }
    return 'live'
  }
  if (input.pod.phase === 'Running') return 'openable'
  return 'pending'
}

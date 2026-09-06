// Observation normalizers — Kubernetes part (002 observation). Pure functions over fresh
// inventory; they never read a persisted state row. Unavailable evidence is absent, never a value.
import type { ConstructionObservation, ConstructionMember } from '@agora/domain'
import { construction } from '@agora/domain'

export { construction }

export interface RuntimeFootprint {
  readonly workstreamId: string
  readonly podCount: number
  readonly unresolvedObligations: number
  readonly complete: boolean
}

/** observation.power (Kubernetes part): on iff any Pod exists in any phase or an obligation stands; off needs a complete empty listing. */
export function normalizePower(footprint: RuntimeFootprint): 'on' | 'off' | null {
  if (footprint.podCount > 0 || footprint.unresolvedObligations > 0) return 'on'
  return footprint.complete ? 'off' : null
}

export interface PodObservation {
  readonly uid: string
  readonly phase: string
  readonly imageId: string | null
  readonly admittedDigest: string | null
  readonly retiring: boolean
  readonly startupDeadlineExpired: boolean
  readonly harnessDigestFor: (admittedDigest: string) => string | null
}

/**
 * observation.construction (Kubernetes part): exactly one non-retiring Pod whose admitted digest
 * maps to the harness digest contributes {D}; Pending is coherent (002). Duplicates, terminal,
 * retiring, deadline-expired or unknown-image Pods contribute ⊥.
 */
export function normalizeConstruction(pods: readonly PodObservation[]): ConstructionObservation {
  const members: ConstructionMember[] = []
  for (const pod of pods) {
    if (pod.retiring || pod.startupDeadlineExpired) {
      members.push({ incoherent: true })
      continue
    }
    if (pod.phase === 'Succeeded' || pod.phase === 'Failed') {
      members.push({ incoherent: true })
      continue
    }
    const digest = pod.imageId !== null ? pod.harnessDigestFor(pod.imageId) : pod.admittedDigest !== null ? pod.harnessDigestFor(pod.admittedDigest) : null
    if (digest === null) {
      members.push({ incoherent: true })
      continue
    }
    members.push({ digest })
  }
  return construction(members)
}

/**
 * The reviewed digest mapping (S6 image evidence): an admitted or running image reference
 * contributes only when it is exactly one of the catalogue's pinned digests. A stale image (the
 * catalogue rotated since the Pod was admitted) maps to nothing — never guessed, never the last
 * known value.
 */
export function harnessDigestForCatalogue(catalogue: readonly { readonly imageDigest: string }[]): (digest: string) => string | null {
  const known = new Set(catalogue.map((entry) => entry.imageDigest))
  return (digest: string) => (known.has(digest) ? digest : null)
}

export type SessionObservationValue = 'pending' | 'openable' | 'unusable'

/** observation.session (Kubernetes part): ACP context evidence arrives in S8; the seam gates it. */
export function normalizeSession(input: {
  readonly pod: PodObservation | null
  readonly launchedContextBound: boolean | null
  readonly startupDeadlineSeconds: number
  readonly podAgeSeconds: number
}): SessionObservationValue | null {
  if (input.pod === null) return null
  if (input.pod.phase === 'Succeeded' || input.pod.phase === 'Failed' || input.pod.startupDeadlineExpired) return 'unusable'
  if (input.launchedContextBound === true) return null
  if (input.pod.phase === 'Running') return 'openable'
  return 'pending'
}

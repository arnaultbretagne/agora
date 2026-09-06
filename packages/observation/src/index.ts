// Observation normalizers — Kubernetes part (002 observation). Pure functions over fresh
// inventory; they never read a persisted state row. Unavailable evidence is absent, never a value.
import type { ConstructionObservation, ConstructionMember } from '@agora/domain'
import { construction } from '@agora/domain'
import type { PodObservation, SessionObservationValue } from './types.js'

export { construction }
export * from './grants.js'
export * from './types.js'
export * from './session.js'
export * from './config.js'
export * from './sync.js'

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

/**
 * S7 Step 6: observation.power ALSO counts every OneCLI Agent (granted or not), every attached or
 * effective grant, and every Broker relay binding — a missing Pod cannot hide any of these (002).
 * `null` (broker inventory unavailable) can still combine with a Kubernetes `on` — a positive
 * footprint from one owner suffices for `on` even while another is unreachable.
 */
export interface BrokerFootprint {
  readonly agentExists: boolean
  readonly hasAnyGrant: boolean
  readonly hasBinding: boolean
}

export function normalizePowerWithBroker(kubernetesFootprint: RuntimeFootprint, broker: BrokerFootprint | null): 'on' | 'off' | null {
  const kubernetes = normalizePower(kubernetesFootprint)
  if (kubernetes === 'on') return 'on'
  if (broker !== null && (broker.agentExists || broker.hasAnyGrant || broker.hasBinding)) return 'on'
  if (broker === null) return null // an unread broker inventory cannot prove off, even if Kubernetes alone is empty
  return kubernetes // 'off' or null, exactly as the Kubernetes-only rule already decided
}


/**
 * observation.construction (Kubernetes part): exactly one non-retiring Pod whose admitted digest
 * maps to the harness digest contributes {D}; Pending is coherent (002). Duplicates, terminal,
 * retiring, deadline-expired or unknown-image Pods contribute ⊥.
 */
export function normalizeConstruction(pods: readonly PodObservation[]): ConstructionObservation {
  return construction(pods.map((pod) => podMember(pod)))
}

function podMember(pod: PodObservation): ConstructionMember {
  if (pod.retiring || pod.startupDeadlineExpired) return { incoherent: true }
  if (pod.phase === 'Succeeded' || pod.phase === 'Failed') return { incoherent: true }
  const digest = pod.imageId !== null ? pod.harnessDigestFor(pod.imageId) : pod.admittedDigest !== null ? pod.harnessDigestFor(pod.admittedDigest) : null
  if (digest === null) return { incoherent: true }
  return { digest }
}

/**
 * S7 Step 6: a coherent envelope needs its unique Pod-bound selective OneCLI Agent and relay
 * binding too (002) — `agentBound` is the broker's own evidence that this Pod's incarnation has
 * exactly that. Omitting it (`undefined`) keeps S6's Kubernetes-only coherence unchanged, so
 * existing callers without a broker inventory yet are not forced to supply one.
 */
export function normalizeConstructionWithBinding(pods: readonly (PodObservation & { readonly agentBound?: boolean })[]): ConstructionObservation {
  const members = pods.map((pod): ConstructionMember => (pod.agentBound === false ? { incoherent: true } : podMember(pod)))
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

/** observation.session (Kubernetes-only evidence — session.ts's normalizeSessionWithAcp is the S8 form that also produces `live`). */
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

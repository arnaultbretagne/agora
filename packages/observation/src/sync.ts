// observation.sync (002 Observation, 009 SYNC, continuity.md "Current native proof and loss
// exposure"). Whether the live native context has actually incorporated the Workstream's record up
// to this Session's activation.
//
// Three outcomes, and the third one is the important one:
//
//   `current` — proven: the exact input, completed incorporation, continuing lineage.
//   `stale`   — proven absent, with nothing possibly-accepted outstanding. Authorizes a REFILL.
//   no value  — cannot tell. Blocks admission and authorizes nothing.
//
// The gap between "not proven present" and "proven absent" is the whole reason this file is careful.
// Collapsing them would turn every unprovable delivery into a resend of a prompt the context may
// already have acted on (CONT-005, CONT-006).
export interface OpeningDescriptor {
  readonly w: number
  readonly h: number
}

/** What the one Handoff command for this range is doing, if there is one. */
export type HandoffDeliveryState =
  | 'none'
  /** Reserved but provably never sent: nothing is outstanding, so absence is real. */
  | 'rejected_before_acceptance'
  | 'dispatched'
  | 'responded'
  /** Possibly accepted, response lost. Never becomes `stale` (CONT-005) and never authorizes a resend. */
  | 'unknown'

/** What the harness's custody driver could prove about the range, from the native context itself. */
export type DriverProof = 'incorporated' | 'not_incorporated' | 'unprovable'

export type SyncObservationValue = 'current' | 'stale'

export interface SyncEvidence {
  readonly descriptor: OpeningDescriptor | null
  readonly delivery: HandoffDeliveryState
  readonly proof: DriverProof
  /**
   * False when the lineage that made earlier evidence meaningful is gone — native compaction,
   * context replacement, a process the context no longer belongs to. A stored receipt never becomes
   * live proof (CONT-006), so this invalidates `current` regardless of everything else.
   */
  readonly lineageIntact: boolean
}

export function normalizeSync(evidence: SyncEvidence | null): SyncObservationValue | null {
  if (evidence === null || evidence.descriptor === null) return null
  const { descriptor, delivery, proof } = evidence

  // The empty range needs no prompt: there is nothing to incorporate, so nothing to prove.
  // CONT-002's cross-seeded first Session is exactly this — `W = H = 0`, and no empty Handoff.
  if (descriptor.h <= descriptor.w) return 'current'

  if (!evidence.lineageIntact) return null // evidence invalidated; admission gates, nothing is resent

  if (proof === 'incorporated' && delivery === 'responded') return 'current'

  // `stale` needs BOTH halves: the driver positively looked and did not find it, AND nothing is
  // outstanding that might already have been accepted. A `dispatched` or `unknown` command fails the
  // second half even when the first holds — the turn may be in flight or its response merely lost.
  if (proof === 'not_incorporated' && (delivery === 'none' || delivery === 'rejected_before_acceptance')) return 'stale'

  // Everything else — an unprovable proof, a responded command the driver cannot find, an
  // incorporated range whose command is still in flight — is honestly undecidable right now.
  return null
}

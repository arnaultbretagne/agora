// observation.anchor (S9 Step 4 — 002 Observation, ADR 0008). Pure normalization over a FRESH read
// of the Anchor for (Workstream, harness of the observed Pod) and the Save's non-opaque metadata,
// joined with the harness definition actually deployed.
//
// Two values and nothing else: `compatible` means this Save can be restored into this harness right
// now; `none` means it cannot, or there is nothing to restore. There is deliberately no third value
// for "maybe" — the rule tables act on this, and a maybe would either become a restore that fails
// halfway or a fresh start that silently threw away a healthy Anchor. What "cannot tell yet" looks
// like is `null`: acquisition incomplete, which schedules nothing (002).
import type { AnchorObservation } from '@agora/domain'

export interface AnchorEvidence {
  /** The Anchor's Save, or null when the Anchor does not exist. */
  readonly save: {
    readonly id: string
    readonly harnessId: string
    readonly formatId: string
    readonly formatVersion: number
    readonly driverRevision: string
    readonly imageDigest: string
    readonly workspaceDeps?: unknown
  } | null
  /** The harness definition of the Pod being observed. Null when the Pod's harness is unknown. */
  readonly harness: {
    readonly harnessId: string
    readonly supportedFormats: readonly { readonly formatId: string; readonly formatVersion: number }[]
    readonly acceptedDriverRevisions: readonly string[]
    readonly workspaceDeps?: Readonly<Record<string, string>>
  } | null
  /**
   * Whether a VERIFIED invalidation excludes this Save under this driver revision (CONT-008). A
   * store outage is not this: it leaves the whole read unavailable instead, because "we could not
   * check" must never render as "there is nothing to restore".
   */
  readonly invalidated: boolean
}

/**
 * `compatible` requires every one of: an Anchor exists, its Save belongs to this harness, the
 * deployed harness speaks the Save's format AND accepts its driver revision, every workspace
 * dependency the Save names is available at the version it names (CONT-011), and no verified
 * invalidation excludes the pair (CONT-008). Anything missing gives `none` — never a guess.
 *
 * The image digest is deliberately NOT compared: a harness upgrade is normal and does not make an
 * older Save unrestorable. The format and the driver revision are what actually decide whether the
 * bytes can be read; the digest only says which build wrote them.
 */
export function normalizeAnchor(evidence: AnchorEvidence): AnchorObservation {
  if (evidence.save === null || evidence.harness === null) return 'none'
  if (evidence.invalidated) return 'none'
  if (evidence.save.harnessId !== evidence.harness.harnessId) return 'none'

  const speaksFormat = evidence.harness.supportedFormats.some(
    (format) => format.formatId === evidence.save!.formatId && format.formatVersion === evidence.save!.formatVersion,
  )
  if (!speaksFormat) return 'none'
  if (!evidence.harness.acceptedDriverRevisions.includes(evidence.save.driverRevision)) return 'none'

  const declared = evidence.save.workspaceDeps
  if (declared !== undefined && declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    const available = evidence.harness.workspaceDeps ?? {}
    for (const [name, version] of Object.entries(declared as Record<string, unknown>)) {
      // An unversioned dependency cannot be matched, so it cannot be proven — and CONT-011 says an
      // unprovable exact resume is rejected rather than attempted and hoped for.
      if (typeof version !== 'string' || version.length === 0) return 'none'
      if (available[name] !== version) return 'none'
    }
  }

  return 'compatible'
}

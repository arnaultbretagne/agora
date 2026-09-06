// Anchor/Save compatibility against what is actually deployed (S9 Step 1 — CONT-008, CONT-011).
// Pure: it compares recorded metadata with an observed harness definition and says why a Save is
// not usable, never whether some store happened to be reachable. That separation is the point —
// "cannot reach the payload right now" is an outage, "this Save cannot be restored into this image"
// is an incompatibility, and only the second one ever justifies excluding the pair.
export interface ObservedHarness {
  readonly harnessId: string
  readonly imageDigest: string
  readonly driverRevision: string
  readonly supportedFormats: readonly { readonly formatId: string; readonly formatVersion: number }[]
  /** Workspace dependencies the target can actually provide, by name and version. */
  readonly workspaceDeps?: Readonly<Record<string, string>>
}

export interface SaveCompatibilityInput {
  readonly harnessId: string
  readonly formatId: string
  readonly formatVersion: number
  readonly imageDigest: string
  readonly workspaceDeps?: unknown
}

export type Compatibility =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'incompatible'; readonly reason: string }

/**
 * A Save restores only into a harness that speaks its format and can supply every workspace
 * dependency it names, at the version it names. An unversioned or unavailable dependency rejects
 * the exact resume (CONT-011) rather than pretending a transcript reconstructs missing workspace
 * state — the image digest may differ (an upgrade is normal), the format may not.
 */
export function checkCompatibility(save: SaveCompatibilityInput, harness: ObservedHarness): Compatibility {
  if (save.harnessId !== harness.harnessId) {
    return { kind: 'incompatible', reason: `Save belongs to harness ${save.harnessId}, target is ${harness.harnessId}` }
  }
  const formatSupported = harness.supportedFormats.some(
    (format) => format.formatId === save.formatId && format.formatVersion === save.formatVersion,
  )
  if (!formatSupported) {
    return { kind: 'incompatible', reason: `target does not support Save format ${save.formatId} v${String(save.formatVersion)}` }
  }

  const declared = save.workspaceDeps
  if (declared !== undefined && declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    const available = harness.workspaceDeps ?? {}
    for (const [name, version] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof version !== 'string' || version.length === 0) {
        return { kind: 'incompatible', reason: `workspace dependency ${name} is unversioned in the Save, so an exact resume cannot be proven (CONT-011)` }
      }
      const present = available[name]
      if (present === undefined) {
        return { kind: 'incompatible', reason: `workspace dependency ${name} is not available on the target (CONT-011)` }
      }
      if (present !== version) {
        return { kind: 'incompatible', reason: `workspace dependency ${name} is ${present} on the target, the Save requires ${version}` }
      }
    }
  }
  return { kind: 'compatible' }
}

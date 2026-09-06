// The custody driver contract (S9 — ADR 0008, continuity.md P12). Core defines the shape; each
// harness implements it in its OWN workspace (harnesses/<id>/src/driver.ts), because only the
// harness knows what its native state is. Core never reads the bytes it moves: `capture` hands back
// an opaque payload plus the metadata that makes it verifiable, `restore` places it, and
// `proveOpening` is what turns "the file is there" into evidence that the context actually
// incorporated the opening range.
export interface QuiescentCut {
  /** Proven quiescent: no turn in flight, no callback outstanding — cancellation alone is not this. */
  readonly podUid: string
  readonly processGeneration: number
  readonly contextId: string
}

export interface CapturedSave {
  readonly bytes: Uint8Array
  readonly checksum: string
  readonly formatId: string
  readonly formatVersion: number
  /**
   * What the driver can PROVE the native context had incorporated at the cut. It is the driver's
   * own evidence, never the journal head handed back unchanged (CONT-009).
   */
  readonly frontierW: number
  readonly nativeOrigin: unknown
  readonly workspaceDeps: unknown
}

export interface RestorePlacement {
  /** Where the bytes were placed, so a partial placement can be cleaned or resumed under the same attempt. */
  readonly path: string
  readonly byteLength: number
  readonly checksum: string
}

export interface OpeningDescriptor {
  readonly w: number
  readonly h: number
  readonly contextId: string
}

export type OpeningProof =
  | { readonly kind: 'incorporated'; readonly evidence: unknown }
  | { readonly kind: 'not_incorporated'; readonly reason: string }
  /** The driver cannot tell — which is never the same as "not incorporated" and never authorises a resend. */
  | { readonly kind: 'unprovable'; readonly reason: string }

export interface CustodyDriver {
  readonly harnessId: string
  readonly driverRevision: string
  readonly formatId: string
  readonly formatVersion: number
  capture(cut: QuiescentCut): Promise<CapturedSave>
  restore(bytes: Uint8Array): Promise<RestorePlacement>
  proveOpening(descriptor: OpeningDescriptor): Promise<OpeningProof>
}

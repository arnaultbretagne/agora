// observation.sync (002 Observation; S8 scope only — "current" for the empty opening range `W = H`;
// a non-empty range's native-proof machinery is S9's REFILL). Anything this module cannot decide
// from W/H alone stays unavailable: it never invents `stale` to authorize a blind retry, and never
// claims `current` for a range it has no S9 proof for yet.
export interface OpeningDescriptor {
  readonly w: number
  readonly h: number
}

export type SyncObservationValue = 'current' | 'stale'

export function normalizeSync(descriptor: OpeningDescriptor | null): SyncObservationValue | null {
  if (descriptor === null) return null
  if (descriptor.w === descriptor.h) return 'current' // the empty range needs no prompt — nothing to incorporate
  return null // W < H: S9's native proof of completed incorporation isn't wired yet — never guessed
}

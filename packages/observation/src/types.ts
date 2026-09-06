// Shared shapes across the normalizer modules — kept out of index.ts so session.ts (etc.) can
// import them without a circular import back through index.ts's own `export *`.
export interface PodObservation {
  readonly uid: string
  readonly phase: string
  readonly imageId: string | null
  readonly admittedDigest: string | null
  readonly retiring: boolean
  readonly startupDeadlineExpired: boolean
  readonly harnessDigestFor: (admittedDigest: string) => string | null
}

export type SessionObservationValue = 'pending' | 'openable' | 'live' | 'unusable'

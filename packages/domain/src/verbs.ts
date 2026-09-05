export type Verb =
  | 'BUILD'
  | 'TURN_OFF'
  | 'RESTORE'
  | 'START'
  | 'REFILL'
  | 'SET_MODEL'
  | 'SET_EFFORT'
  | 'GRANT'
  | 'REVOKE'

export const VERBS = ['BUILD', 'TURN_OFF', 'RESTORE', 'START', 'REFILL', 'SET_MODEL', 'SET_EFFORT', 'GRANT', 'REVOKE'] as const

export type VerbCatalogue = typeof VERBS

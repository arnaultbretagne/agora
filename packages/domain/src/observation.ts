import type { Authorization } from './authorization.js'

export type PowerObservation = 'on' | 'off'

export const POWER_VALUES = ['on', 'off'] as const

export type SessionObservation = 'pending' | 'openable' | 'live' | 'unusable'

export const SESSION_VALUES = ['pending', 'openable', 'live', 'unusable'] as const

export type AnchorObservation = 'compatible' | 'none'

export const ANCHOR_VALUES = ['compatible', 'none'] as const

export type SyncObservation = 'current' | 'stale'

export const SYNC_VALUES = ['current', 'stale'] as const

export interface ConstructionEmpty {
  readonly kind: 'empty'
}

export interface ConstructionSet {
  readonly kind: 'set'
  readonly digests: ReadonlySet<string>
  readonly incoherent: boolean
}

export type ConstructionObservation = ConstructionEmpty | ConstructionSet

export const CONSTRUCTION_EMPTY: ConstructionObservation = { kind: 'empty' }

export type ConstructionMember = { readonly digest: string } | { readonly incoherent: true }

export function construction(members: readonly ConstructionMember[]): ConstructionObservation {
  if (members.length === 0) {
    return CONSTRUCTION_EMPTY
  }
  const digests = new Set<string>()
  let incoherent = false
  for (const member of members) {
    if ('incoherent' in member) {
      incoherent = true
    } else if (digests.has(member.digest)) {
      incoherent = true
    } else {
      digests.add(member.digest)
    }
  }
  if (members.length > 1) {
    incoherent = true
  }
  return { kind: 'set', digests, incoherent }
}

export function isConstructionEmpty(observation: ConstructionObservation): boolean {
  return observation.kind === 'empty'
}

export function isExactlyConstruction(observation: ConstructionObservation, digest: string): boolean {
  return observation.kind === 'set' && !observation.incoherent && observation.digests.size === 1 && observation.digests.has(digest)
}

export type ObservationFieldName =
  | 'observation.power'
  | 'observation.construction'
  | 'observation.session'
  | 'observation.anchor'
  | 'observation.sync'
  | 'observation.model'
  | 'observation.effort'
  | 'observation.grants.attached'
  | 'observation.grants.effective'

export type ObservationValue<Name extends ObservationFieldName> = Name extends 'observation.power'
  ? PowerObservation
  : Name extends 'observation.construction'
    ? ConstructionObservation
    : Name extends 'observation.session'
      ? SessionObservation
      : Name extends 'observation.anchor'
        ? AnchorObservation
        : Name extends 'observation.sync'
          ? SyncObservation
          : Name extends 'observation.model'
            ? string
            : Name extends 'observation.effort'
              ? string
              : Name extends 'observation.grants.attached'
                ? ReadonlySet<Authorization>
                : Name extends 'observation.grants.effective'
                  ? ReadonlySet<Authorization>
                  : never

import type { Authorization } from '../authorization.js'
import type { CapabilityId, HarnessId } from '../ids.js'
import type { Intent } from '../intent.js'
import type { ObservationFieldName, ObservationValue } from '../observation.js'
import type { Result } from '../results.js'

export type RuleId =
  | 'POWER-001'
  | 'POWER-002'
  | 'POWER-003'
  | 'CONSTRUCT-001'
  | 'CONSTRUCT-002'
  | 'CONSTRUCT-003'
  | 'CAPS-001'
  | 'CAPS-002'
  | 'CAPS-003'
  | 'CAPS-004'
  | 'SESSION-001'
  | 'SESSION-002'
  | 'SESSION-003'
  | 'SESSION-004'
  | 'SESSION-005'
  | 'CONFIG-001'
  | 'CONFIG-002'
  | 'CONFIG-003'
  | 'SYNC-001'
  | 'SYNC-002'
  | 'CONVERGE-001'

export interface RuleResolution {
  readonly harnessDigest: (harness: HarnessId) => string
  readonly capabilityGrants: (capabilities: ReadonlySet<CapabilityId>) => ReadonlySet<Authorization>
}

export interface RuleFieldReader {
  readonly intent: Intent
  readonly resolve: RuleResolution
  observation<Name extends ObservationFieldName>(field: Name): ObservationValue<Name>
}

export interface RuleRow {
  readonly id: RuleId
  readonly needs: readonly ObservationFieldName[]
  readonly when: (input: RuleFieldReader) => boolean
  readonly result: Result
}

export interface RuleTable {
  readonly file: string
  readonly rows: readonly RuleRow[]
}

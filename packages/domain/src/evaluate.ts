import type { Authorization } from './authorization.js'
import type { AnchorObservation, ConstructionObservation, ObservationFieldName, ObservationValue, PowerObservation, SessionObservation, SyncObservation } from './observation.js'
import type { Intent } from './intent.js'
import { ORDERED_RULES } from './rules/index.js'
import type { RuleFieldReader, RuleId, RuleResolution, RuleTable } from './rules/rows.js'
import type { Result } from './results.js'

export type AcquisitionFailureReason = 'unavailable' | 'inconsistent'

export type Acquired<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AcquisitionFailureReason }

export interface ObservationReader {
  power(): Acquired<PowerObservation>
  construction(): Acquired<ConstructionObservation>
  session(): Acquired<SessionObservation>
  anchor(): Acquired<AnchorObservation>
  sync(): Acquired<SyncObservation>
  model(): Acquired<string>
  effort(): Acquired<string>
  grantsAttached(): Acquired<ReadonlySet<Authorization>>
  grantsEffective(): Acquired<ReadonlySet<Authorization>>
}

export type Evaluation =
  | { readonly kind: 'result'; readonly rule: RuleId; readonly result: Result }
  | {
      readonly kind: 'acquisition_incomplete'
      readonly rule: RuleId
      readonly field: ObservationFieldName
      readonly reason: AcquisitionFailureReason
    }

const READER_FIELDS: Record<ObservationFieldName, (reader: ObservationReader) => Acquired<unknown>> = {
  'observation.power': (reader) => reader.power(),
  'observation.construction': (reader) => reader.construction(),
  'observation.session': (reader) => reader.session(),
  'observation.anchor': (reader) => reader.anchor(),
  'observation.sync': (reader) => reader.sync(),
  'observation.model': (reader) => reader.model(),
  'observation.effort': (reader) => reader.effort(),
  'observation.grants.attached': (reader) => reader.grantsAttached(),
  'observation.grants.effective': (reader) => reader.grantsEffective(),
}

class AcquisitionFailed extends Error {
  constructor(
    readonly field: ObservationFieldName,
    readonly reason: AcquisitionFailureReason,
  ) {
    super(`acquisition of ${field} failed: ${reason}`)
  }
}

function fieldReader(
  intent: Intent,
  resolve: RuleResolution,
  reader: ObservationReader,
  acquired: Map<ObservationFieldName, unknown>,
): RuleFieldReader {
  return {
    intent,
    resolve,
    observation: (field) => {
      const cached = acquired.get(field)
      if (acquired.has(field)) {
        return cached as never
      }
      const value = READER_FIELDS[field](reader)
      if (!value.ok) {
        throw new AcquisitionFailed(field, value.reason)
      }
      acquired.set(field, value.value)
      return value.value as never
    },
  }
}

export function evaluate(
  intent: Intent,
  reader: ObservationReader,
  resolve: RuleResolution,
  tables: readonly RuleTable[] = ORDERED_RULES,
): Evaluation {
  const acquired = new Map<ObservationFieldName, unknown>()
  const input = fieldReader(intent, resolve, reader, acquired)
  for (const table of tables) {
    for (const row of table.rows) {
      try {
        if (row.when(input) && row.result.kind !== 'PASS') {
          return { kind: 'result', rule: row.id, result: row.result }
        }
      } catch (error) {
        if (error instanceof AcquisitionFailed) {
          return { kind: 'acquisition_incomplete', rule: row.id, field: error.field, reason: error.reason }
        }
        throw error
      }
    }
  }
  throw new Error('incomplete rule set: evaluation reached the end of the ordered tables after PASS without a terminal result')
}

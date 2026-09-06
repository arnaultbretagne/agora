import type { Acquired, ObservationFieldName, ObservationReader } from '@agora/domain'

/**
 * Fresh observation reads per tick (engine contract "Tick and acquisition"): the worker builds one
 * reader per claimed row and never carries evidence across ticks. `reader()` itself is async — a
 * real implementation (S8) fetches from the owners it wraps (runtime-control, broker) before
 * returning; the returned ObservationReader's own methods stay synchronous, a plain snapshot of
 * what was just fetched, never triggering another read mid-evaluation.
 */
export interface ObservationSource {
  reader(workstreamId: string): Promise<ObservationReader>
}

export type ScriptedField = Acquired<unknown> | (() => Acquired<unknown>)

export type ObservationScript = Partial<Record<ObservationFieldName, ScriptedField>>

export class FakeObservationSource implements ObservationSource {
  readonly readerCalls: string[] = []
  #script: ObservationScript

  constructor(script: ObservationScript = {}) {
    this.#script = script
  }

  setScript(script: ObservationScript): void {
    this.#script = script
  }

  readerCountFor(workstreamId: string): number {
    return this.readerCalls.filter((id) => id === workstreamId).length
  }

  async reader(workstreamId: string): Promise<ObservationReader> {
    this.readerCalls.push(workstreamId)
    const read = (field: ObservationFieldName): Acquired<unknown> => {
      const entry = this.#script[field]
      if (entry === undefined) {
        throw new Error(`FakeObservationSource has no script for ${field}`)
      }
      return typeof entry === 'function' ? entry() : entry
    }
    return {
      power: () => read('observation.power') as ReturnType<ObservationReader['power']>,
      construction: () => read('observation.construction') as ReturnType<ObservationReader['construction']>,
      session: () => read('observation.session') as ReturnType<ObservationReader['session']>,
      anchor: () => read('observation.anchor') as ReturnType<ObservationReader['anchor']>,
      sync: () => read('observation.sync') as ReturnType<ObservationReader['sync']>,
      model: () => read('observation.model') as ReturnType<ObservationReader['model']>,
      effort: () => read('observation.effort') as ReturnType<ObservationReader['effort']>,
      grantsAttached: () => read('observation.grants.attached') as ReturnType<ObservationReader['grantsAttached']>,
      grantsEffective: () => read('observation.grants.effective') as ReturnType<ObservationReader['grantsEffective']>,
    }
  }
}

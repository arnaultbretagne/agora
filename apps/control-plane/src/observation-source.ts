// The real ObservationSource (S8): the first wiring of the engine's evidence reads to the actual
// owners — runtime-control's Pod inventory and broker's Agent/grant inventory for the Workstream's
// current incarnation (packages/engine's own currentIncarnation lookup — the same one the verb
// runner uses, so both sides of BUILD/GRANT agree on which incarnation is "current"). session,
// model, effort, anchor and sync stay `unavailable`: they are ACP-facing evidence this slice does
// not yet produce (S8's remaining steps, S9) — never invented, never guessed from a partial read.
import type pg from 'pg'
import type { Acquired, ObservationFieldName, ObservationReader } from '@agora/domain'
import type { ObservationSource } from '@agora/engine'
import { currentIncarnation } from '@agora/engine'
import { normalizeConstructionWithBinding, normalizePowerWithBroker, normalizeGrantsAttached, normalizeGrantsEffective, harnessDigestForCatalogue, type BrokerFootprint, type PodObservation } from '@agora/observation'
import { fromWireGrantSet } from '@agora/domain'

const UNAVAILABLE: Acquired<never> = { ok: false, reason: 'unavailable' }

interface PodInventoryEntry {
  readonly uid: string
  readonly phase: string
  readonly imageId: string | null
  readonly admittedDigest: string | null
  readonly incarnation: string | null
  readonly forcedDeletion: boolean
}

interface WorkstreamInventory {
  readonly pods: readonly PodInventoryEntry[]
  readonly obligations: readonly unknown[]
  readonly complete: boolean
}

interface IncarnationInventory {
  readonly agentId: string
  readonly attached: readonly unknown[]
  readonly effective: readonly unknown[]
}

export interface HttpObservationSourceOptions {
  readonly pool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly brokerBaseUrl: string
  /** {harnessId: imageDigest} — the reviewed digest mapping construction checks admitted/running images against. */
  readonly harnessCatalogue: readonly { readonly imageDigest: string }[]
  readonly logger?: (message: string) => void
}

export class HttpObservationSource implements ObservationSource {
  constructor(private readonly options: HttpObservationSourceOptions) {}

  async reader(workstreamId: string): Promise<ObservationReader> {
    const incarnation = await currentIncarnation(this.options.pool, workstreamId)
    const [k8sInventory, brokerInventory] = await Promise.all([
      this.fetchK8sInventory(workstreamId),
      incarnation !== undefined ? this.fetchBrokerInventory(incarnation) : Promise.resolve(undefined),
    ])

    const read = (_field: ObservationFieldName): Acquired<never> => UNAVAILABLE
    const digestFor = harnessDigestForCatalogue(this.options.harnessCatalogue)

    return {
      power: () => {
        if (k8sInventory === undefined) return UNAVAILABLE
        const footprint = { workstreamId, podCount: k8sInventory.pods.length, unresolvedObligations: k8sInventory.obligations.length, complete: k8sInventory.complete }
        // Three states, not two: no incarnation ever existed (vacuously empty — nothing to prove
        // missing, off can still be reached), an incarnation exists but the broker read failed
        // (genuinely unread — blocks off), or a settled read (on iff it found anything).
        const broker: BrokerFootprint | null =
          incarnation === undefined
            ? { agentExists: false, hasAnyGrant: false, hasBinding: false }
            : brokerInventory === undefined
              ? null
              : { agentExists: true, hasAnyGrant: brokerInventory.attached.length > 0 || brokerInventory.effective.length > 0, hasBinding: true }
        const value = normalizePowerWithBroker(footprint, broker)
        return value === null ? UNAVAILABLE : { ok: true, value }
      },
      construction: () => {
        if (k8sInventory === undefined) return UNAVAILABLE
        const pods: readonly (PodObservation & { agentBound?: boolean })[] = k8sInventory.pods.map((pod) => ({
          uid: pod.uid,
          phase: pod.phase,
          imageId: pod.imageId,
          admittedDigest: pod.admittedDigest,
          retiring: pod.forcedDeletion,
          startupDeadlineExpired: false, // computed by runtime-control's own evidence endpoint per-Pod (S6); not yet cross-read here
          harnessDigestFor: digestFor,
          ...(pod.incarnation !== null ? { agentBound: pod.incarnation === incarnation && brokerInventory !== undefined } : {}),
        }))
        return { ok: true, value: normalizeConstructionWithBinding(pods) }
      },
      session: () => read('observation.session'),
      anchor: () => read('observation.anchor'),
      sync: () => read('observation.sync'),
      model: () => read('observation.model'),
      effort: () => read('observation.effort'),
      grantsAttached: () => normalizeGrantsAttached(brokerInventory === undefined ? undefined : { attached: fromWireGrantSet(brokerInventory.attached as never) }),
      grantsEffective: () => normalizeGrantsEffective(brokerInventory === undefined ? undefined : { effective: fromWireGrantSet(brokerInventory.effective as never) }),
    }
  }

  private async fetchK8sInventory(workstreamId: string): Promise<WorkstreamInventory | undefined> {
    try {
      const res = await fetch(`${this.options.runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
      if (!res.ok) return undefined
      return (await res.json()) as WorkstreamInventory
    } catch (error) {
      this.options.logger?.(`runtime-control inventory read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async fetchBrokerInventory(incarnation: string): Promise<IncarnationInventory | undefined> {
    try {
      const res = await fetch(`${this.options.brokerBaseUrl}/v1/incarnations/${incarnation}`)
      if (!res.ok) return undefined
      return (await res.json()) as IncarnationInventory
    } catch (error) {
      this.options.logger?.(`broker inventory read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

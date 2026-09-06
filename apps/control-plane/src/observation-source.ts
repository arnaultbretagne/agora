// The real ObservationSource (S8): the first wiring of the engine's evidence reads to the actual
// owners — runtime-control's Pod inventory and broker's Agent/grant inventory for the Workstream's
// current incarnation (packages/engine's own currentIncarnation lookup — the same one the verb
// runner uses, so both sides of BUILD/GRANT agree on which incarnation is "current"). session,
// model, effort and sync (Steps 2/3) are real; anchor stays `unavailable` — S9 scope, never
// invented, never guessed from a partial read.
import type pg from 'pg'
import type { Acquired, ObservationFieldName, ObservationReader } from '@agora/domain'
import type { ObservationSource } from '@agora/engine'
import { currentIncarnation } from '@agora/engine'
import {
  normalizeConstructionWithBinding,
  normalizePowerWithBroker,
  normalizeGrantsAttached,
  normalizeGrantsEffective,
  normalizeSessionWithAcp,
  normalizeModel,
  normalizeEffort,
  normalizeSync,
  harnessDigestForCatalogue,
  type BrokerFootprint,
  type PodObservation,
  type AcpConnectionEvidence,
  normalizeAnchor,
  type AnchorEvidence,
} from '@agora/observation'
import { fromWireGrantSet } from '@agora/domain'
import { currentSession, currentOpeningWindow, type CurrentSession } from '@agora/journal'
import { getAnchor, getSave, isExcluded } from '@agora/custody'
import { probeSession, type SessionProbeOptions } from './session-probe.js'

const UNAVAILABLE: Acquired<never> = { ok: false, reason: 'unavailable' }

interface PodInventoryEntry {
  readonly uid: string
  readonly name: string
  readonly phase: string
  readonly imageId: string | null
  readonly admittedDigest: string | null
  readonly incarnation: string | null
  readonly forcedDeletion: boolean
  readonly podIP: string | null
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
  /** The engine pool — currentIncarnation reads owner_attempts (agora_engine only). */
  readonly pool: pg.Pool
  /** The product pool — currentSession reads sessions, and a live probe's captured frames need it too (agora_product only). */
  readonly productPool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly brokerBaseUrl: string
  readonly bridgePort: number
  /** {harnessId: imageDigest} — the reviewed digest mapping construction checks admitted/running images against. */
  readonly harnessCatalogue: readonly { readonly imageDigest: string }[]
  /**
   * The deployed harness a Save would have to be restored into (S9 Step 4). Absent, observation.anchor
   * stays unavailable — which is right, not conservative: without knowing which formats and driver
   * revisions the target actually accepts, "compatible" would be a guess and "none" would be a lie.
   */
  readonly restoreHarness?: AnchorEvidence['harness']
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket (probeSession's own default). */
  readonly connect?: SessionProbeOptions['connect']
}

export class HttpObservationSource implements ObservationSource {
  constructor(private readonly options: HttpObservationSourceOptions) {}

  async reader(workstreamId: string): Promise<ObservationReader> {
    const incarnation = await currentIncarnation(this.options.pool, workstreamId)
    const [k8sInventory, brokerInventory, session, openingWindow, anchorEvidence] = await Promise.all([
      this.fetchK8sInventory(workstreamId),
      incarnation !== undefined ? this.fetchBrokerInventory(incarnation) : Promise.resolve(undefined),
      currentSession(this.options.productPool, workstreamId),
      currentOpeningWindow(this.options.productPool, workstreamId),
      this.fetchAnchorEvidence(workstreamId),
    ])

    const read = (_field: ObservationFieldName): Acquired<never> => UNAVAILABLE
    const digestFor = harnessDigestForCatalogue(this.options.harnessCatalogue)
    const establishedPod = k8sInventory?.pods.find((pod) => !pod.forcedDeletion)
    const establishedPodObservation: PodObservation | null =
      establishedPod === undefined
        ? null
        : {
            uid: establishedPod.uid,
            phase: establishedPod.phase,
            imageId: establishedPod.imageId,
            admittedDigest: establishedPod.admittedDigest,
            retiring: establishedPod.forcedDeletion,
            startupDeadlineExpired: false, // same documented gap as construction() below
            harnessDigestFor: digestFor,
          }
    const { acp: acpEvidence, configOptions } = await this.fetchAcpEvidence(workstreamId, session, establishedPod)
    const sessionValue = normalizeSessionWithAcp({ pod: establishedPodObservation, startupDeadlineSeconds: 0, podAgeSeconds: 0, acp: acpEvidence })
    // model/effort are only ever read off a snapshot taken while the Session was actually live —
    // config.ts's own contract (a value handed to it is trusted as already fresh); a stale/absent
    // probe means no snapshot at all, never a guessed or carried-over value.
    const configSnapshot =
      sessionValue === 'live' && configOptions !== null && configOptions.has('model') && configOptions.has('effort')
        ? { model: configOptions.get('model')!, effort: configOptions.get('effort')! }
        : null

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
      session: () => (sessionValue === null ? UNAVAILABLE : { ok: true, value: sessionValue }),
      // A fresh read every tick, never a cached verdict: an invalidation recorded a second ago has
      // to be able to turn `compatible` into `none` before the next RESTORE is selected.
      anchor: () => (anchorEvidence === null ? UNAVAILABLE : { ok: true, value: normalizeAnchor(anchorEvidence) }),
      sync: () => {
        const value = normalizeSync(openingWindow)
        return value === null ? UNAVAILABLE : { ok: true, value }
      },
      model: () => {
        const value = normalizeModel(configSnapshot)
        return value === null ? UNAVAILABLE : { ok: true, value }
      },
      effort: () => {
        const value = normalizeEffort(configSnapshot)
        return value === null ? UNAVAILABLE : { ok: true, value }
      },
      grantsAttached: () => normalizeGrantsAttached(brokerInventory === undefined ? undefined : { attached: fromWireGrantSet(brokerInventory.attached as never) }),
      grantsEffective: () => normalizeGrantsEffective(brokerInventory === undefined ? undefined : { effective: fromWireGrantSet(brokerInventory.effective as never) }),
    }
  }

  /**
   * The Anchor, its Save's non-opaque metadata and whether a verified invalidation excludes the
   * pair — all read fresh. Returns null when there is no harness definition to judge against, which
   * leaves the field unavailable rather than inventing a verdict.
   */
  private async fetchAnchorEvidence(workstreamId: string): Promise<AnchorEvidence | null> {
    const harness = this.options.restoreHarness
    if (harness === undefined || harness === null) return null
    const anchor = await getAnchor(this.options.productPool, workstreamId, harness.harnessId)
    if (anchor === null) return { save: null, harness, invalidated: false }
    const save = await getSave(this.options.productPool, anchor.saveId)
    if (save === null) return { save: null, harness, invalidated: false }
    return { save, harness, invalidated: await isExcluded(this.options.productPool, save.id, save.driverRevision) }
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

  /**
   * "Current configuration comes from a fresh owner snapshot..." (execution.md) — a fresh
   * `/v1/pods/:name/evidence` read proves the Pod's actual current process generation right now.
   * A generation that already disagrees with what the Session's context was bound to means that
   * process is provably gone: resuming its dead context would be meaningless, so this reports the
   * mismatch directly (never wasting a doomed connection) — normalizeSessionWithAcp turns that into
   * `unusable`, not a silently-reopened `pending`. Only a MATCHING generation is worth an actual
   * live probe (session-probe.ts), the one path that can report `live`.
   */
  private async fetchAcpEvidence(
    workstreamId: string,
    session: CurrentSession | null,
    pod: PodInventoryEntry | undefined,
  ): Promise<{ readonly acp: AcpConnectionEvidence | null; readonly configOptions: ReadonlyMap<string, string> | null }> {
    const none = { acp: null, configOptions: null }
    if (session === null || session.acpContextId === null || session.bridgeToken === null) return none
    if (pod === undefined || pod.podIP === null) return none
    const currentProcessGeneration = await this.fetchProcessGeneration(pod.name)
    if (currentProcessGeneration === undefined) return none // evidence unreachable — never guess connected/disconnected
    if (currentProcessGeneration !== session.processGeneration) {
      // The bound context belonged to a process that is provably gone — resuming it would be
      // meaningless (no config snapshot to read from a dead process either).
      return { acp: { connected: true, contextId: session.acpContextId, contextProcessGeneration: session.processGeneration, currentProcessGeneration }, configOptions: null }
    }
    const probe = await probeSession(
      { workstreamId, sessionId: session.sessionId, podIP: pod.podIP, bridgeToken: session.bridgeToken, contextId: session.acpContextId },
      { productPool: this.options.productPool, bridgePort: this.options.bridgePort, ...(this.options.logger ? { logger: this.options.logger } : {}), ...(this.options.connect ? { connect: this.options.connect } : {}) },
    )
    return {
      acp: { connected: probe.connected, contextId: session.acpContextId, contextProcessGeneration: session.processGeneration, currentProcessGeneration },
      configOptions: probe.connected ? probe.configOptions : null,
    }
  }

  private async fetchProcessGeneration(podName: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.options.runtimeControlBaseUrl}/v1/pods/${podName}/evidence`)
      if (!res.ok) return undefined
      const evidence = (await res.json()) as { processGeneration?: number }
      return typeof evidence.processGeneration === 'number' ? evidence.processGeneration : undefined
    } catch (error) {
      this.options.logger?.(`evidence read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

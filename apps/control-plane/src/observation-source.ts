// The real ObservationSource (S8): the first wiring of the engine's evidence reads to the actual
// owners — runtime-control's Pod inventory and broker's Agent/grant inventory for the Workstream's
// current incarnation (packages/engine's own currentIncarnation lookup — the same one the verb
// runner uses, so both sides of BUILD/GRANT agree on which incarnation is "current"). session,
// model, effort and sync (Steps 2/3) are real; anchor stays `unavailable` — S9 scope, never
// invented, never guessed from a partial read.
import type pg from 'pg'
import type { Acquired, ObservationFieldName, ObservationReader } from '@agora/domain'
import type { ObservationSource } from '@agora/engine'
import { currentIncarnation, loadLatestIntentEvent } from '@agora/engine'
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
  type SyncEvidence,
  type HandoffDeliveryState,
  type DriverProof,
} from '@agora/observation'
import { fromWireGrantSet, type Authorization } from '@agora/domain'
import { currentSession, currentOpeningWindow, type CurrentSession, type OpeningWindow } from '@agora/journal'
import { openingRequestKey } from './descriptor.js'
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
   * The deployed harnesses a Save could be restored into, by harness id (S9 Step 4, S10 Step 2).
   * The Anchor is per (Workstream, harness), so the one that matters is the harness this
   * Workstream's current Intent names — a Workstream on codex must not see claude-code's Anchor,
   * and switching back to claude-code must find it again untouched (CONT-007). Absent, or naming a
   * harness with no custody contract, observation.anchor stays unavailable: without knowing which
   * formats and driver revisions the target accepts, `compatible` would be a guess and `none` a lie.
   */
  readonly restoreHarnesses?: ReadonlyMap<string, NonNullable<AnchorEvidence['harness']>>
  /** What each harness calls the `model`/`effort` options (S10 Step 1). Absent, the Intent's own names are used. */
  readonly configOptionIds?: ReadonlyMap<string, { readonly model: string; readonly effort: string }>
  /** How each harness answers a configuration readback (S10 Step 1). Absent, `session/resume`. */
  readonly configReadback?: ReadonlyMap<string, 'resume' | 'set-config-noop'>
  /** How recent a driver verdict must be to count as current evidence (P7, continuity.md: bounded). */
  readonly syncProofMaxAgeMs?: number
  /**
   * How long ONE owner read may take (P7 — engine.ownerRequestTimeoutMs). Every fetch below carries
   * it: an owner that accepts the connection and answers nothing must make a field UNAVAILABLE,
   * which the rule tables already handle honestly, rather than freeze the tick that asked. Live, a
   * dropped packet (a NetworkPolicy denial, which never refuses) did exactly that.
   */
  readonly requestTimeoutMs?: number
  /** How long one ACP request to the Pod's adapter may take (P7 — harness.adapterRequestTimeoutMs). */
  readonly adapterRequestTimeoutMs?: number
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket (probeSession's own default). */
  readonly connect?: SessionProbeOptions['connect']
}

export class HttpObservationSource implements ObservationSource {
  constructor(private readonly options: HttpObservationSourceOptions) {}

  /**
   * The desired authorization set per capability-id list, refreshed by `reader()` before every
   * evaluation and read back SYNCHRONOUSLY by the rule tables' `resolve.capabilityGrants`.
   *
   * Keyed by the sorted capability ids because that is exactly what the answer depends on — the
   * reviewed catalogue plus this project's live credentials — so one entry serves every Workstream
   * asking the same question, whatever order a scan visits them in.
   */
  readonly #desiredGrants = new Map<string, ReadonlySet<Authorization>>()

  /**
   * What the rule tables ask for synchronously. It THROWS when there is no fresh answer, and that is
   * deliberate: an empty set means "this Workstream wants no authority", which is a completely
   * different claim from "the Broker did not answer". The empty-set stub that used to stand here is
   * why no Pod on the live cluster ever received a credential — every CAPS row read
   * nothing-desired-nothing-attached and passed.
   */
  desiredGrants(capabilityIds: readonly string[]): ReadonlySet<Authorization> {
    const key = [...capabilityIds].sort().join(',')
    const grants = this.#desiredGrants.get(key)
    if (grants === undefined) {
      throw new Error(`the desired authorization set for [${key}] is unavailable: the Broker did not answer, and an empty set would mean something else entirely`)
    }
    return grants
  }

  private async refreshDesiredGrants(capabilityIds: readonly string[]): Promise<void> {
    const key = [...capabilityIds].sort().join(',')
    try {
      const query = new URLSearchParams({ capabilityIds: capabilityIds.join(',') })
      const res = await fetch(`${this.options.brokerBaseUrl}/v1/capability-grants?${query.toString()}`, this.deadline())
      if (!res.ok) {
        this.#desiredGrants.delete(key)
        this.options.logger?.(`desired grants for [${key}] unavailable: broker answered HTTP ${String(res.status)}`)
        return
      }
      const body = (await res.json()) as { grants?: unknown }
      this.#desiredGrants.set(key, fromWireGrantSet(body.grants as never))
    } catch (error) {
      this.#desiredGrants.delete(key)
      this.options.logger?.(`desired grants for [${key}] unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The per-call deadline, as fetch options. Absent means unbounded, which only a test should choose. */
  private deadline(): { readonly signal?: AbortSignal } {
    return this.options.requestTimeoutMs === undefined ? {} : { signal: AbortSignal.timeout(this.options.requestTimeoutMs) }
  }

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
    // Refreshed before the rules run, because `resolve.capabilityGrants` is synchronous and must
    // never answer "nothing is desired" when the truth is "we could not ask".
    const intentForGrants = (await loadLatestIntentEvent(this.options.productPool, workstreamId))?.intent as { capabilities?: unknown } | undefined
    await this.refreshDesiredGrants(Array.isArray(intentForGrants?.capabilities) ? (intentForGrants.capabilities as readonly string[]) : [])
    const { acp: acpEvidence, configOptions } = await this.fetchAcpEvidence(workstreamId, session, establishedPod)
    // Read back under the ids THIS harness uses: codex reports effort as `reasoning_effort`, and
    // looking for `effort` there would silently produce "no snapshot" — which reads as an
    // unavailable observation, which stalls CONFIG forever rather than failing visibly.
    const observedHarness = (await loadLatestIntentEvent(this.options.productPool, workstreamId))?.intent as { harness?: unknown } | undefined
    const optionIds =
      (typeof observedHarness?.harness === 'string' ? this.options.configOptionIds?.get(observedHarness.harness) : undefined) ?? { model: 'model', effort: 'effort' }
    const syncEvidence = await this.fetchSyncEvidence(workstreamId, session, openingWindow, establishedPod, acpEvidence)
    const sessionValue = normalizeSessionWithAcp({ pod: establishedPodObservation, startupDeadlineSeconds: 0, podAgeSeconds: 0, acp: acpEvidence })
    // model/effort are only ever read off a snapshot taken while the Session was actually live —
    // config.ts's own contract (a value handed to it is trusted as already fresh); a stale/absent
    // probe means no snapshot at all, never a guessed or carried-over value.
    const configSnapshot =
      sessionValue === 'live' && configOptions !== null && configOptions.has(optionIds.model) && configOptions.has(optionIds.effort)
        ? { model: configOptions.get(optionIds.model)!, effort: configOptions.get(optionIds.effort)! }
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
        const value = normalizeSync(syncEvidence)
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
  /**
   * observation.sync's inputs, all read fresh: the fixed opening range, what the one Handoff command
   * for it is doing, and the driver's own verdict about the LIVE context — asked for every tick and
   * accepted only while it is recent (continuity.md: bounded current evidence). A verdict that is
   * missing, stale, or about a different descriptor leaves the field undecidable, which gates
   * admission rather than authorizing a resend.
   */
  private async fetchSyncEvidence(
    workstreamId: string,
    session: CurrentSession | null,
    openingWindow: OpeningWindow | null,
    pod: PodInventoryEntry | undefined,
    acpEvidence: AcpConnectionEvidence | null,
  ): Promise<SyncEvidence | null> {
    if (openingWindow === null) return null
    const descriptor = { w: openingWindow.w, h: openingWindow.h }
    if (openingWindow.h <= openingWindow.w) {
      // The empty range: nothing to deliver and nothing to prove, so no Pod round trip at all.
      return { descriptor, delivery: 'none', proof: 'incorporated', lineageIntact: true }
    }
    if (session === null || session.acpContextId === null || pod === undefined) return null

    const delivery = await this.fetchHandoffDelivery(workstreamId, session, openingWindow)
    const digest = delivery.digest
    const lineageIntact = acpEvidence !== null && acpEvidence.connected && acpEvidence.contextProcessGeneration === acpEvidence.currentProcessGeneration
    if (!lineageIntact) return { descriptor, delivery: delivery.state, proof: 'unprovable', lineageIntact: false }

    const proof = await this.fetchDriverProof(pod.name, session, openingWindow, digest)
    if (proof === null) return { descriptor, delivery: delivery.state, proof: 'unprovable', lineageIntact }
    return { descriptor, delivery: delivery.state, proof, lineageIntact }
  }

  /** The one Handoff command for this range, by its deterministic request key — never "the latest one". */
  private async fetchHandoffDelivery(
    workstreamId: string,
    session: CurrentSession,
    window: OpeningWindow,
  ): Promise<{ state: HandoffDeliveryState; digest: string | null }> {
    const result = await this.options.productPool.query(
      'SELECT state, request FROM command_dispatches WHERE workstream_id = $1 AND request_key = $2',
      [workstreamId, openingRequestKey(session.sessionId, window)],
    )
    if (result.rowCount === 0) return { state: 'none', digest: null }
    const row = result.rows[0] as { state: string; request: { digest?: unknown } }
    const state: HandoffDeliveryState =
      row.state === 'dispatched' || row.state === 'responded' || row.state === 'unknown' || row.state === 'rejected_before_acceptance'
        ? row.state
        : 'none' // `reserved`: committed but not yet sent, so nothing is outstanding on the wire
    return { state, digest: typeof row.request?.digest === 'string' ? row.request.digest : null }
  }

  private async fetchDriverProof(
    podName: string,
    session: CurrentSession,
    window: OpeningWindow,
    handoffDigest: string | null,
  ): Promise<DriverProof | null> {
    const base = `${this.options.runtimeControlBaseUrl}/v1/pods/${podName}/custody`
    try {
      await fetch(`${base}/request-proof`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextId: session.acpContextId, processGeneration: session.processGeneration, w: window.w, h: window.h, handoffDigest }),
        ...this.deadline(),
      })
      const query = new URLSearchParams({ contextId: session.acpContextId ?? '', maxAgeMs: String(this.options.syncProofMaxAgeMs ?? 5_000) })
      if (handoffDigest !== null) query.set('handoffDigest', handoffDigest)
      const response = await fetch(`${base}/proof-outcome?${query.toString()}`, this.deadline())
      if (!response.ok) return null
      const outcome = (await response.json()) as { verdict?: DriverProof } | null
      return outcome?.verdict ?? null
    } catch (error) {
      // Unreachable is not evidence of anything. The field stays undecidable.
      this.options.logger?.(`sync proof for ${podName} unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private async fetchAnchorEvidence(workstreamId: string): Promise<AnchorEvidence | null> {
    const harnesses = this.options.restoreHarnesses
    if (harnesses === undefined || harnesses.size === 0) return null
    const intent = await loadLatestIntentEvent(this.options.productPool, workstreamId)
    const harnessId = (intent?.intent as { harness?: unknown } | undefined)?.harness
    if (typeof harnessId !== 'string') return null
    const harness = harnesses.get(harnessId)
    if (harness === undefined) return null
    const anchor = await getAnchor(this.options.productPool, workstreamId, harness.harnessId)
    if (anchor === null) return { save: null, harness, invalidated: false }
    const save = await getSave(this.options.productPool, anchor.saveId)
    if (save === null) return { save: null, harness, invalidated: false }
    return { save, harness, invalidated: await isExcluded(this.options.productPool, save.id, save.driverRevision) }
  }

  private async fetchK8sInventory(workstreamId: string): Promise<WorkstreamInventory | undefined> {
    try {
      const res = await fetch(`${this.options.runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`, this.deadline())
      if (!res.ok) return undefined
      return (await res.json()) as WorkstreamInventory
    } catch (error) {
      this.options.logger?.(`runtime-control inventory read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async fetchBrokerInventory(incarnation: string): Promise<IncarnationInventory | undefined> {
    try {
      const res = await fetch(`${this.options.brokerBaseUrl}/v1/incarnations/${incarnation}`, this.deadline())
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
    // What this harness needs in order to answer "what is your current configuration?" — declared in
    // the reviewed definition, because the two pinned adapters answer it differently.
    const intent = (await loadLatestIntentEvent(this.options.productPool, workstreamId))?.intent as { harness?: unknown; model?: unknown } | undefined
    const harnessId = typeof intent?.harness === 'string' ? intent.harness : undefined
    const readback = harnessId === undefined ? undefined : this.options.configReadback?.get(harnessId)
    const optionIds = harnessId === undefined ? undefined : this.options.configOptionIds?.get(harnessId)
    const probe = await probeSession(
      {
        workstreamId,
        sessionId: session.sessionId,
        podIP: pod.podIP,
        bridgeToken: session.bridgeToken,
        contextId: session.acpContextId,
        ...(readback !== undefined ? { configReadback: readback } : {}),
        ...(typeof intent?.model === 'string' ? { desiredModel: intent.model } : {}),
        ...(optionIds !== undefined ? { modelOptionId: optionIds.model } : {}),
      },
      {
        productPool: this.options.productPool,
        bridgePort: this.options.bridgePort,
        ...(this.options.adapterRequestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.adapterRequestTimeoutMs } : {}),
        ...(this.options.logger ? { logger: this.options.logger } : {}),
        ...(this.options.connect ? { connect: this.options.connect } : {}),
      },
    )
    return {
      acp: { connected: probe.connected, contextId: session.acpContextId, contextProcessGeneration: session.processGeneration, currentProcessGeneration },
      configOptions: probe.connected ? probe.configOptions : null,
    }
  }

  private async fetchProcessGeneration(podName: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.options.runtimeControlBaseUrl}/v1/pods/${podName}/evidence`, this.deadline())
      if (!res.ok) return undefined
      const evidence = (await res.json()) as { processGeneration?: number }
      return typeof evidence.processGeneration === 'number' ? evidence.processGeneration : undefined
    } catch (error) {
      this.options.logger?.(`evidence read failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

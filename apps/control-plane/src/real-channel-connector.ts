// Real bridge connector for AgentChannels (S8 Steps 4b/5 prerequisite: prompt dispatch through the
// actual harness Pod, not the S4 stub). Resumes the Session's own ACP context — already bound by
// START, never a fresh session/new here — over a connection to the harness Pod's real bridge.
// Refuses to connect at all (never silently a fresh context) against a binding at an older process
// generation: the same defensive check START and the observation probe make (session-probe.ts) —
// resuming a dead process's context would be meaningless; START must rebind first.
import type pg from 'pg'
import { connectBridge, type BridgeConnection } from '@agora/acp'
import { currentSession } from '@agora/journal'
import { usableBridgeToken } from './bridge-token.js'
import type { ChannelConnection, ChannelConnector } from './agent-channel.js'

export interface RealChannelConnectorOptions {
  readonly productPool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly bridgePort: number
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket. */
  readonly connect?: (options: { readonly url: string; readonly token: string }) => Promise<BridgeConnection>
}

interface PodInventoryEntry {
  readonly name: string
  readonly forcedDeletion: boolean
  readonly podIP: string | null
  readonly incarnation: string | null
}

/** Never a silent fallback to "no channel" — the caller (AgentChannels.ensure(), ultimately
 * http.ts's prompt handler) sees exactly why no bridge is reachable right now. */
export class NoBridgeAvailableError extends Error {
  constructor(reason: string) {
    super(`cannot connect to the harness bridge: ${reason}`)
    this.name = 'NoBridgeAvailableError'
  }
}

export class RealChannelConnector implements ChannelConnector {
  constructor(private readonly options: RealChannelConnectorOptions) {}

  async connect(workstreamId: string): Promise<ChannelConnection> {
    const session = await currentSession(this.options.productPool, workstreamId)
    if (session === null || session.bridgeToken === null || session.acpContextId === null) {
      throw this.refused(workstreamId, 'no bound ACP context yet (START has not caught up)')
    }
    const pod = await this.findEstablishedPod(workstreamId)
    if (pod === undefined || pod.podIP === null) {
      throw this.refused(workstreamId, 'no established Pod with a reachable address')
    }
    const currentGeneration = await this.fetchProcessGeneration(pod.name)
    if (currentGeneration === undefined) {
      throw this.refused(workstreamId, 'runtime-control evidence is unreachable')
    }
    if (currentGeneration !== session.processGeneration) {
      throw this.refused(workstreamId, 'the bound context is not the current process generation (a restart happened; START must rebind first)')
    }
    // A converged Workstream does not tick, and nothing else here renews: a prompt arriving after
    // an hour of quiet is exactly where a spent bridge token surfaces, and it surfaces to a person.
    const token = await usableBridgeToken(
      { productPool: this.options.productPool, runtimeControlBaseUrl: this.options.runtimeControlBaseUrl, ...(this.options.logger ? { logger: this.options.logger } : {}) },
      workstreamId,
      session,
      pod.incarnation,
    )
    if (token === null) throw this.refused(workstreamId, 'the bridge token is spent and runtime-control would not renew it for this incarnation')
    const connect = this.options.connect ?? connectBridge
    const bridge = await connect({ url: `ws://${pod.podIP}:${this.options.bridgePort}/`, token })
    return { stream: bridge.stream, close: () => bridge.close(), existingContextId: session.acpContextId }
  }

  private refused(workstreamId: string, reason: string): NoBridgeAvailableError {
    this.options.logger?.(`bridge connect refused for ${workstreamId}: ${reason}`)
    return new NoBridgeAvailableError(reason)
  }

  private async findEstablishedPod(workstreamId: string): Promise<PodInventoryEntry | undefined> {
    const res = await fetch(`${this.options.runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
    if (!res.ok) return undefined
    const inventory = (await res.json()) as { pods: readonly PodInventoryEntry[] }
    return inventory.pods.find((pod) => !pod.forcedDeletion)
  }

  private async fetchProcessGeneration(podName: string): Promise<number | undefined> {
    const res = await fetch(`${this.options.runtimeControlBaseUrl}/v1/pods/${podName}/evidence`)
    if (!res.ok) return undefined
    const evidence = (await res.json()) as { processGeneration?: number }
    return typeof evidence.processGeneration === 'number' ? evidence.processGeneration : undefined
  }
}

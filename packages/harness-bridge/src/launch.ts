// Waits on the runtime-control launch seam before the bridge ever spawns the adapter (execution.md
// — "the harness container waits on the seam until the control plane confirms the Agora Session
// exists"). Polls the same evidence endpoint apps/runtime-control/src/owner-api.ts already serves
// — no separate wait protocol. The bridge token minted at gate release goes to the control plane
// in the gate_release owner-response, never here: this process only needs to know the gate opened.
import { spawn } from 'node:child_process'
import { adapterProcessFrom, startBridgeServer, type BridgeServer } from './bridge-server.js'
import { placeOfferedSave, startCustodyAgent, type PlacementOffer } from './custody-agent.js'
import type { CustodyDriver } from '@agora/custody'
import { initializeAdapter } from './handshake.js'

export interface LaunchOptions {
  readonly evidenceUrl: string
  readonly pollIntervalMs?: number
  readonly incarnation: string
  readonly bridgeAuthSecret: string
  readonly bridgePort: number
  readonly adapterCommand: readonly string[]
  /** The workspace root the adapter was launched with — the `cwd` its own handshake is made against. */
  readonly workspaceRoot?: string
  /**
   * S9: this harness's custody driver and where to talk to runtime-control about it. Absent, this
   * Pod neither restores nor is captured — which is the S8 behaviour, unchanged.
   */
  readonly custody?: { readonly driver: CustodyDriver; readonly placementUrlBase: string }
  /** The Pod's own UID from the downward API — half of a Save's capture key, so never self-asserted. */
  readonly podUid?: string
  readonly onLog?: (message: string) => void
}

interface SeamEvidence {
  readonly seam: { readonly released: boolean } | null
  readonly custody?: PlacementOffer | null
}

/**
 * Waits at the seam, and — if a Save is offered while waiting — fetches and places it before the
 * gate can open. The ordering is the point: runtime-control will not release the gate until the
 * placement it staged has been verified, so the adapter never starts against a transcript that is
 * absent, half-written or not the one the Save records.
 *
 * A placement that fails is retried on the next poll rather than escalated. The gate stays shut
 * either way, which is the honest outcome: the alternative — launching anyway — would produce a
 * context indistinguishable from a genuine resume.
 */
export async function waitForGateRelease(options: Pick<LaunchOptions, 'evidenceUrl' | 'pollIntervalMs' | 'custody' | 'onLog'>): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const log = options.onLog ?? (() => {})
  let placed: string | null = null
  for (;;) {
    try {
      const res = await fetch(options.evidenceUrl)
      if (res.ok) {
        const evidence = (await res.json()) as SeamEvidence
        const offer = evidence.custody ?? null
        if (offer !== null && offer.saveId !== placed) {
          if (options.custody === undefined) {
            // The gate will never open, and that is correct: runtime-control staged a restore this
            // Pod is not configured to place, so launching would resume nothing while looking as if
            // it had. Say so on every poll rather than failing silently.
            log(`a Save is offered for this Pod but no custody paths were configured; the gate stays shut`)
          } else {
            await placeOfferedSave({ custodyUrlBase: options.custody.placementUrlBase, driver: options.custody.driver }, offer, log)
            placed = offer.saveId
          }
        }
        if (evidence.seam?.released === true) return
      }
    } catch (error) {
      log(`waiting at the seam, retrying: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

export async function launch(options: LaunchOptions): Promise<BridgeServer> {
  await waitForGateRelease(options)
  const [command, ...args] = options.adapterCommand
  if (command === undefined) throw new Error('adapterCommand must name at least the binary to run')
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  const adapter = adapterProcessFrom(child)

  // The process-level handshake, done once, by whoever owns the process. Control-plane connections
  // then go straight to `session/*` — codex-acp refuses a second `initialize` outright
  // ("Already initialized"), and both adapters accept `session/new` on a connection that never
  // initialized, so re-initializing per verb was never buying anything anyway.
  const handshake = await initializeAdapter({ adapter, workspaceRoot: options.workspaceRoot ?? '/workspace' })
  options.onLog?.(`adapter initialized: ${String(handshake.agentName)}@${String(handshake.agentVersion)} (protocol v${String(handshake.protocolVersion)})`)
  // Custody answers run beside the bridge, never through it: a capture is asked for exactly when a
  // shutdown is closing the bridge's own connections.
  if (options.custody !== undefined && options.podUid !== undefined) {
    startCustodyAgent({
      evidenceUrl: options.evidenceUrl,
      custodyUrlBase: options.custody.placementUrlBase,
      driver: options.custody.driver,
      podUid: options.podUid,
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
    })
  }
  return startBridgeServer({
    port: options.bridgePort,
    incarnation: options.incarnation,
    bridgeAuthSecret: options.bridgeAuthSecret,
    adapter,
    ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
  })
}

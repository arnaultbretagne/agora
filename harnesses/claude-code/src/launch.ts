// Waits on the runtime-control launch seam before the bridge ever spawns the adapter (execution.md
// — "the harness container waits on the seam until the control plane confirms the Agora Session
// exists"). Polls the same evidence endpoint apps/runtime-control/src/owner-api.ts already serves
// — no separate wait protocol. The bridge token minted at gate release goes to the control plane
// in the gate_release owner-response, never here: this process only needs to know the gate opened.
import { spawn } from 'node:child_process'
import { adapterProcessFrom, startBridgeServer, type BridgeServer } from './bridge-server.js'
import { placeOfferedSave, startCustodyAgent, type PlacementOffer } from './custody-agent.js'

export interface LaunchOptions {
  readonly evidenceUrl: string
  readonly pollIntervalMs?: number
  readonly incarnation: string
  readonly bridgeAuthSecret: string
  readonly bridgePort: number
  readonly adapterCommand: readonly string[]
  /** S9: where a restored transcript is placed, and where a capture is posted back. Absent, this Pod neither restores nor is captured. */
  readonly custody?: { readonly harnessHome: string; readonly workspaceRoot: string; readonly placementUrlBase: string }
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
            await placeOfferedSave({ custodyUrlBase: options.custody.placementUrlBase, harnessHome: options.custody.harnessHome, workspaceRoot: options.custody.workspaceRoot }, offer, log)
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
  // Custody answers run beside the bridge, never through it: a capture is asked for exactly when a
  // shutdown is closing the bridge's own connections.
  if (options.custody !== undefined && options.podUid !== undefined) {
    startCustodyAgent({
      evidenceUrl: options.evidenceUrl,
      custodyUrlBase: options.custody.placementUrlBase,
      harnessHome: options.custody.harnessHome,
      workspaceRoot: options.custody.workspaceRoot,
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

function optionsFromEnv(env: NodeJS.ProcessEnv): LaunchOptions {
  const incarnation = env.AGORA_INCARNATION
  const bridgeAuthSecret = env.BRIDGE_AUTH_SECRET
  const evidenceUrl = env.AGORA_EVIDENCE_URL
  if (incarnation === undefined) throw new Error('AGORA_INCARNATION is required')
  if (bridgeAuthSecret === undefined) throw new Error('BRIDGE_AUTH_SECRET is required')
  if (evidenceUrl === undefined) throw new Error('AGORA_EVIDENCE_URL is required')
  const harnessHome = env.AGORA_HARNESS_HOME
  const workspaceRoot = env.AGORA_WORKSPACE_ROOT
  const custodyUrl = env.AGORA_CUSTODY_URL
  return {
    evidenceUrl,
    incarnation,
    bridgeAuthSecret,
    // All three come from the reviewed catalogue through the PodSpec. Missing any of them means
    // this Pod simply never restores: it launches with no placement, which is the S8 behaviour.
    ...(harnessHome !== undefined && workspaceRoot !== undefined && custodyUrl !== undefined
      ? { custody: { harnessHome, workspaceRoot, placementUrlBase: custodyUrl } }
      : {}),
    ...(env.AGORA_POD_UID !== undefined ? { podUid: env.AGORA_POD_UID } : {}),
    bridgePort: Number(env.BRIDGE_PORT ?? 8765),
    adapterCommand: ['node', '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
    onLog: (message: string) => console.log(message),
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  launch(optionsFromEnv(process.env)).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}

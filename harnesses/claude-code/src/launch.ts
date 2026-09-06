// Waits on the runtime-control launch seam before the bridge ever spawns the adapter (execution.md
// — "the harness container waits on the seam until the control plane confirms the Agora Session
// exists"). Polls the same evidence endpoint apps/runtime-control/src/owner-api.ts already serves
// — no separate wait protocol. The bridge token minted at gate release goes to the control plane
// in the gate_release owner-response, never here: this process only needs to know the gate opened.
import { spawn } from 'node:child_process'
import { adapterProcessFrom, startBridgeServer, type BridgeServer } from './bridge-server.js'

export interface LaunchOptions {
  readonly evidenceUrl: string
  readonly pollIntervalMs?: number
  readonly incarnation: string
  readonly bridgeAuthSecret: string
  readonly bridgePort: number
  readonly adapterCommand: readonly string[]
  readonly onLog?: (message: string) => void
}

interface SeamEvidence {
  readonly seam: { readonly released: boolean } | null
}

export async function waitForGateRelease(options: Pick<LaunchOptions, 'evidenceUrl' | 'pollIntervalMs' | 'onLog'>): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const log = options.onLog ?? (() => {})
  for (;;) {
    try {
      const res = await fetch(options.evidenceUrl)
      if (res.ok) {
        const evidence = (await res.json()) as SeamEvidence
        if (evidence.seam?.released === true) return
      }
    } catch (error) {
      log(`evidence poll failed, retrying: ${error instanceof Error ? error.message : String(error)}`)
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
  return {
    evidenceUrl,
    incarnation,
    bridgeAuthSecret,
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

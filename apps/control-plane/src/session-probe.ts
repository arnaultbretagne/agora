// Live session probe (S8 Step 2 — execution.md "ACP facts and current evidence"): "current
// configuration comes from a fresh owner snapshot or a freshly verified, complete ordered stream
// continuing from such a snapshot for the same process/context" — P3 found no config_option_update
// stream follows set_config_option for this adapter, so a fresh snapshot is the only freshness
// proof available, taken the same connect-act-disconnect way START itself binds a context
// (bridge-server.ts's adapter process outlives any one WebSocket). Every ACP frame is captured
// before anything else touches it (execution.md) — even a probe's, through the same persist seam
// START and, later, prompt dispatch use.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, connectBridge, createPersist, initializeParams, type BridgeConnection } from '@agora/acp'
import { workspaceRoot } from './workspace-root.js'

export interface SessionProbeOptions {
  readonly productPool: pg.Pool
  readonly bridgePort: number
  readonly logger?: (message: string) => void
  /** Test seam: production uses connectBridge against the real WebSocket. */
  readonly connect?: (options: { readonly url: string; readonly token: string }) => Promise<BridgeConnection>
}

export interface SessionProbeResult {
  readonly connected: boolean
  /** configId -> currentValue, straight off the resume response (S8 Step 3 reads this for model/effort; unused by session() itself). */
  readonly configOptions: ReadonlyMap<string, string>
}

const DISCONNECTED: SessionProbeResult = { connected: false, configOptions: new Map() }

/**
 * Resumes the workstream's bound ACP context to prove it is actually still live, right now — never
 * a cached record. Any failure (unreachable Pod, dead process, adapter rejects the resume) reports
 * `connected: false`; it is never thrown, this is an evidence read like any other in 002 Observation.
 */
export async function probeSession(
  input: {
    readonly workstreamId: string
    /** The Agora Session's own id (sessions.id) — what captured frames are attributed to, never the ACP context id. */
    readonly sessionId: string
    readonly podIP: string | null
    readonly bridgeToken: string
    readonly contextId: string
  },
  options: SessionProbeOptions,
): Promise<SessionProbeResult> {
  if (input.podIP === null) return DISCONNECTED
  const connect = options.connect ?? connectBridge
  try {
    const connection = await connect({ url: `ws://${input.podIP}:${options.bridgePort}/`, token: input.bridgeToken })
    try {
      const client = await options.productPool.connect()
      try {
        await client.query('SET ROLE agora_product')
        const persist = createPersist(client, {
          workstreamId: input.workstreamId,
          sessionId: input.sessionId,
          connectionId: randomUUID(),
          commandIdFor: () => null,
        })
        const clientConnection = buildClientConnection(connection.stream, persist)
        try {
          await clientConnection.agent.request(acp.methods.agent.initialize, initializeParams(workspaceRoot()))
          const resumed = (await clientConnection.agent.request(acp.methods.agent.session.resume, {
            sessionId: input.contextId,
            cwd: workspaceRoot(),
            mcpServers: [],
          })) as { configOptions?: readonly { id?: unknown; currentValue?: unknown }[] }
          const configOptions = new Map<string, string>()
          for (const option of resumed.configOptions ?? []) {
            if (typeof option.id === 'string' && typeof option.currentValue === 'string') configOptions.set(option.id, option.currentValue)
          }
          return { connected: true, configOptions }
        } finally {
          clientConnection.close()
        }
      } finally {
        await client.query('RESET ROLE').catch(() => {})
        client.release()
      }
    } finally {
      await connection.close()
    }
  } catch (error) {
    options.logger?.(`session probe for ${input.workstreamId} failed: ${error instanceof Error ? error.message : String(error)}`)
    return DISCONNECTED
  }
}

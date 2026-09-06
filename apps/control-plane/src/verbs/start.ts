// START (S8 Step 2 — execution.md "Session birth and admission"; docs/plans/S08 Step 2): after
// CAPABILITIES passed and the gate released (session-opener.ts already bound a bridge token),
// connect to the harness Pod's real bridge, `initialize` then bind exactly one ACP context to the
// Agora Session. Connect-act-disconnect per verb execution, not a held-open channel: bridge-
// server.ts's own adapter process outlives any one WebSocket (findings — "a dropped connection
// reconnects to the SAME process"), so there is no correctness reason to keep a connection alive
// between verb executions; SET_MODEL/SET_EFFORT/prompt dispatch (S8 Steps 3/5) reconnect the same
// way. Unknown acceptance (a lost session/new response) is resolved by discovery — `session/list`
// against the fixed workspace root — never a blind second session/new (findings P3:
// sessionCapabilities.list). A context bound at an older process generation is already dead (the
// process that held it is gone): that case always creates fresh, discovery would find nothing.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, connectBridge, createPersist, initializeParams, type BridgeConnection } from '@agora/acp'
import { bindAcpContext, currentSession } from '@agora/journal'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import { WORKSPACE_ROOT } from '../workspace-root.js'

export { WORKSPACE_ROOT }

export interface StartExecutorOptions {
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
  readonly incarnation: string | null
  readonly podIP: string | null
}

export class UnsupportedVerbError extends Error {
  constructor(readonly verb: Verb) {
    super(`the START executor does not handle ${verb}`)
    this.name = 'UnsupportedVerbError'
  }
}

export function createStartExecutor(options: StartExecutorOptions): VerbExecutor {
  const connect = options.connect ?? connectBridge
  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      if (verb !== 'START') throw new UnsupportedVerbError(verb)
      try {
        await runStart(options, connect, context)
      } catch (error) {
        // Same shape as session-opener's own retriable side effects: never surfaces as a thrown
        // verb failure the engine would have to specially handle — the next tick tries again with
        // fresh evidence (a lost connection, an unreachable Pod, a still-booting adapter).
        options.logger?.(`START for ${context.workstreamId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

async function runStart(
  options: StartExecutorOptions,
  connect: NonNullable<StartExecutorOptions['connect']>,
  context: VerbContext,
): Promise<void> {
  const session = await currentSession(options.productPool, context.workstreamId)
  if (session === null || session.bridgeToken === null) return // birth/gate not caught up yet — retried next tick

  const pod = await findEstablishedPod(options.runtimeControlBaseUrl, context.workstreamId)
  if (pod === undefined || pod.podIP === null || pod.incarnation === null) return

  const currentGeneration = await fetchProcessGeneration(options.runtimeControlBaseUrl, pod.name)
  if (currentGeneration === undefined) return // evidence unreachable — never guess a generation
  if (session.acpContextId !== null && session.processGeneration === currentGeneration) return // already live, nothing to do

  // A context bound at an OLDER generation belonged to a process that no longer exists — no
  // discovery makes sense there (a fresh process starts with an empty session list); only a truly
  // unattempted or response-lost START (acpContextId still null) warrants discovery first.
  const discoverFirst = session.acpContextId === null

  const bridgeUrl = `ws://${pod.podIP}:${options.bridgePort}/`
  const connection = await connect({ url: bridgeUrl, token: session.bridgeToken })
  try {
    const client = await options.productPool.connect()
    try {
      await client.query('SET ROLE agora_product')
      const persist = createPersist(client, {
        workstreamId: context.workstreamId,
        sessionId: session.sessionId,
        connectionId: randomUUID(),
        commandIdFor: () => null,
      })
      const clientConnection = buildClientConnection(connection.stream, persist)
      try {
        await clientConnection.agent.request(acp.methods.agent.initialize, initializeParams(WORKSPACE_ROOT))
        const contextId = discoverFirst ? await discoverOrCreateContext(clientConnection) : await createContext(clientConnection)
        await bindAcpContext(client, session.sessionId, { contextId, processGeneration: currentGeneration })
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
}

async function discoverOrCreateContext(connection: acp.ClientConnection): Promise<string> {
  const listed = (await connection.agent.request(acp.methods.agent.session.list, { cwd: WORKSPACE_ROOT })) as { sessions?: readonly { sessionId?: string }[] }
  const existing = listed.sessions?.[0]?.sessionId
  if (typeof existing === 'string') return existing // discovered a session/new that landed but whose response was lost — never a second session/new
  return createContext(connection)
}

async function createContext(connection: acp.ClientConnection): Promise<string> {
  const created = (await connection.agent.request(acp.methods.agent.session.new, { cwd: WORKSPACE_ROOT, mcpServers: [] })) as { sessionId: string }
  return created.sessionId
}

async function findEstablishedPod(runtimeControlBaseUrl: string, workstreamId: string): Promise<PodInventoryEntry | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
  if (!res.ok) return undefined
  const inventory = (await res.json()) as { pods: readonly PodInventoryEntry[] }
  return inventory.pods.find((pod) => !pod.forcedDeletion)
}

async function fetchProcessGeneration(runtimeControlBaseUrl: string, podName: string): Promise<number | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/pods/${podName}/evidence`)
  if (!res.ok) return undefined
  const evidence = (await res.json()) as { processGeneration?: number }
  return typeof evidence.processGeneration === 'number' ? evidence.processGeneration : undefined
}

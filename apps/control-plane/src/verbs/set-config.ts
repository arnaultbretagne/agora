// SET_MODEL / SET_EFFORT (S8 Step 3 — docs/specs/reconciliation/008_config.md): CONFIG-001 fires
// SET_MODEL whenever observation.model disagrees with the Intent; CONFIG-002 fires SET_EFFORT only
// once the model is already right (rule ordering, not a sequence hidden inside a verb — this module
// never orders the two itself). Connect-act-disconnect per verb execution, same as START and the
// observation probe (session-probe.ts): the adapter process outlives any one WebSocket. No DB
// bookkeeping here at all — the next observation.model/effort read (a fresh session/resume) is what
// proves whether this actually took; if it didn't, CONFIG-001/002 simply select the same verb again
// next tick ("an unavailable requested value is an incompatibility, never permission to accept a
// substituted default" — 008_config.md). Only acts against the CURRENT process generation's
// context — a stale binding needs START to rebind first; setting config on a dead process's context
// would be meaningless.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, connectBridge, createPersist, initializeParams, type BridgeConnection } from '@agora/acp'
import { currentSession } from '@agora/journal'
import { loadLatestIntentEvent, type QueryClient } from '@agora/engine'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import { WORKSPACE_ROOT } from '../workspace-root.js'

export interface SetConfigExecutorOptions {
  readonly productPool: pg.Pool
  readonly enginePool: QueryClient
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
}

export class UnsupportedVerbError extends Error {
  constructor(readonly verb: Verb) {
    super(`the SET_MODEL/SET_EFFORT executor does not handle ${verb}`)
    this.name = 'UnsupportedVerbError'
  }
}

const CONFIG_ID: Partial<Record<Verb, 'model' | 'effort'>> = { SET_MODEL: 'model', SET_EFFORT: 'effort' }

export function createSetConfigExecutor(options: SetConfigExecutorOptions): VerbExecutor {
  const connect = options.connect ?? connectBridge
  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      const configId = CONFIG_ID[verb]
      if (configId === undefined) throw new UnsupportedVerbError(verb)
      try {
        await runSetConfig(configId, options, connect, context)
      } catch (error) {
        // Same shape as START/session-opener's own retriable side effects — never a thrown verb
        // failure; the next tick's fresh observation.model/effort decides whether to try again.
        options.logger?.(`${verb} for ${context.workstreamId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

async function runSetConfig(
  configId: 'model' | 'effort',
  options: SetConfigExecutorOptions,
  connect: NonNullable<SetConfigExecutorOptions['connect']>,
  context: VerbContext,
): Promise<void> {
  const session = await currentSession(options.productPool, context.workstreamId)
  if (session === null || session.bridgeToken === null || session.acpContextId === null) return // START hasn't caught up yet — retried next tick

  const pod = await findEstablishedPod(options.runtimeControlBaseUrl, context.workstreamId)
  if (pod === undefined || pod.podIP === null) return

  const currentGeneration = await fetchProcessGeneration(options.runtimeControlBaseUrl, pod.name)
  if (currentGeneration === undefined || currentGeneration !== session.processGeneration) return // not (yet, or any longer) the live process — never act against a binding that isn't proven current

  const intentEvent = await loadLatestIntentEvent(options.enginePool, context.workstreamId)
  const desiredValue = (intentEvent?.intent as Record<string, unknown> | undefined)?.[configId]
  if (typeof desiredValue !== 'string') return // no valid Intent to act on yet

  const connection = await connect({ url: `ws://${pod.podIP}:${options.bridgePort}/`, token: session.bridgeToken })
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
        await clientConnection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: session.acpContextId, configId, value: desiredValue })
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

// REFILL (S9 Step 5 — 003 verbs, 009 SYNC). Commits or recovers the ONE opening Handoff for this
// Session's fixed `(W, H]` and delivers it as an ACP embedded resource.
//
// It runs under the same admission barrier as any effectful turn, minus its own prerequisite: a
// Handoff cannot wait for synchronization, because it IS the synchronization (execution.md). Every
// other check still applies — authority verified, config verified, one turn in flight at a time.
//
// An empty range dispatches nothing. Not an empty prompt: a prompt is a turn to admit, dispatch and
// prove, and there is nothing here to prove (CONT-002).
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import * as acp from '@agentclientprotocol/sdk'
import { buildClientConnection, connectBridge, createPersist, initializeParams, markDispatched, markResponded, markUnknown, type BridgeConnection } from '@agora/acp'
import { currentSession } from '@agora/journal'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import { completeOpeningDescriptor } from '../descriptor.js'
import { workspaceRoot } from '../workspace-root.js'

export interface RefillExecutorOptions {
  readonly productPool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly bridgePort: number
  /**
   * Whether a `fidelity=degraded` Handoff has been confirmed for this Workstream. The seed policy
   * requires an explicit answer before dispatch; absent a confirmer, a degraded Handoff is simply
   * not sent, and the range stays unsynchronized and visibly so.
   */
  readonly degradedConfirmed?: (workstreamId: string) => Promise<boolean>
  readonly logger?: (message: string) => void
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
    super(`the REFILL executor does not handle ${verb}`)
    this.name = 'UnsupportedVerbError'
  }
}

export function createRefillExecutor(options: RefillExecutorOptions): VerbExecutor {
  const connect = options.connect ?? connectBridge
  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      if (verb !== 'REFILL') throw new UnsupportedVerbError(verb)
      try {
        await runRefill(options, connect, context)
      } catch (error) {
        options.logger?.(`REFILL for ${context.workstreamId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

async function runRefill(
  options: RefillExecutorOptions,
  connect: NonNullable<RefillExecutorOptions['connect']>,
  context: VerbContext,
): Promise<void> {
  const session = await currentSession(options.productPool, context.workstreamId)
  if (session === null || session.bridgeToken === null || session.acpContextId === null) return

  const pod = await findEstablishedPod(options.runtimeControlBaseUrl, context.workstreamId)
  if (pod === undefined || pod.podIP === null) return

  // The reservation commits BEFORE the transport write (S4's discipline): a crash between the two
  // leaves a `reserved` command that recovery can see, never a send nobody recorded.
  const client = await options.productPool.connect()
  let commandId: string | null = null
  let text = ''
  let uri = ''
  try {
    await client.query('SET ROLE agora_product')
    await client.query('BEGIN')
    const completed = await completeOpeningDescriptor(client, {
      workstreamId: context.workstreamId,
      sessionId: session.sessionId,
      contextId: session.acpContextId,
    })
    if (completed === null || completed.handoff === null || completed.dispatch === null) {
      await client.query('ROLLBACK')
      return // an empty range: nothing to deliver, and nothing to record having not delivered
    }
    if (completed.handoff.degraded) {
      const confirmed = (await options.degradedConfirmed?.(context.workstreamId)) ?? false
      if (!confirmed) {
        // The policy's own rule: a degraded rendering needs an answer before it is sent. It holds up
        // this REFILL and nothing else — an independently requested shutdown proceeds on its budget.
        await client.query('ROLLBACK')
        options.logger?.(`REFILL for ${context.workstreamId} is degraded and unconfirmed; not dispatching`)
        return
      }
    }
    if (completed.dispatch.state === 'unknown') {
      // CONT-005: possibly accepted, response lost. It is preserved and it gates; it is never
      // resent, on a reconnect or on anything else. Recovery resolves it, not this verb.
      await client.query('ROLLBACK')
      options.logger?.(`REFILL for ${context.workstreamId} is gated by an unresolved Handoff ${completed.dispatch.id}`)
      return
    }
    if (completed.dispatch.state === 'responded') {
      await client.query('ROLLBACK')
      return // already delivered and answered; sync's own proof decides whether it counted
    }
    commandId = completed.dispatch.id
    text = completed.handoff.text
    uri = completed.handoff.uri
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.query('RESET ROLE').catch(() => {})
    client.release()
  }
  if (commandId === null) return

  const connection = await connect({ url: `ws://${pod.podIP}:${options.bridgePort}/`, token: session.bridgeToken })
  const persistClient = await options.productPool.connect()
  try {
    await persistClient.query('SET ROLE agora_product')
    const boundCommandId = commandId
    const persist = createPersist(persistClient, {
      workstreamId: context.workstreamId,
      sessionId: session.sessionId,
      connectionId: randomUUID(),
      commandIdFor: () => boundCommandId,
    })
    const clientConnection = buildClientConnection(connection.stream, persist)
    try {
      // `initialize` is deliberately NOT sent here. It is a PROCESS-level handshake the harness bridge
      // performs once when it spawns the adapter (packages/harness-bridge/src/handshake.ts): codex-acp
      // answers a second one with "Already initialized", and both pinned adapters accept `session/*` on a
      // connection that never initialized — so re-initializing per verb bought nothing and broke one of
      // the two harnesses.
      await mark(options.productPool, commandId, markDispatched)
      try {
        // An embedded resource, not a resource link: a link does not deliver bytes, and the whole
        // point is that the context receives the content (continuity.md).
        await clientConnection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.acpContextId,
          prompt: [{ type: 'resource', resource: { uri, mimeType: 'text/plain', text } }],
        })
        await mark(options.productPool, commandId, markResponded)
      } catch (error) {
        // The send happened; the response did not come back. That is `unknown`, not failure: the
        // turn may have been accepted, so it gates and is never resent (CONT-005).
        await mark(options.productPool, commandId, markUnknown)
        throw error
      }
    } finally {
      clientConnection.close()
    }
  } finally {
    await persistClient.query('RESET ROLE').catch(() => {})
    persistClient.release()
    await connection.close()
  }
}

async function mark(pool: pg.Pool, commandId: string, transition: (client: pg.PoolClient, id: string) => Promise<boolean>): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SET ROLE agora_product')
    await transition(client, commandId)
  } finally {
    await client.query('RESET ROLE').catch(() => {})
    client.release()
  }
}

async function findEstablishedPod(runtimeControlBaseUrl: string, workstreamId: string): Promise<PodInventoryEntry | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
  if (!res.ok) return undefined
  const inventory = (await res.json()) as { pods: readonly PodInventoryEntry[] }
  return inventory.pods.find((pod) => !pod.forcedDeletion)
}

// Opens the Agora Session for a Workstream's established Pod, then releases its launch seam
// (execution.md — "Session birth and admission": "every established Pod gets a new Agora Session
// before native launch or any ACP envelope"; runtime-control's LaunchSeam refuses release until a
// Session id is bound — birth-then-release ordering). Neither step is a verb the rule tables
// select — no BUILD row's own result is looked at here, deliberately: a fresh inventory read after
// BUILD proves the Pod actually exists, rather than trusting BUILD's own response (which can be a
// replayed `completed` from an attempt long past). packages/engine's OwnerVerbRunner runs as
// `agora_engine`, which has no grant on `sessions`/`workstream_facts` (contracts/db/schema.sql) —
// opening a Session and recording its bridge token are `agora_product`'s authority, so this wraps
// the engine's own executor rather than living inside it. Reading the current epoch for
// gate_release is the one piece only `agora_engine` can do (`mutation_epochs` has no grant to
// `agora_product` either) — hence the separate `enginePool`.
import type pg from 'pg'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import { openSession, currentSession, endAttribution, recordBridgeToken } from '@agora/journal'
import { payloadDigest, type OwnerRequest } from '@agora/owner-requests'
import { sendOwnerRequest } from './owner-transport.js'

export interface SessionOpenerOptions {
  readonly inner: VerbExecutor
  readonly productPool: pg.Pool
  readonly enginePool: pg.Pool
  readonly runtimeControlBaseUrl: string
  readonly logger?: (message: string) => void
}

interface PodInventoryEntry {
  readonly uid: string
  readonly forcedDeletion: boolean
  readonly incarnation: string | null
}

export function createSessionOpeningExecutor(options: SessionOpenerOptions): VerbExecutor {
  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      await options.inner.execute(verb, context)
      if (verb !== 'BUILD') return
      try {
        const pod = await findEstablishedPod(options.runtimeControlBaseUrl, context.workstreamId)
        if (pod === undefined) return
        const sessionId = await openTheSession(options.productPool, context.workstreamId, pod)
        await releaseTheGate(options, context.workstreamId, sessionId, pod)
      } catch (error) {
        // Never lets a Session-opening failure look like BUILD itself failed — BUILD already
        // settled its own attempt; this is a distinct, retriable side effect (the next tick's
        // BUILD replay, or its own bounded recheck, tries opening the Session again).
        options.logger?.(`session opening after BUILD failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/**
 * Opens the Session for THIS Pod, ending the previous one's attribution first if it belonged to a
 * Pod that no longer exists.
 *
 * A Session is opened for one Pod and named by its uid; when that Pod is gone the Session cannot be
 * used for anything, and nothing was ending it. `sessions_one_current_per_workstream` then refused
 * every subsequent open with a unique-violation, so a Workstream that lost a Pod could never get
 * another Session — permanently, and reported only as "session opening after BUILD failed" in a log
 * line nobody reads. The first live deployment produced exactly that state within ten minutes.
 *
 * Ending it here is not bookkeeping: `session.ended` is a fact, so the record says the Session ended
 * because its Pod was replaced, and the next Session's opening window starts after it.
 */
async function openTheSession(productPool: pg.Pool, workstreamId: string, pod: PodInventoryEntry): Promise<string> {
  const client = await productPool.connect()
  try {
    await client.query('BEGIN')
    const current = await currentSession(client, workstreamId)
    if (current !== null && current.podUid !== pod.uid) {
      await endAttribution(client, workstreamId, current.sessionId, 'pod_replaced')
    }
    const opened = await openSession(client, workstreamId, { podUid: pod.uid, provenance: { incarnation: pod.incarnation } })
    await client.query('COMMIT')
    return opened.sessionId
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Releases runtime-control's LaunchSeam (the harness Pod's own entrypoint waits on it) now that a
 * Session exists to bind it to, and persists the P4 bridge token minted only once release actually
 * succeeds. A no-op once the Session already carries a token — release itself is idempotent at the
 * owner (same sessionId replays `true`), but there is no reason to mint (and store) a fresh token
 * on every BUILD tick once one already works.
 */
async function releaseTheGate(options: SessionOpenerOptions, workstreamId: string, sessionId: string, pod: PodInventoryEntry): Promise<void> {
  if (pod.incarnation === null) return
  const current = await currentSession(options.productPool, workstreamId)
  if (current?.bridgeToken !== null && current?.bridgeToken !== undefined) return

  const epochRow = await options.enginePool.query('SELECT epoch FROM mutation_epochs WHERE workstream_id = $1', [workstreamId])
  const epoch: number = (epochRow.rows[0] as { epoch?: number } | undefined)?.epoch ?? 1
  const payload = { sessionId }
  const request: OwnerRequest = {
    epoch,
    workstreamId,
    attemptKey: `gate_release:${sessionId}`,
    operation: 'gate_release',
    target: { kind: 'concrete', id: pod.incarnation },
    payload,
    payloadDigest: payloadDigest(payload),
    revisionSet: {},
  }
  const response = await sendOwnerRequest(options.runtimeControlBaseUrl, request)
  if (response.kind !== 'completed') {
    options.logger?.(`gate_release for session ${sessionId} -> ${response.kind}`)
    return
  }
  const bridgeToken = (response.result as { bridgeToken?: unknown }).bridgeToken
  if (typeof bridgeToken !== 'string') {
    options.logger?.(`gate_release for session ${sessionId} completed without a bridgeToken`)
    return
  }
  const client = await options.productPool.connect()
  try {
    await client.query('BEGIN')
    await recordBridgeToken(client, sessionId, bridgeToken)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function findEstablishedPod(runtimeControlBaseUrl: string, workstreamId: string): Promise<PodInventoryEntry | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
  if (!res.ok) return undefined
  const inventory = (await res.json()) as { pods: readonly PodInventoryEntry[] }
  return inventory.pods.find((pod) => !pod.forcedDeletion)
}

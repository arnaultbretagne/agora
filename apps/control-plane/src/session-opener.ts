// Opens the Agora Session for a Workstream's established Pod (execution.md — "Session birth and
// admission": "every established Pod gets a new Agora Session before native launch or any ACP
// envelope"). Not a verb the rule tables select — no BUILD row row's own result is looked at here,
// deliberately: a fresh inventory read after BUILD proves the Pod actually exists, rather than
// trusting BUILD's own response (which can be a replayed `completed` from an attempt long past).
// packages/engine's OwnerVerbRunner runs as `agora_engine`, which has no grant on `sessions` or
// `workstream_facts` at all (contracts/db/schema.sql) — opening a Session is `agora_product`'s
// authority, so this wraps the engine's own executor rather than living inside it.
import type pg from 'pg'
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'
import { openSession } from '@agora/journal'

export interface SessionOpenerOptions {
  readonly inner: VerbExecutor
  readonly productPool: pg.Pool
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
        const client = await options.productPool.connect()
        try {
          await client.query('BEGIN')
          await openSession(client, context.workstreamId, { podUid: pod.uid, provenance: { incarnation: pod.incarnation } })
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        } finally {
          client.release()
        }
      } catch (error) {
        // Never lets a Session-opening failure look like BUILD itself failed — BUILD already
        // settled its own attempt; this is a distinct, retriable side effect (the next tick's
        // BUILD replay, or its own bounded recheck, tries opening the Session again).
        options.logger?.(`session opening after BUILD failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

async function findEstablishedPod(runtimeControlBaseUrl: string, workstreamId: string): Promise<PodInventoryEntry | undefined> {
  const res = await fetch(`${runtimeControlBaseUrl}/v1/workstreams/${workstreamId}`)
  if (!res.ok) return undefined
  const inventory = (await res.json()) as { pods: readonly PodInventoryEntry[] }
  return inventory.pods.find((pod) => !pod.forcedDeletion)
}

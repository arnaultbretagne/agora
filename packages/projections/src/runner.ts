// Runner: incremental folds from the checkpoint; rebuild truncates the projector's rows and
// replays from seq 1. A checkpoint written by another projector version is treated as no state at
// all — the version bump forces the rebuild (ADR 0004). Each run applies facts, writes projection
// rows and advances the checkpoint in one transaction.
import type pg from 'pg'
import { factsFrom } from '@agora/journal'
import { deleteCheckpoint, getCheckpoint, advanceCheckpoint } from './checkpoints.js'
import { orderIndependentHash } from './hash.js'
import type { Projector } from './projector.js'

export interface RunResult {
  readonly mode: 'incremental' | 'rebuilt'
  readonly applied: number
  readonly throughSeq: number
}

export async function runIncremental(client: pg.PoolClient, workstreamId: string, projector: Projector<unknown>): Promise<RunResult> {
  return run(client, workstreamId, projector, 'incremental')
}

export async function rebuild(client: pg.PoolClient, workstreamId: string, projector: Projector<unknown>): Promise<RunResult> {
  return run(client, workstreamId, projector, 'rebuilt')
}

async function run(client: pg.PoolClient, workstreamId: string, projector: Projector<unknown>, requested: 'incremental' | 'rebuilt'): Promise<RunResult> {
  await client.query('BEGIN')
  try {
    const checkpoint = await getCheckpoint(client, projector.name, workstreamId)
    const staleVersion = checkpoint !== null && checkpoint.projectorVersion !== projector.version
    const mode: 'incremental' | 'rebuilt' = requested === 'rebuilt' || staleVersion ? 'rebuilt' : 'incremental'
    if (mode === 'rebuilt') {
      await projector.clear(client, workstreamId)
      await deleteCheckpoint(client, projector.name, workstreamId)
    }
    const throughSeq = mode === 'rebuilt' ? 0 : (checkpoint?.throughSeq ?? 0)
    const facts = await factsFrom(client, workstreamId, throughSeq)
    let state = mode === 'rebuilt' ? projector.emptyState() : await projector.load(client, workstreamId)
    for (const fact of facts) {
      state = projector.fold(state, fact)
    }
    await projector.persist(client, workstreamId, state)
    const newThroughSeq = facts.length > 0 ? facts[facts.length - 1]!.seq : throughSeq
    await advanceCheckpoint(client, projector.name, workstreamId, { projectorVersion: projector.version, throughSeq: newThroughSeq })
    await client.query('COMMIT')
    return { mode, applied: facts.length, throughSeq: newThroughSeq }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function stateHash(client: pg.PoolClient, workstreamId: string, projector: Projector<unknown>): Promise<string> {
  return orderIndependentHash(await projector.hashInputs(client, workstreamId))
}

// Watches and recovery sweeps (engine.md — Watches and recovery sweeps): every fact that can
// invalidate convergence has a wake hook and a bounded sweep. A sweep must be able to re-enqueue a
// Workstream ABSENT from the workset — scanning active rows alone fails ENGINE-012.
import type pg from 'pg'
import type { QueryClient } from './db.js'

export type WakeSourceName =
  | 'intent'
  | 'runtime_inventory'
  | 'onecli_broker'
  | 'harness_acp'
  | 'save_anchor'
  | 'registry_revision'
  | 'attempts'

export interface SweepResult {
  readonly source: WakeSourceName
  readonly woken: number
  readonly cursor: string | null
}

export async function recordWake(client: QueryClient, source: WakeSourceName, cursor: string | null): Promise<void> {
  await client.query(
    `INSERT INTO wake_sources (source, cursor, last_seen) VALUES ($1, $2, now())
     ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, last_seen = now()`,
    [source, cursor],
  )
}

/**
 * Runs one bounded sweep: the hook returns the Workstream ids that may have drifted (the source's
 * own inventory), and the engine re-enqueues each through the drift path — fresh generation, same
 * intent_seq, whether or not the Workstream is in the workset.
 */
export async function sweep(
  pool: pg.Pool,
  source: WakeSourceName,
  hook: () => Promise<readonly { workstreamId: string; cursor: string | null }[]>,
  reEnqueue: (client: pg.PoolClient, workstreamId: string) => Promise<unknown>,
  limit = 100,
): Promise<SweepResult> {
  const candidates = (await hook()).slice(0, limit)
  let woken = 0
  let lastCursor: string | null = null
  for (const candidate of candidates) {
    const client = await pool.connect()
    try {
      await reEnqueue(client, candidate.workstreamId)
      woken += 1
      lastCursor = candidate.cursor ?? lastCursor
    } finally {
      client.release()
    }
  }
  const mark = await pool.connect()
  try {
    await recordWake(mark, source, lastCursor)
  } finally {
    mark.release()
  }
  return { source, woken, cursor: lastCursor }
}

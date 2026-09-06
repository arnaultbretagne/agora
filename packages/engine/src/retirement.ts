// Target retirement (engine.md — retirement survives work-row deletion): a retired target never
// accepts positive mutations or rebinding again; concrete-target cleanup stays authorized. Late
// effects on a retired target are discoverable by their pre-recorded correlation and routed to
// cleanup, never activation (ENGINE-007/009).
import type { QueryClient } from './db.js'

export async function retireTarget(client: QueryClient, workstreamId: string, targetKind: 'concrete' | 'reserved', targetId: string, reason: string): Promise<void> {
  await client.query(
    `INSERT INTO target_retirements (target_id, target_kind, workstream_id, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_id) DO NOTHING`,
    [targetId, targetKind, workstreamId, reason],
  )
  // Attempts still open on that target can never be completed positively: supersede them so
  // finalization is no longer blocked by an effect that must not happen anyway.
  await client.query(
    `UPDATE owner_attempts SET state = 'superseded', settled_at = now()
     WHERE target_id = $1 AND state IN ('reserved', 'dispatched', 'unknown')`,
    [targetId],
  )
}

export async function isRetired(client: QueryClient, targetId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM target_retirements WHERE target_id = $1', [targetId])
  return result.rowCount !== 0
}

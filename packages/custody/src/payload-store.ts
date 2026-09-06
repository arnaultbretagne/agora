// Save payload store (S9 Step 1). The bytes, behind the payload role and nothing else: this module
// is what runtime-control's transport uses, and it deliberately cannot read Save metadata or touch
// an Anchor. Writing is idempotent on the Save id so a retried transport does not need to know
// whether its predecessor got there first.
import type pg from 'pg'

export type PayloadQueryer = pg.Pool | pg.PoolClient

export async function writePayload(client: pg.PoolClient, saveId: string, bytes: Uint8Array): Promise<void> {
  await client.query(
    `INSERT INTO save_payloads (save_id, bytes) VALUES ($1, $2)
     ON CONFLICT (save_id) DO NOTHING`,
    [saveId, Buffer.from(bytes)],
  )
}

export async function readPayload(client: PayloadQueryer, saveId: string): Promise<Uint8Array | null> {
  const result = await client.query('SELECT bytes FROM save_payloads WHERE save_id = $1', [saveId])
  if (result.rowCount === 0) return null
  return new Uint8Array(result.rows[0]!['bytes'] as Buffer)
}

/** Only ever called for a Save whose retention has expired (S9 Step 5); never as a failure path. */
export async function deletePayload(client: pg.PoolClient, saveId: string): Promise<boolean> {
  const result = await client.query('DELETE FROM save_payloads WHERE save_id = $1', [saveId])
  return (result.rowCount ?? 0) > 0
}

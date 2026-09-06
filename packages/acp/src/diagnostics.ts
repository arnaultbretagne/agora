// Invalid frames are never canonical facts (ADR 0004): only direction, error class, size and
// digest survive — never their content.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { Direction } from './framing.js'

export interface DiagnosticRecord {
  readonly direction: Direction
  readonly errorClass: string
  readonly size: number
  readonly digest: string
}

export async function recordDiagnostic(
  client: pg.PoolClient,
  workstreamId: string,
  diagnostic: DiagnosticRecord & { readonly sessionId?: string | null },
  options: { readonly nowSql?: string } = {},
): Promise<void> {
  const now = options.nowSql ?? 'now()'
  await client.query(
    `INSERT INTO acp_diagnostics (id, workstream_id, session_id, direction, error_class, size, digest, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${now})`,
    [randomUUID(), workstreamId, diagnostic.sessionId ?? null, diagnostic.direction, diagnostic.errorClass, diagnostic.size, diagnostic.digest],
  )
}

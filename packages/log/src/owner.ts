// The log on its database owner's one login (docs/specs/preview.md, "The database"): a preview's database
// gives a single login, which owns the database and may create no role. It applies the schema of
// sql/001.sql without what concerns the runtime roles — their creation, then what they may do — and the
// server runs on that login (`LogStore.owner`).
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

const ROLE = /^DO \$\$ BEGIN CREATE ROLE agora_(writer|projector|anchors) NOLOGIN; .* END \$\$;$/
/** Where the runtime roles' grants start: everything from there on is about them. */
const GRANTS = /^REVOKE ALL ON workstreams,/
/** What the grants' part may hold: grants, revocations, the block that grants the database. */
const GRANT_LINE = /^(REVOKE |GRANT |DO \$\$ BEGIN$|END \$\$;$|--|\s|$)/

/** The owner's part of the schema; a schema whose roles' part holds anything else is refused. */
export function ownerSchema(sql: string): string {
  const lines = sql.split('\n')
  const start = lines.findIndex((line) => GRANTS.test(line))
  if (start < 0) throw new Error('owner_schema_unknown')
  const tail = lines.slice(start)
  if (tail.some((line) => !GRANT_LINE.test(line))) throw new Error('owner_schema_unknown')
  const own = lines.slice(0, start).filter((line) => !ROLE.test(line))
  if (own.some((line) => /\bagora_(writer|projector|anchors)\b/.test(line))) throw new Error('owner_schema_unknown')
  return own.join('\n')
}

/** Applies the owner's part of the schema on that login. Idempotent, as sql/001.sql is. */
export async function applyOwnerSchema(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 })
  pool.on('error', () => {})
  try {
    await pool.query(ownerSchema(await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8')))
  } finally {
    await pool.end()
  }
}

import pg from 'pg'

/**
 * node-postgres returns `bigint` (OID 20) columns as JS strings by default, to avoid silent
 * precision loss beyond Number.MAX_SAFE_INTEGER (~9e15). Every `bigint` column in this schema is
 * a sequence/position counter (`last_event_seq`, `workstream_seq`, `session_seq`,
 * `synced_through_seq`, `through_workstream_seq`, `feed_events.position`, `size_bytes`) that will
 * never realistically approach that bound, and this repository layer does arithmetic directly on
 * them (`+ 1`) — parsing as string here would silently string-concatenate instead of adding. Set
 * once, globally, at module load, rather than remembering `Number(...)` at every call site.
 */
pg.types.setTypeParser(20, (value: string) => Number(value))

/** Fail-fast: no default connection string. Prod without DATABASE_URL must not silently connect nowhere. */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return url
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString })
}

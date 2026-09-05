import pg from 'pg'

// bigint (OID 20) is parsed as Number once, globally: every bigint column here is a bounded
// counter and the engine does arithmetic on it; string parsing silently concatenates (findings §5).
pg.types.setTypeParser(20, (value: string) => Number(value))

export type QueryClient = Pick<pg.PoolClient, 'query'>

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return url
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max })
}

export async function withTransaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally {
    client.release()
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

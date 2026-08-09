import pg from 'pg'
import { migrate } from '../src/migrate.js'

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for store-pg integration tests (real Postgres, per P00)')
  return url
}

/**
 * Disposable, freshly migrated database per call — matches CI's real postgres:17 service. Node's
 * test runner executes separate test *files* concurrently, so each call needs its own uniquely
 * named database; a shared fixed name races across files (CREATE DATABASE / DROP DATABASE
 * colliding with a sibling file's run).
 */
export async function withTestDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const dbName = `agora_test_store_pg_${crypto.randomUUID().replaceAll('-', '')}`
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl() })
  try {
    await maintenance.query(`CREATE DATABASE ${dbName}`)
  } finally {
    await maintenance.end()
  }

  const testUrl = new URL(maintenanceUrl())
  testUrl.pathname = `/${dbName}`
  // Real-concurrency tests hold many connections at once; pg's default max (10) would deadlock
  // a test that acquires more clients than that before releasing any.
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 25 })
  try {
    await migrate(pool)
    return await run(pool)
  } finally {
    await pool.end()
    const cleanup = new pg.Pool({ connectionString: maintenanceUrl() })
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }
}

/** Run `body` as `role` (superuser SET ROLE, no separate login needed) then always RESET ROLE. */
export async function asRole<T>(client: pg.PoolClient, role: string, body: () => Promise<T>): Promise<T> {
  await client.query(`SET ROLE ${role}`)
  try {
    return await body()
  } finally {
    await client.query('RESET ROLE')
  }
}

export function randomId(): string {
  return crypto.randomUUID()
}

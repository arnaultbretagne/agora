// Carried over from archive/pre-design-cleanup-2026-09-05:packages/store-pg/test/support.ts
// (commit f49ecb3 tree); changes: applies contracts/db/schema.sql instead of the retired
// migration tree, installs the test clock, exposes the database handle to the test body.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { advanceClock, installTestClock } from './clock.js'

// node-postgres returns bigint (OID 20) as strings to avoid precision loss past 9e15. Every
// bigint column in this schema is a bounded counter (intent_seq, work_generation) and the engine
// does arithmetic on it; parsing as string would silently concatenate instead of adding
// (findings §5). Decided once, globally, at module load.
pg.types.setTypeParser(20, (value: string) => Number(value))

const SCHEMA_PATH = fileURLToPath(new URL('../../../../contracts/db/schema.sql', import.meta.url))

export function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL (or DATABASE_URL) is required: engine tests run against real PostgreSQL')
  }
  return url
}

export interface TestDatabase {
  readonly pool: pg.Pool
  readonly database: string
  readonly connectionString: string
  readonly schema: string
  readonly nowSql: string
  asRole<T>(client: pg.PoolClient, role: string, body: () => Promise<T>): Promise<T>
  advanceClock(ms: number): Promise<void>
}

export async function withTestDatabase<T>(run: (db: TestDatabase) => Promise<T>): Promise<T> {
  const database = `agora_test_${randomUUID().replaceAll('-', '')}`
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl(), max: 2 })
  maintenance.on('error', () => {})
  try {
    await maintenance.query(`CREATE DATABASE "${database}"`)
  } finally {
    await maintenance.end()
  }

  const testUrl = new URL(maintenanceUrl())
  testUrl.pathname = `/${database}`
  const connectionString = testUrl.toString()
  // Concurrency tests hold many clients at once; the default max (10) would deadlock a test that
  // acquires more clients than the pool holds before releasing any (findings §5).
  const pool = new pg.Pool({ connectionString, max: 25 })
  // `DROP DATABASE … WITH (FORCE)` below terminates any connection still open to this database.
  // `pool.end()` resolves once its clients are released, but a socket can still be closing when the
  // drop lands — and pg then emits that termination as a POOL error with no request to attach it to,
  // which node:test reports as an uncaughtException against whatever test is running at the time.
  // That is the "50 concurrent appends fails with `terminating connection due to administrator
  // command`" flake, twice in CI: the failure never belonged to the test it was reported against.
  // A pool that is being torn down has no error worth propagating, so this swallows exactly that.
  pool.on('error', () => {})
  const schema = readFileSync(SCHEMA_PATH, 'utf8')
  try {
    await pool.query(schema)
    await installTestClock(pool)
    return await run({
      pool,
      database,
      connectionString,
      schema,
      nowSql: 'agora_test.now()',
      asRole,
      advanceClock: (ms) => advanceClock(pool, ms),
    })
  } finally {
    await pool.end()
    const cleanup = new pg.Pool({ connectionString: maintenanceUrl(), max: 2 })
    cleanup.on('error', () => {})
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }
}

/** Run `body` as `role` (superuser SET ROLE, no separate login) then always RESET ROLE. */
export async function asRole<T>(client: pg.PoolClient, role: string, body: () => Promise<T>): Promise<T> {
  await client.query(`SET ROLE ${role}`)
  try {
    return await body()
  } finally {
    await client.query('RESET ROLE')
  }
}

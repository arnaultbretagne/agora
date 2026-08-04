import pg from 'pg'
import { migrate } from '@agora/store-pg'

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for @agora/web integration tests (real Postgres, per P00)')
  return url
}

/** Disposable, freshly migrated database per call — same pattern as every other package's test support. */
export async function withTestDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const dbName = `agora_test_web_${crypto.randomUUID().replaceAll('-', '')}`
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl() })
  try {
    await maintenance.query(`CREATE DATABASE ${dbName}`)
  } finally {
    await maintenance.end()
  }

  const testUrl = new URL(maintenanceUrl())
  testUrl.pathname = `/${dbName}`
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

export function randomId(): string {
  return crypto.randomUUID()
}

export interface TestDatabaseHandle {
  readonly pool: pg.Pool
  close(): Promise<void>
}

/** Non-callback variant of `withTestDatabase` for a whole test FILE's `before`/`after` lifecycle (e.g. one shared HTTP server across many tests), rather than one call per test. */
export async function openTestDatabase(): Promise<TestDatabaseHandle> {
  const dbName = `agora_test_web_${crypto.randomUUID().replaceAll('-', '')}`
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl() })
  try {
    await maintenance.query(`CREATE DATABASE ${dbName}`)
  } finally {
    await maintenance.end()
  }

  const testUrl = new URL(maintenanceUrl())
  testUrl.pathname = `/${dbName}`
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 25 })
  await migrate(pool)

  return {
    pool,
    async close() {
      await pool.end()
      const cleanup = new pg.Pool({ connectionString: maintenanceUrl() })
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      } finally {
        await cleanup.end()
      }
    },
  }
}

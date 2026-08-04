import pg from 'pg'
import { migrate } from '@agora/store-pg'

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for @agora/session-runtime-controller integration tests (real Postgres, per P00)')
  return url
}

export interface TestDatabaseHandle {
  readonly pool: pg.Pool
  close(): Promise<void>
}

/** Disposable, freshly migrated database — same pattern as every other package's test support (e.g. apps/web/test/support.ts), duplicated rather than cross-imported (deployables never import each other, even in test code). */
export async function openTestDatabase(): Promise<TestDatabaseHandle> {
  const dbName = `agora_test_controller_${crypto.randomUUID().replaceAll('-', '')}`
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

export function randomId(): string {
  return crypto.randomUUID()
}

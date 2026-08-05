import pg from 'pg'
import { migrate } from '@agora/store-pg'
import { FAKE_CA_CERTIFICATE } from '../src/onecli-fake.js'
import type { ExpectedRuntimeBundle } from '../src/grant-service.js'

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for @agora/broker integration tests (real Postgres, per P00)')
  return url
}

/** Disposable, freshly migrated database per call — same pattern as every other package's test support. */
export async function withTestDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const dbName = `agora_test_broker_${crypto.randomUUID().replaceAll('-', '')}`
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

export function testEncryptionKey(): Buffer {
  return Buffer.from('0'.repeat(64), 'hex').fill(7)
}

/** Matches exactly what `FakeOneCliControlAdapter.getContainerConfig` always returns — every test
 * that issues a grant against the fake adapter needs this to avoid a spurious drift rejection. */
export function testExpectedRuntimeBundle(): ExpectedRuntimeBundle {
  return { caCertificate: FAKE_CA_CERTIFICATE, credentialStubs: [] }
}

import pg from 'pg'
import { migrate } from '@agora/store-pg'
import { FAKE_CA_CERTIFICATE, fakeCredentialStubs } from '../src/onecli-fake.js'
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

/**
 * Deliberately built from a DIFFERENT identifier ('operator-pinned-reference') than any real
 * test's own Agent identifier — proves grant-service.ts's own drift check treats two different
 * Agents' stubs as matching (same underlying account, different signature), the exact live P11
 * finding, rather than accidentally passing only because both sides happen to be the same object.
 */
export function testExpectedRuntimeBundle(): ExpectedRuntimeBundle {
  return { caCertificate: FAKE_CA_CERTIFICATE, credentialStubs: fakeCredentialStubs('operator-pinned-reference') }
}

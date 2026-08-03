import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import pg from 'pg'

// bigint columns come back as strings by default; see packages/store-pg/src/db.ts for the same fix.
pg.types.setTypeParser(20, (value: string) => Number(value))

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../contracts/database')

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for custody integration tests (real Postgres, per P00)')
  return url
}

async function migrate(pool: pg.Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

/** Disposable, freshly migrated database per call — see packages/store-pg/test/support.ts for why. */
export async function withTestDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const dbName = `agora_test_custody_${crypto.randomUUID().replaceAll('-', '')}`
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

/** Minimal raw-SQL Workstream+Session, independent of @agora/store-pg — custody only needs the FK target to exist. */
export async function seedSession(pool: pg.Pool): Promise<string> {
  const client = await pool.connect()
  try {
    const workstreamId = randomId()
    const sessionId = randomId()
    const now = new Date()
    await client.query(
      `INSERT INTO product.workstreams (id, category, title, last_event_seq, created_at, updated_at)
       VALUES ($1, 'discussion', 'Hello', 0, $2, $2)`,
      [workstreamId, now],
    )
    await client.query(
      `INSERT INTO product.workstream_memberships (workstream_id, principal_id, role, added_at)
       VALUES ($1, 'alice', 'owner', $2)`,
      [workstreamId, now],
    )
    await client.query(
      `INSERT INTO product.sessions
         (id, workstream_id, ordinal, agent_id, phase, is_current, workspace_spec, equipment_request, runtime_definition_version, last_event_seq, created_at)
       VALUES ($1, $2, 1, 'claude-code', 'requested', true, '{}', '{"catalogueVersion":"v1","resources":[]}', 'v3', 0, $3)`,
      [sessionId, workstreamId, now],
    )
    return sessionId
  } finally {
    client.release()
  }
}

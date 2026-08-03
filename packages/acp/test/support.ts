import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import pg from 'pg'
import type { DuplexByteStream } from '../src/journaling-stream.js'

// bigint columns come back as strings by default; see packages/store-pg/src/db.ts for the same fix.
pg.types.setTypeParser(20, (value: string) => Number(value))

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../contracts/database')

function maintenanceUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for @agora/acp integration tests (real Postgres, per P00)')
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
  const dbName = `agora_test_acp_${crypto.randomUUID().replaceAll('-', '')}`
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

/** Minimal raw-SQL Workstream+Session, independent of @agora/store-pg's own repository functions. */
export async function seedSession(
  pool: pg.Pool,
  options: { readonly category?: 'discussion' | 'invocation' } = {},
): Promise<{ workstreamId: string; sessionId: string }> {
  const client = await pool.connect()
  try {
    const workstreamId = randomId()
    const sessionId = randomId()
    const now = new Date()
    await client.query(
      `INSERT INTO product.workstreams (id, category, title, last_event_seq, created_at, updated_at)
       VALUES ($1, $2, 'Hello', 0, $3, $3)`,
      [workstreamId, options.category ?? 'discussion', now],
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
    return { workstreamId, sessionId }
  } finally {
    client.release()
  }
}

/** Placeholder capability facts for tests — real resolution is Broker/P08 territory (ADR 0010). */
export const TEST_CAPABILITY = { policyVersion: 'test-policy-v1', digest: new Uint8Array(32).fill(7) }

/**
 * An in-memory duplex pair: `clientStream` is the raw byte stream to hand to `bootstrapSession`
 * (it wraps it with journaling itself); `agentStream` is an already SDK-wrapped `acp.Stream` for
 * a fake Agent to `.connect()` directly — mirrors packages/acp/spike/wire-journal.mjs's `ndJsonPair`.
 */
export function createInMemoryPair(): { clientStream: DuplexByteStream; agentStream: acp.Stream } {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  return {
    clientStream: { writable: clientToAgent.writable, readable: agentToClient.readable },
    agentStream: acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
  }
}

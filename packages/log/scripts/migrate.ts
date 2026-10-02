// Applies the schema as the database owner (LOG_MIGRATION_URL). With LOG_PROVISION_LOGINS=true it also
// creates the three runtime logins named in LOG_WRITER_URL, LOG_PROJECTOR_URL and LOG_ANCHORS_URL;
// where the platform manages them (CloudNativePG managed roles), it only checks their boundaries.
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { scramVerifier } from './scram.ts'

const url = process.env.LOG_MIGRATION_URL
if (!url) throw new Error('LOG_MIGRATION_URL is required')
const pool = new Pool({ connectionString: url })
pool.on('error', () => {})
try {
  await pool.query(await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8'))
  if (process.env.LOG_PROVISION_LOGINS === 'true') {
    for (const role of ['writer', 'projector', 'anchors']) {
      const raw = process.env[`LOG_${role.toUpperCase()}_URL`]
      if (!raw) throw new Error(`LOG_${role.toUpperCase()}_URL is required`)
      const runtime = new URL(raw),
        login = decodeURIComponent(runtime.username),
        password = decodeURIComponent(runtime.password)
      if (!login || !password || login === new URL(url).username || ['agora_writer', 'agora_projector', 'agora_anchors'].includes(login))
        throw new Error('distinct_runtime_login_required')
      const verifier = scramVerifier(password)
      const create = await pool.query('SELECT format($1::text,$2::text,$3::text) AS sql', ['CREATE ROLE %I LOGIN PASSWORD %L', login, verifier])
      try {
        await pool.query(create.rows[0].sql)
      } catch (error) {
        // Another migration created it first: set its password the same way.
        if (!['42710', '23505'].includes((error as { code?: string }).code ?? '')) throw error
        const alter = await pool.query('SELECT format($1::text,$2::text,$3::text) AS sql', ['ALTER ROLE %I LOGIN PASSWORD %L', login, verifier])
        await pool.query(alter.rows[0].sql)
      }
      const grant = await pool.query('SELECT format($1::text,$2::text,$3::text) AS sql', ['GRANT %I TO %I', `agora_${role}`, login])
      await pool.query(grant.rows[0].sql)
    }
  }
  if (process.env.LOG_WRITER_URL && process.env.LOG_PROJECTOR_URL && process.env.LOG_ANCHORS_URL) {
    const { LogStore } = await import('../src/store.ts')
    const store = new LogStore({ writer: process.env.LOG_WRITER_URL, projector: process.env.LOG_PROJECTOR_URL, anchors: process.env.LOG_ANCHORS_URL })
    try {
      await store.assertBoundaries()
    } finally {
      await store.close()
    }
  }
  console.log('log schema ready')
} finally {
  await pool.end()
}

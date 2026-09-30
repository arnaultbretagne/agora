import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
// The migration login owns the schema. Never pass it to the application.
const url = process.env.LOG_MIGRATION_URL
if (!url) throw new Error('LOG_MIGRATION_URL is required')
const pool = new Pool({ connectionString: url })
try {
  await pool.query(await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8'))
  for (const role of ['writer', 'projector', 'anchors']) {
    const raw = process.env[`LOG_${role.toUpperCase()}_URL`]
    if (!raw) throw new Error(`LOG_${role.toUpperCase()}_URL is required`)
    const runtime = new URL(raw),
      login = decodeURIComponent(runtime.username),
      password = decodeURIComponent(runtime.password)
    if (
      !login ||
      !password ||
      login === new URL(url).username ||
      (login.startsWith('agora_') && ['agora_writer', 'agora_projector', 'agora_anchors'].includes(login))
    )
      throw new Error('distinct_runtime_login_required')
    if (runtime.host !== new URL(url).host || runtime.pathname !== new URL(url).pathname)
      throw new Error('runtime_database_mismatch')
    const existing = await pool.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [login])
    if (!existing.rowCount) {
      const ddl = await pool.query('SELECT format($1,$2,$3) AS sql', [
        'CREATE ROLE %I LOGIN PASSWORD %L',
        login,
        password,
      ])
      await pool.query(ddl.rows[0].sql)
    }
    const grant = await pool.query('SELECT format($1,$2,$3) AS sql', ['GRANT %I TO %I', `agora_${role}`, login])
    await pool.query(grant.rows[0].sql)
  }
  const { LogStore } = await import('../src/store.ts')
  const store = new LogStore({
    writer: process.env.LOG_WRITER_URL!,
    projector: process.env.LOG_PROJECTOR_URL!,
    anchors: process.env.LOG_ANCHORS_URL!,
  })
  try {
    await store.assertBoundaries()
  } finally {
    await store.close()
  }
  console.log('Log schema and restricted runtime logins are ready')
} finally {
  await pool.end()
}

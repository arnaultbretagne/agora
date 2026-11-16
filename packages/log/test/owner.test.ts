// docs/specs/preview.md, V7: the log on its database owner's one login, a login that may create no role.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { applyOwnerSchema, LogStore, ownerSchema } from '../src/index.ts'
import { provisioning } from './support.ts'

test('V7 the owner schema on a login that owns its database and may create no role: applied twice, the log runs on it; a roles part holding more is refused', async (t) => {
  const admin = provisioning()
  const name = `agora_log_owner_${randomBytes(4).toString('hex')}`
  const password = randomBytes(12).toString('hex')
  await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${password}'`)
  await admin.query(`CREATE DATABASE ${name} OWNER ${name}`)
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.query(`DROP ROLE IF EXISTS ${name}`)
    await admin.end()
  })
  const url = new URL(String(process.env.LOG_TEST_ADMIN_URL))
  url.username = name
  url.password = password
  url.pathname = `/${name}`
  // Positive control: this login may create no role, which the whole schema does where its roles are new.
  const pool = new Pool({ connectionString: url.href, max: 1 })
  pool.on('error', () => {})
  t.after(() => pool.end())
  const sql = await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8')
  await assert.rejects(pool.query(`CREATE ROLE ${name}_probe NOLOGIN`), (error: { code?: string }) => error.code === '42501')
  // Its owner's part, twice: every table, none of the runtime roles.
  await applyOwnerSchema(url.href)
  await applyOwnerSchema(url.href)
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map((r) => r.tablename as string)
  assert.deepEqual(tables, ['anchors', 'checkpoints', 'commands', 'diagnostics', 'entries', 'files', 'listings', 'lists', 'objects', 'sessions', 'threads', 'workstreams'])
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='pg_trgm'")).rows[0].n, 1)
  assert.doesNotMatch(ownerSchema(sql), /agora_(writer|projector|anchors)/)
  // The log on that one login: its boundaries not asked, a Workstream written and read.
  const store = LogStore.owner(url.href)
  t.after(() => store.close())
  await store.assertBoundaries()
  const ws = randomUUID()
  await store.create(ws, randomUUID())
  assert.deepEqual(await store.workstreams(), [ws])
  // On the runtime logins, the boundaries are still asked: the owner's login is refused there.
  const runtime = new LogStore({ writer: url.href, projector: url.href, anchors: url.href })
  t.after(() => runtime.close())
  await assert.rejects(runtime.assertBoundaries(), /invalid_runtime_role/)
  // A roles part that holds anything but grants: refused, nothing applied.
  const more = sql.replace('GRANT DELETE ON anchors TO agora_anchors;', 'GRANT DELETE ON anchors TO agora_anchors;\nCREATE TABLE late (id int);')
  assert.throws(() => ownerSchema(more), /owner_schema_unknown/)
  assert.throws(() => ownerSchema(sql.replace(/^REVOKE ALL ON workstreams,.*\n/gm, '')), /owner_schema_unknown/)
})

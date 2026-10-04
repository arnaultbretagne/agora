// Provisioning alone is privileged: a template database with the schema, and the three runtime logins
// (docs/specs/log.md, "Storage"). Each test clones its own database from the template; the tests use
// the provisioning URL only to create, break and drop databases, never for what Agora does.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { Pool } from 'pg'
import { scramVerifier } from '../scripts/scram.ts'

const suffix = randomBytes(6).toString('hex')
const template = `agora_log_template_${suffix}`
let adminUrl = process.env.LOG_TEST_ADMIN_URL
let localAdmin: string | undefined
if (!adminUrl) {
  localAdmin = `agora_test_admin_${suffix}`
  const password = randomBytes(24).toString('hex')
  const provision = spawnSync('sudo', ['-n', '-u', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE ROLE ${localAdmin} LOGIN SUPERUSER PASSWORD '${scramVerifier(password)}'`], { encoding: 'utf8' })
  if (provision.status !== 0) throw new Error('PostgreSQL 17 is required; configure LOG_TEST_ADMIN_URL for test provisioning')
  adminUrl = `postgresql://${localAdmin}:${password}@127.0.0.1:5432/postgres`
}
const admin = new Pool({ connectionString: adminUrl })
const roles = ['writer', 'projector', 'anchors'] as const
const logins = roles.map((r) => `agora_test_${r}_${suffix}`)
let created = false
try {
  await admin.query(`CREATE DATABASE ${template}`)
  created = true
  const url = new URL(adminUrl)
  url.pathname = `/${template}`
  const target = new Pool({ connectionString: url.href })
  try {
    const version = await target.query('SHOW server_version_num')
    if (Number(version.rows[0].server_version_num) < 170000) throw new Error('PostgreSQL 17 or newer is required')
    await target.query(await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8'))
  } finally {
    await target.end()
  }
  const env: NodeJS.ProcessEnv = { ...process.env, LOG_TEST_ADMIN_URL: adminUrl, LOG_TEST_TEMPLATE: template }
  for (const [index, role] of roles.entries()) {
    const login = logins[index]!,
      password = randomBytes(24).toString('hex')
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${scramVerifier(password)}' IN ROLE agora_${role}`)
    env[`LOG_TEST_${role.toUpperCase()}_LOGIN`] = `${login}:${password}`
  }
  // Test files to run, all by default; options such as --test-name-pattern go to the runner.
  const options = process.argv.slice(2).filter((a) => a.startsWith('--'))
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const files = only.length ? only : (await readdir(new URL('.', import.meta.url))).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`)
  const status = await new Promise<number>((resolve) => {
    // Files run side by side, each test on a database of its own; LOG_TEST_CONCURRENCY=1 runs them one by one.
    const concurrency = process.env.LOG_TEST_CONCURRENCY ?? String(Math.min(4, availableParallelism()))
    const child = spawn(process.execPath, ['--test', `--test-concurrency=${concurrency}`, '--test-timeout=90000', ...options, ...files], { cwd: new URL('..', import.meta.url), env, stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = status
} finally {
  const left = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`agora_log_%_${suffix}%`])
  for (const row of left.rows) await admin.query(`DROP DATABASE IF EXISTS ${row.datname as string} WITH (FORCE)`)
  if (created) await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`)
  for (const login of logins) await admin.query(`DROP ROLE IF EXISTS ${login}`)
  await admin.end()
  if (localAdmin) spawnSync('sudo', ['-n', '-u', 'postgres', 'psql', '-X', '-c', `DROP ROLE ${localAdmin}`], { stdio: 'ignore' })
}

// Provisioning alone is privileged. The test process receives only the actual runtime logins.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
const suffix = randomBytes(6).toString('hex')
const database = `agora_log_test_${suffix}`
let adminUrl = process.env.LOG_TEST_ADMIN_URL
let localAdmin: string | undefined
if (!adminUrl) {
  localAdmin = `agora_test_admin_${suffix}`
  const password = randomBytes(24).toString('hex')
  const provision = spawnSync(
    'sudo',
    [
      '-n',
      '-u',
      'postgres',
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE ROLE ${localAdmin} LOGIN SUPERUSER PASSWORD '${password}'`,
    ],
    { encoding: 'utf8' },
  )
  if (provision.status !== 0)
    throw new Error('PostgreSQL 17 is required; configure LOG_TEST_ADMIN_URL for test provisioning')
  adminUrl = `postgresql://${localAdmin}:${password}@127.0.0.1:5432/postgres`
}
const admin = new Pool({ connectionString: adminUrl })
const roles = ['writer', 'projector', 'anchors'] as const
const logins = roles.map((r) => `agora_test_${r}_${suffix}`)
let target: Pool | undefined
try {
  await admin.query(`CREATE DATABASE ${database}`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  target = new Pool({ connectionString: url.href })
  const version = await target.query('SHOW server_version_num')
  if (Number(version.rows[0].server_version_num) < 170000) throw new Error('PostgreSQL 17 or newer is required')
  const sql = await readFile(new URL('../sql/001.sql', import.meta.url), 'utf8')
  // Simultaneous migrations in separate databases exercise cluster-global role creation races.
  await target.query(sql)
  const env: NodeJS.ProcessEnv = { ...process.env, LOG_TEST_DATABASE: database, LOG_TEST_MIGRATION_URL: url.href }
  for (const [index, role] of roles.entries()) {
    const login = logins[index]!,
      password = randomBytes(24).toString('hex')
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE agora_${role}`)
    const runtimeUrl = new URL(url.href)
    runtimeUrl.username = login
    runtimeUrl.password = password
    env[`LOG_TEST_${role.toUpperCase()}_URL`] = runtimeUrl.href
  }
  const status = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, process.argv[2] === 'live-claude'
      ? ['scripts/live-claude.ts']
      : ['--test', '--test-concurrency=1', 'test/log.test.ts'], {
      cwd: new URL('..', import.meta.url),
      env,
      stdio: 'inherit',
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = status
} finally {
  await target?.end()
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  for (const login of logins) await admin.query(`DROP ROLE IF EXISTS ${login}`)
  await admin.end()
  if (localAdmin)
    spawnSync('sudo', ['-n', '-u', 'postgres', 'psql', '-X', '-c', `DROP ROLE ${localAdmin}`], { stdio: 'ignore' })
}

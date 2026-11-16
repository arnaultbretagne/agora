// Tries the server's image as a preview (apps/server/README.md, "Preview"; docs/specs/preview.md, V4 to V6): in a
// Docker network that lets nothing out — `--internal` — beside an empty PostgreSQL 17 whose one login owns its
// database, as CloudNativePG's `initdb` makes it. The image gets that database's URL and `PREVIEW=true`, nothing
// else: no secret, no ServiceAccount token, a read-only root, `/tmp` on a tmpfs, every capability dropped. Then
// the client's preview cases run against it, through the container's address. No dependency: Node 24, git, Docker.
//
//   node scripts/try-preview.ts <image>   exits with the cases' status; prints the image's output
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const image = process.argv[2]
if (!image) {
  console.error('usage: node scripts/try-preview.ts <image>')
  process.exit(2)
}
const suffix = randomBytes(3).toString('hex')
const [network, database, server] = [`preview-${suffix}`, `preview-db-${suffix}`, `preview-server-${suffix}`]
const password = randomBytes(12).toString('hex')

function docker(args: string[], options: SpawnSyncOptions = {}): string {
  const run = spawnSync('docker', args, { encoding: 'utf8', ...options })
  if (run.status !== 0) throw new Error(`docker ${args.join(' ')}: ${String(run.stderr)}`)
  return String(run.stdout).trim()
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let status = 1
try {
  docker(['network', 'create', '--internal', network])
  const init = mkdtempSync(join(tmpdir(), 'preview-init-'))
  writeFileSync(join(init, 'owner.sql'), `CREATE ROLE agora LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${password}';\nCREATE DATABASE agora OWNER agora;\n`)
  // Read by the container's `postgres` user, not this one.
  chmodSync(init, 0o755)
  chmodSync(join(init, 'owner.sql'), 0o644)
  docker(['run', '-d', '--name', database, '--network', network, '-e', `POSTGRES_PASSWORD=${randomBytes(12).toString('hex')}`, '-v', `${init}:/docker-entrypoint-initdb.d:ro`, 'postgres:17'])
  // Ready on TCP only once its init scripts have run.
  for (let i = 0; spawnSync('docker', ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) {
    if (i > 60) throw new Error(`PostgreSQL did not start:\n${spawnSync('docker', ['logs', database], { encoding: 'utf8' }).stderr}`)
    await sleep(1000)
  }
  docker([
    'run', '-d', '--name', server, '--network', network,
    '--read-only', '--tmpfs', '/tmp:uid=10001,gid=10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', 'PREVIEW=true', '-e', `PREVIEW_DATABASE_URL=postgresql://agora:${password}@${database}:5432/agora`,
    image,
  ])
  const address = docker(['inspect', server, '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`])
  const url = `http://${address}:8080`
  for (let i = 0; ; i++) {
    const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
    if (ok) break
    if (i > 60 || docker(['inspect', server, '--format', '{{.State.Running}}']) !== 'true') throw new Error(`the preview did not start:\n${docker(['logs', server])}`)
    await sleep(1000)
  }
  const cases = spawnSync(process.execPath, ['--test', '--test-timeout=180000', 'apps/web/test/browser/preview.test.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PREVIEW_URL: url, PREVIEW_CONTAINER: server },
  })
  status = cases.status ?? 1
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  const logs = spawnSync('docker', ['logs', server], { encoding: 'utf8' })
  console.log(`--- the preview's output\n${logs.stdout}${logs.stderr}`)
  spawnSync('docker', ['rm', '-f', server, database])
  spawnSync('docker', ['network', 'rm', network])
}
process.exit(status)

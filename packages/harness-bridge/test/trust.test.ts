// The gateway's root, trusted by what is not Node (src/trust.ts): Chromium's NSS database under HOME, created with
// certutil when the image carries it; nothing at all when it does not, or when there is no root.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { gatewayCa, NSS_NICKNAME, onPath, trustEnv, trustInNss } from '../src/trust.ts'

const root = mkdtempSync(join(tmpdir(), 'trust-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (): string => {
  const dir = join(root, String(n++))
  mkdirSync(dir)
  return dir
}

/** A certutil that writes each call's arguments to calls.log and, on -N, creates the database's file. */
function fakeCertutil(): { bin: string; calls: () => string[][] } {
  const bin = fresh()
  const log = join(bin, 'calls.log')
  writeFileSync(
    join(bin, 'certutil'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case " $* " in
  *" -N "*) dir="$2"; touch "\${dir#sql:}/cert9.db" ;;
  *" -D "*) exit 255 ;;
esac
`,
  )
  chmodSync(join(bin, 'certutil'), 0o755)
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []) }
}

const PEM = '-----BEGIN CERTIFICATE-----\nnot parsed by the fake\n-----END CERTIFICATE-----\n'

describe('the gateway root in NSS', () => {
  it('creates ~/.pki/nssdb and imports the root when certutil is on PATH and the root exists, once', async () => {
    const home = fresh()
    const ca = join(fresh(), 'ca.pem')
    writeFileSync(ca, PEM)
    const certutil = fakeCertutil()
    const db = `sql:${join(home, '.pki', 'nssdb')}`

    const first = await trustInNss({ home, ca, path: ['/nowhere', certutil.bin].join(delimiter) })
    assert.match(first, /trusted in /)
    assert.deepEqual(certutil.calls(), [
      ['-d', db, '-N', '--empty-password'],
      ['-d', db, '-D', '-n', ...NSS_NICKNAME.split(' ')],
      ['-d', db, '-A', '-n', ...NSS_NICKNAME.split(' '), '-t', 'C,,', '-i', ca],
    ])
    assert.ok(existsSync(join(home, '.pki', 'nssdb', 'cert9.db')))

    // Again, as after a restart in the same HOME: the database is kept, the root replaced.
    await trustInNss({ home, ca, path: certutil.bin })
    assert.deepEqual(certutil.calls().slice(3).map((args) => args[2]), ['-D', '-A'])
  })

  it('does nothing when certutil is not on PATH (mock, a test machine)', async () => {
    const home = fresh()
    const ca = join(fresh(), 'ca.pem')
    writeFileSync(ca, PEM)
    assert.equal(await trustInNss({ home, ca, path: fresh() }), 'skipped, no certutil on PATH')
    assert.equal(await trustInNss({ home, ca, path: undefined }), 'skipped, no certutil on PATH')
    assert.equal(existsSync(join(home, '.pki')), false)
  })

  it('does nothing when there is no root, even with certutil', async () => {
    const home = fresh()
    const certutil = fakeCertutil()
    assert.equal(await trustInNss({ home, ca: null, path: certutil.bin }), 'skipped, no root to trust')
    assert.deepEqual(certutil.calls(), [])
    assert.equal(existsSync(join(home, '.pki')), false)
  })

  it('says it failed, without throwing, when certutil does', async () => {
    const home = fresh()
    const ca = join(fresh(), 'ca.pem')
    writeFileSync(ca, PEM)
    const bin = fresh()
    writeFileSync(join(bin, 'certutil'), '#!/bin/sh\necho broken >&2\nexit 1\n')
    chmodSync(join(bin, 'certutil'), 0o755)
    assert.match(await trustInNss({ home, ca, path: bin }), /^failed: /)
  })

  // The real certutil, where it is installed (the toolbelt, libnss3-tools): the root is listed with its trust.
  const certutil = onPath('certutil', process.env.PATH)
  const openssl = onPath('openssl', process.env.PATH)
  it('with the real certutil, the root is listed in the database', { skip: certutil === null || openssl === null ? 'no certutil or openssl on PATH' : false }, async () => {
    const home = fresh()
    const dir = fresh()
    const ca = join(dir, 'ca.pem')
    execFileSync(openssl!, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=Agora gateway CA (test)', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(dir, 'key.pem'), '-out', ca], { stdio: 'ignore' })
    for (let i = 0; i < 2; i++) assert.match(await trustInNss({ home, ca, path: process.env.PATH }), /trusted in /)
    const listed = execFileSync(certutil!, ['-d', `sql:${join(home, '.pki', 'nssdb')}`, '-L'], { encoding: 'utf8' })
    assert.match(listed, new RegExp(`^${NSS_NICKNAME}\\s+C,,\\s*$`, 'm'))
  })
})

describe('the gateway root for OpenSSL', () => {
  it('is SSL_CERT_FILE when the template sets it, else the mounted file, else none', () => {
    const dir = fresh()
    const mounted = join(dir, 'mounted.pem')
    const set = join(dir, 'set.pem')
    assert.equal(gatewayCa({}, mounted), null)
    writeFileSync(mounted, PEM)
    assert.equal(gatewayCa({}, mounted), mounted)
    assert.equal(gatewayCa({ SSL_CERT_FILE: join(dir, 'missing.pem') }, mounted), mounted)
    writeFileSync(set, PEM)
    assert.equal(gatewayCa({ SSL_CERT_FILE: set }, mounted), set)
  })

  it('sets SSL_CERT_FILE for the adapter only when the environment does not', () => {
    assert.deepEqual(trustEnv('/ca.pem', {}), { SSL_CERT_FILE: '/ca.pem' })
    assert.deepEqual(trustEnv('/ca.pem', { SSL_CERT_FILE: '/other.pem' }), {})
    assert.deepEqual(trustEnv(null, {}), {})
  })
})

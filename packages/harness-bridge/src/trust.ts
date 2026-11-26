// The gateway's root, trusted by what is not Node (docs/adr, Toolbelt). Node trusts it through NODE_EXTRA_CA_CERTS
// and git through GIT_SSL_CAINFO, both the template's; OpenSSL's clients — curl, wget, Python, uv, cargo — read
// SSL_CERT_FILE; Chromium reads neither, only the NSS database under HOME, which a sandbox starts without: the
// bridge creates it with certutil, when the image carries it (the toolbelt does), before the adapter starts.
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

/** Where the template mounts the gateway's root (the `credential-proxy-ca` ConfigMap). */
export const GATEWAY_CA = '/etc/agora/credential-proxy/ca.pem'

/** The nickname the root has in the NSS database. */
export const NSS_NICKNAME = 'Agora gateway CA'

/** The gateway's root, if there is one: SSL_CERT_FILE when the template sets it, else the mounted file. */
export function gatewayCa(env: NodeJS.ProcessEnv = process.env, fallback = GATEWAY_CA): string | null {
  for (const file of [env.SSL_CERT_FILE, fallback]) if (file !== undefined && file !== '' && existsSync(file)) return file
  return null
}

/** The variables that make OpenSSL's clients trust the root, those the environment does not already set. */
export function trustEnv(ca: string | null, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (ca === null || (env.SSL_CERT_FILE !== undefined && env.SSL_CERT_FILE !== '')) return {}
  return { SSL_CERT_FILE: ca }
}

/** An executable of that name on PATH, if there is one. */
export function onPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // Not there: the next one.
    }
  }
  return null
}

const run = promisify(execFile)

/**
 * Puts the root into HOME's NSS database (~/.pki/nssdb), created empty, with no password, if it is not there yet;
 * the root replaces the one of the same nickname. Nothing when certutil is not on PATH or there is no root.
 * Never throws: says what it did.
 */
export async function trustInNss(options: { home: string; ca: string | null; path: string | undefined }): Promise<string> {
  const certutil = onPath('certutil', options.path)
  if (certutil === null) return 'skipped, no certutil on PATH'
  if (options.ca === null) return 'skipped, no root to trust'
  const dir = join(options.home, '.pki', 'nssdb')
  const db = `sql:${dir}`
  const certutilRun = (args: string[]): Promise<unknown> => run(certutil, ['-d', db, ...args], { timeout: 10_000 })
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!existsSync(join(dir, 'cert9.db'))) await certutilRun(['-N', '--empty-password'])
    await certutilRun(['-D', '-n', NSS_NICKNAME]).catch(() => {})
    await certutilRun(['-A', '-n', NSS_NICKNAME, '-t', 'C,,', '-i', options.ca])
    return `${options.ca} trusted in ${dir}`
  } catch (error) {
    return `failed: ${(error as Error).message.split('\n')[0]}`
  }
}

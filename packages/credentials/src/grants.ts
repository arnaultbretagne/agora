// Composition by policy (docs/specs/credentials.md, "The gateway"): an execution's rights are a set of
// profiles, compiled here into grants — host, anchored regex on path and query, methods — and signed
// by Agora into a short JWT. The gateway checks each request against those grants, then sets the
// broad credential it holds for the host. No entity per combination: the set lives in the JWT.
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Credentials } from '@agora/harness-bridge/outbound'

export interface Grant {
  readonly host: string
  /** Anchored regex on `request.pathAndQuery`; every path when absent. */
  readonly path?: string
  /** Every method when absent. */
  readonly methods?: readonly string[]
}

export class ProfileRefused extends Error {
  readonly status = 400
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/
const READ = ['GET', 'HEAD'] as const

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compiles one profile. The catalogue is here, in code, reviewed like code. */
export function compileProfile(profile: string): Grant[] {
  if (profile === 'anthropic') return [{ host: 'api.anthropic.com' }]
  const github = /^github:([^/:]+)\/([^/:]+):(read|write)$/.exec(profile)
  if (github !== null) {
    const [, owner = '', repo = '', level] = github
    if (!NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') throw new ProfileRefused(`invalid repo: ${owner}/${repo}`)
    const rest = `^/repos/${escape(owner)}/${escape(repo)}(/[^?]*)?(\\?.*)?$`
    // git smart HTTP: a clone POSTs too (git-upload-pack); writing is git-receive-pack.
    const services = level === 'write' ? '(upload|receive)' : 'upload'
    const git = `^/${escape(owner)}/${escape(repo)}(\\.git)?/(info/refs\\?service=git-${services}-pack|git-${services}-pack)$`
    return level === 'write'
      ? [{ host: 'api.github.com', path: rest }, { host: 'github.com', path: git }]
      : [{ host: 'api.github.com', path: rest, methods: [...READ] }, { host: 'github.com', path: git }]
  }
  throw new ProfileRefused(`unknown profile: ${profile}`)
}

/** What a pool may declare for its warm Pods (docs/specs/credentials.md, "Base profiles"): a service, never a repository. */
export const BASE_PROFILES: ReadonlySet<string> = new Set(['anthropic'])

/** The annotation on a SandboxWarmPool that declares its base profiles, separated by commas. */
export const BASE_PROFILES_ANNOTATION = 'agora.bretagne.dev/base-profiles'

/** A pool's annotation, read: its base profiles, or none and the first profile refused. */
export function baseProfiles(annotation: string | undefined): { profiles: string[]; refused: string | null } {
  const profiles = (annotation ?? '')
    .split(',')
    .map((profile) => profile.trim())
    .filter((profile) => profile !== '')
  const refused = profiles.find((profile) => !BASE_PROFILES.has(profile)) ?? null
  return refused === null ? { profiles, refused: null } : { profiles: [], refused }
}

export function compileProfiles(profiles: readonly string[]): Grant[] {
  if (profiles.length === 0) throw new ProfileRefused('no profile')
  return profiles.flatMap(compileProfile)
}

export interface GrantSignerOptions {
  /** The gateway's CONNECT listener as the bridge reaches it, `host:port`. */
  readonly proxy: string
  readonly keyFile: string
  readonly keyId: string
  readonly issuer: string
  readonly audience: string
}

export class GrantSigner {
  private readonly options: GrantSignerOptions
  private key: KeyObject | null = null

  constructor(options: GrantSignerOptions) {
    this.options = options
  }

  describe(): { proxy: string; profiles: string[]; base: string[] } {
    return { proxy: this.options.proxy, profiles: ['anthropic', 'github:<owner>/<repo>:read', 'github:<owner>/<repo>:write'], base: [...BASE_PROFILES] }
  }

  async mint(input: { label: string; ttlSeconds: number; profiles?: readonly string[] }): Promise<Credentials> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 24 * 3600) throw new ProfileRefused('duration out of bounds: 60 to 86,400 s')
    const grants = compileProfiles(input.profiles ?? [])
    this.key ??= createPrivateKey(await readFile(this.options.keyFile))
    const now = Math.floor(Date.now() / 1000)
    const exp = now + input.ttlSeconds
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.options.keyId }
    const payload = { iss: this.options.issuer, aud: this.options.audience, sub: input.label, jti: randomUUID(), iat: now, exp, profiles: input.profiles, grants }
    const data = `${encode(header)}.${encode(payload)}`
    const token = `${data}.${sign(null, Buffer.from(data), this.key).toString('base64url')}`
    return { proxy: this.options.proxy, token, expiresAt: new Date(exp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  }
}

// Composition by policy (docs/specs/credentials.md, "The gateway"): an execution's rights are a set of
// profiles, compiled here into grants — host, anchored regex on path and query, methods — and signed
// by Agora into a short JWT. The gateway checks each request against those grants, then sets the
// broad credential it holds for the host. No entity per combination: the set lives in the JWT.
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import type { Credentials } from '@agora/harness-bridge/outbound'
import { LIMIT_ENDPOINTS } from './limits.ts'

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
  // z.ai (GLM): its OpenAI- and Anthropic-compatible APIs share the host.
  if (profile === 'zai') return [{ host: 'api.z.ai' }]
  // ChatGPT, for codex: only its backend's codex and account paths — the session reaches the whole
  // account, conversations included.
  if (profile === 'chatgpt') return [{ host: 'chatgpt.com', path: '^/backend-api/(codex|wham)(/[^?]*)?(\\?.*)?$' }]
  // The Internet: `*` stands for any host the gateway has no route of its own for, reached with no
  // credential. Its route alone reads `*`; the others compare the grant's host with the request's,
  // so this grant never opens a host that has a credential.
  if (profile === 'internet') return [{ host: '*' }]
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

/**
 * The profiles Agora gives itself, never an execution: unknown to `compileProfile`, so a Create or a
 * Scope naming one is refused. `limits` reads each account's usage endpoint (limits.ts), GET only.
 */
const OWN_PROFILES: Readonly<Record<string, () => Grant[]>> = {
  limits: () => Object.values(LIMIT_ENDPOINTS).map((e) => ({ host: e.host, path: `^${escape(e.path)}$`, methods: ['GET'] })),
}

/** What a pool may declare for its warm Pods (docs/specs/credentials.md, "Base profiles"): a service, never a repository nor the Internet. */
export const BASE_PROFILES: ReadonlySet<string> = new Set(['anthropic', 'zai', 'chatgpt'])

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

/** `OFFERED_PROFILES`, read (docs/specs/credentials.md, "Offered profiles"): each profile once, all known to the catalogue. */
export function offeredProfiles(value: string | undefined): string[] {
  const profiles = [...new Set((value ?? '').split(',').map((p) => p.trim()).filter((p) => p !== ''))]
  for (const profile of profiles) compileProfile(profile)
  return profiles
}

/** Whether a profile may be named, given those offered: itself, or a repository's read under its write. */
export function offers(offered: readonly string[], profile: string): boolean {
  if (offered.includes(profile)) return true
  const read = /^(github:[^:]+):read$/.exec(profile)
  return read !== null && offered.includes(`${read[1]!}:write`)
}

export interface GrantSignerOptions {
  /** The gateway's CONNECT listener as the bridge reaches it, `host:port`. */
  readonly proxy: string
  readonly keyFile: string
  readonly keyId: string
  readonly issuer: string
  readonly audience: string
  /** What an execution may be given beyond its pool's base profiles; any profile when empty. */
  readonly offered?: readonly string[]
}

export class GrantSigner {
  private readonly options: GrantSignerOptions
  private key: KeyObject | null = null

  constructor(options: GrantSignerOptions) {
    for (const profile of options.offered ?? []) compileProfile(profile)
    this.options = options
  }

  get offered(): readonly string[] {
    return this.options.offered ?? []
  }

  describe(): { proxy: string; profiles: string[]; base: string[]; offered: string[] } {
    return {
      proxy: this.options.proxy,
      profiles: ['anthropic', 'zai', 'chatgpt', 'internet', 'github:<owner>/<repo>:read', 'github:<owner>/<repo>:write'],
      base: [...BASE_PROFILES],
      offered: [...this.offered],
    }
  }

  /**
   * A token for these profiles; for none, a token with no grant, which withdraws the one before it.
   * `address` is the Pod's, as Kubernetes records it: the gateway takes the token only from there, so a
   * token read out of the Pod is worth nothing anywhere else.
   */
  async mint(input: { label: string; ttlSeconds: number; profiles?: readonly string[]; address: string }): Promise<Credentials> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 24 * 3600) throw new ProfileRefused('duration out of bounds: 60 to 86,400 s')
    if (isIP(input.address) === 0) throw new ProfileRefused(`invalid address: ${input.address}`)
    const grants = (input.profiles ?? []).flatMap((profile) => OWN_PROFILES[profile]?.() ?? compileProfile(profile))
    this.key ??= createPrivateKey(await readFile(this.options.keyFile))
    const now = Math.floor(Date.now() / 1000)
    const exp = now + input.ttlSeconds
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.options.keyId }
    const payload = { iss: this.options.issuer, aud: this.options.audience, sub: input.label, jti: randomUUID(), iat: now, exp, ip: input.address, profiles: input.profiles, grants }
    const data = `${encode(header)}.${encode(payload)}`
    const token = `${data}.${sign(null, Buffer.from(data), this.key).toString('base64url')}`
    return { proxy: this.options.proxy, token, expiresAt: new Date(exp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  }
}

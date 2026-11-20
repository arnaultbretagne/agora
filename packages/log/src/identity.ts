// Who calls the server (docs/specs/log.md, "Identity"). `oidc`: a proof on every request — the ID token the
// issuer signed for Agora's client, which the proxy in front passes as `Authorization: Bearer`, checked against
// the issuer's published keys; or a service token of the server's own list. `none`: the proxy's header as it
// comes, and without it every owner open.
import { createHash, timingSafeEqual } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { bearerOf } from '@agora/harness-bridge/token'
import { identity as nameBased, UUID } from './json.ts'

/** A caller a request proved: the owner its Workstreams belong to, and its e-mail when it has one. */
export interface Caller {
  readonly owner: string
  readonly email: string | null
}

/**
 * What a request proves: a caller; `anyone` — `none` without the proxy's header, every owner open; `refused` —
 * `oidc` and no valid proof; `unavailable` — `oidc`, a token that cannot be checked now, the issuer's keys out of reach.
 */
export type Proof =
  | { readonly kind: 'caller'; readonly caller: Caller }
  | { readonly kind: 'anyone' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unavailable' }

/** A service token of the server's list: the caller's name, its secret, the identity it stands for. */
export interface ServiceToken {
  readonly name: string
  readonly token: string
  readonly caller: Caller
}

export interface OidcOptions {
  /** The issuer, exactly as its discovery document and its tokens' `iss` name it. */
  readonly issuer: string
  /** Agora's client at the issuer: the `aud` its ID tokens carry. */
  readonly audience: string
  readonly tokens?: readonly ServiceToken[]
}

/** The tolerance on `exp` and `nbf`, for clocks a little apart. */
export const LEEWAY_SECONDS = 30
/** The shortest service token taken. */
export const MIN_SERVICE_TOKEN = 32
const FETCH_TIMEOUT_MS = 5000
/** What only `oidc` reads: given with `none`, the server does not start. */
const OIDC_ONLY = ['IDENTITY_ISSUER', 'IDENTITY_AUDIENCE', 'IDENTITY_TOKENS_DIR'] as const
/** The signatures taken: asymmetric ones only, whatever the discovery document lists. */
const ASYMMETRIC = /^((RS|PS|ES)(256|384|512)|EdDSA|Ed25519)$/
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const REFUSED: Proof = { kind: 'refused' }
const UNAVAILABLE: Proof = { kind: 'unavailable' }

/** The issuer, its discovery document or its keys, out of reach or answering something else than asked. */
class Unreachable extends Error {}

export class Identity {
  readonly mode: 'none' | 'oidc'
  private readonly check: (req: IncomingMessage) => Promise<Proof>
  private readonly proofs = new WeakMap<IncomingMessage, Promise<Proof>>()

  private constructor(mode: 'none' | 'oidc', check: (req: IncomingMessage) => Promise<Proof>) {
    this.mode = mode
    this.check = check
  }

  /** `none`: the identity the proxy passes in `X-Forwarded-Email`, as it comes; without it, anyone. */
  static none(): Identity {
    return new Identity('none', async (req) => {
      const header = req.headers['x-forwarded-email']
      return typeof header === 'string' && header !== '' ? { kind: 'caller', caller: { owner: nameBased('owner', header), email: header } } : { kind: 'anyone' }
    })
  }

  /** `oidc`: a bearer token that is one of the service tokens, or an ID token of the issuer for the audience. */
  static oidc(options: OidcOptions): Identity {
    const tokens = (options.tokens ?? []).map((t) => ({ caller: t.caller, digest: sha256(t.token) }))
    let keys: Promise<Keys> | null = null
    const keysOf = (): Promise<Keys> =>
      (keys ??= discover(options.issuer).catch((error: unknown) => {
        // Asked again at the next token: an issuer back in reach is used at once.
        keys = null
        throw error
      }))
    return new Identity('oidc', async (req) => {
      const token = bearerOf(req.headers.authorization)
      if (token === undefined || token === '') return REFUSED
      // Every service token compared, in constant time, whichever matches.
      const presented = sha256(token)
      let service: Caller | undefined
      for (const t of tokens) if (timingSafeEqual(presented, t.digest)) service = t.caller
      if (service !== undefined) return { kind: 'caller', caller: service }
      if (!JWT.test(token)) return REFUSED
      try {
        const { get, algorithms } = await keysOf()
        const { payload } = await jwtVerify(token, get, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms,
          clockTolerance: LEEWAY_SECONDS,
          requiredClaims: ['exp'],
        })
        const email = payload.email
        if (typeof email !== 'string' || email === '') return REFUSED
        return { kind: 'caller', caller: { owner: nameBased('owner', email), email } }
      } catch (error) {
        return error instanceof Unreachable || error instanceof errors.JWKSInvalid || error instanceof errors.JWKSTimeout ? UNAVAILABLE : REFUSED
      }
    })
  }

  /**
   * From the environment: IDENTITY `none` or `oidc`, nothing else, never left out; with `oidc`, IDENTITY_ISSUER and
   * IDENTITY_AUDIENCE, and IDENTITY_TOKENS_DIR for service tokens. A configuration that does not fit stops the start.
   */
  static fromEnv(env: NodeJS.ProcessEnv): Identity {
    const given = (name: string) => env[name] !== undefined && env[name] !== ''
    if (env.IDENTITY === 'none') {
      const oidcOnly = OIDC_ONLY.filter(given)
      if (oidcOnly.length > 0) throw new Error(`${oidcOnly.join(', ')}: only with IDENTITY=oidc`)
      return Identity.none()
    }
    if (env.IDENTITY === 'oidc') {
      for (const name of ['IDENTITY_ISSUER', 'IDENTITY_AUDIENCE']) if (!given(name)) throw new Error(`${name} is required with IDENTITY=oidc`)
      return Identity.oidc({
        issuer: env.IDENTITY_ISSUER!,
        audience: env.IDENTITY_AUDIENCE!,
        tokens: given('IDENTITY_TOKENS_DIR') ? readServiceTokens(env.IDENTITY_TOKENS_DIR!) : [],
      })
    }
    throw new Error('IDENTITY must be none or oidc')
  }

  /** What the request proves; asked twice for one request, the same answer. */
  prove(req: IncomingMessage): Promise<Proof> {
    let proof = this.proofs.get(req)
    if (proof === undefined) {
      proof = this.check(req).catch(() => REFUSED)
      this.proofs.set(req, proof)
    }
    return proof
  }
}

/**
 * Answers a request that proves no caller (docs/specs/log.md, "Identity"): 401 `unauthenticated`, or 503
 * `identity_unavailable` when its token cannot be checked now. Whether it did.
 */
export async function refuseUnproven(identity: Identity, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const proof = await identity.prove(req)
  if (proof.kind !== 'refused' && proof.kind !== 'unavailable') return false
  const refused = proof.kind === 'refused'
  res.writeHead(refused ? 401 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(refused ? { 'www-authenticate': 'Bearer' } : {}) })
  res.end(JSON.stringify({ reason: refused ? 'unauthenticated' : 'identity_unavailable' }))
  return true
}

/**
 * The service tokens of a folder — a Kubernetes Secret mounted, one file per caller, named after it: a JSON
 * object with `token`, and `email` or `owner`, the identity it stands for. A file that does not fit stops the
 * start, named, its content never shown.
 */
export function readServiceTokens(dir: string): ServiceToken[] {
  const out: ServiceToken[] = []
  // A mounted Secret's own entries (`..data`, its dated folder) start with a dot.
  for (const name of readdirSync(dir).filter((n) => !n.startsWith('.')).sort()) {
    const refuse = (why: string) => new Error(`service token ${name}: ${why}`)
    let value: unknown
    try {
      value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      throw refuse('not a JSON object')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse('not a JSON object')
    const entry = value as Record<string, unknown>
    const unknown = Object.keys(entry).filter((key) => !['token', 'email', 'owner'].includes(key))
    if (unknown.length > 0) throw refuse(`unknown ${unknown.join(', ')}`)
    const { token, email, owner } = entry
    if (typeof token !== 'string' || token.length < MIN_SERVICE_TOKEN || !/^[\x21-\x7e]+$/.test(token))
      throw refuse(`a token of at least ${String(MIN_SERVICE_TOKEN)} printable characters is required`)
    if ((email === undefined) === (owner === undefined)) throw refuse('either email or owner is required')
    let caller: Caller
    if (email !== undefined) {
      if (typeof email !== 'string' || email === '') throw refuse('email must be a non-empty string')
      caller = { owner: nameBased('owner', email), email }
    } else {
      if (typeof owner !== 'string' || !UUID.test(owner)) throw refuse('owner must be a UUID')
      caller = { owner: owner.toLowerCase(), email: null }
    }
    const same = out.find((t) => t.token === token)
    if (same !== undefined) throw refuse(`the same token as ${same.name}`)
    out.push({ name, token, caller })
  }
  return out
}

interface Keys {
  readonly get: JWTVerifyGetKey
  readonly algorithms: string[]
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** The issuer's discovery document: the keys' address, checked to name this issuer, and the signatures it uses. */
async function discover(issuer: string): Promise<Keys> {
  const document = await fetchJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (document.issuer !== issuer || typeof document.jwks_uri !== 'string') throw new Unreachable('discovery')
  const listed = document.id_token_signing_alg_values_supported
  // OpenID Connect Discovery: RS256 at least, when the document lists none.
  const algorithms = (Array.isArray(listed) ? listed : ['RS256']).filter((a): a is string => typeof a === 'string' && ASYMMETRIC.test(a))
  if (algorithms.length === 0) throw new Unreachable('discovery')
  let jwks: URL
  try {
    jwks = new URL(document.jwks_uri)
  } catch {
    throw new Unreachable('discovery')
  }
  // The keys, kept 10 minutes and read again at once for a key id they lack, at most every 30 s (jose's defaults).
  return { get: createRemoteJWKSet(jwks, { timeoutDuration: FETCH_TIMEOUT_MS, [customFetch]: fetchKeys }), algorithms }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status !== 200) throw new Unreachable('discovery')
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Unreachable('discovery')
    return value as Record<string, unknown>
  } catch (error) {
    throw error instanceof Unreachable ? error : new Unreachable('discovery')
  }
}

/** The keys' fetch for jose: a failure to reach them, an answer other than 200 or not JSON, is the issuer's, not the token's. */
async function fetchKeys(url: string, init: { headers: Headers; method: 'GET'; redirect: 'manual'; signal: AbortSignal }): Promise<Response> {
  try {
    const response = await fetch(url, init)
    if (response.status !== 200) throw new Unreachable('keys')
    const text = await response.text()
    JSON.parse(text)
    return new Response(text, { status: 200 })
  } catch (error) {
    throw error instanceof Unreachable ? error : new Unreachable('keys')
  }
}

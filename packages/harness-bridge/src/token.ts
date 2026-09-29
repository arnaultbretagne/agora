// Bridge tokens (docs/specs/executions.md, "The bridge's routes"). Agora signs with its Ed25519
// private key; the bridge only holds the public key, so a sandbox never contains a secret. The
// token names the sandbox it is for and expires after a minute: a token lifted from one sandbox is
// useless against another, and useless for long against the same one.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

const AUDIENCE = 'agora-bridge'
export const TOKEN_TTL_SECONDS = 60

export interface TokenClaims {
  readonly aud: string
  readonly sandbox: string
  readonly exp: number
}

export function privateKeyFrom(pem: string): KeyObject {
  return createPrivateKey(pem)
}

export function publicKeyFrom(pem: string): KeyObject {
  return createPublicKey(pem)
}

export function mintBridgeToken(privateKey: KeyObject, sandbox: string, options: { now?: number; ttlSeconds?: number } = {}): string {
  const now = options.now ?? Date.now()
  const claims: TokenClaims = {
    aud: AUDIENCE,
    sandbox,
    exp: Math.floor(now / 1000) + (options.ttlSeconds ?? TOKEN_TTL_SECONDS),
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url')
  return `${payload}.${signature}`
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export function verifyBridgeToken(publicKey: KeyObject, token: string, expectedSandbox: string, now: number = Date.now()): Verdict {
  const [payload, signature, extra] = token.split('.')
  if (payload === undefined || signature === undefined || extra !== undefined) return { ok: false, reason: 'malformed token' }
  if (!verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url'))) {
    return { ok: false, reason: 'signature invalide' }
  }
  let claims: Partial<TokenClaims>
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims>
  } catch {
    return { ok: false, reason: 'unreadable token' }
  }
  if (claims.aud !== AUDIENCE) return { ok: false, reason: 'audience inattendue' }
  if (claims.sandbox !== expectedSandbox) return { ok: false, reason: `token for ${String(claims.sandbox)}, not for ${expectedSandbox}` }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return { ok: false, reason: 'expired token' }
  return { ok: true }
}

/** Reads `Authorization: Bearer …` from a request's headers. */
export function bearerOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined
}

// Incarnation-bound bridge authentication (P4, replacing the S4 development shared secret;
// execution.md — "the bridge server in the Pod authenticates the control plane and the control
// plane authenticates the incarnation"). runtime-control mints the token at gate release, when it
// alone knows the Pod's incarnation is real; the harness Pod verifies it against the same secret
// mounted into both — no round trip back to runtime-control on every connection. A package, not
// apps/runtime-control or harnesses/claude-code themselves: both are deployables (ADR 0001 forbids
// one depending on the other) and both need the identical mint/verify logic.
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface BridgeTokenClaims {
  readonly incarnation: string
  /** Unix seconds. */
  readonly exp: number
}

function base64url(input: Buffer): string {
  return input.toString('base64url')
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest())
}

export function mintBridgeToken(incarnation: string, secret: string, ttlSeconds = 3600, now = Date.now()): string {
  const claims: BridgeTokenClaims = { incarnation, exp: Math.floor(now / 1000) + ttlSeconds }
  const payload = base64url(Buffer.from(JSON.stringify(claims)))
  return `${payload}.${sign(payload, secret)}`
}

export type BridgeTokenVerification = { readonly ok: true; readonly claims: BridgeTokenClaims } | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_incarnation' }

/** Verifies the token was minted for exactly this incarnation, is unexpired, and the signature matches — timing-safe. */
export function verifyBridgeToken(token: string, expectedIncarnation: string, secret: string, now = Date.now()): BridgeTokenVerification {
  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [payload, signature] = parts as [string, string]
  const expectedSignature = sign(payload, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expectedSignature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  let claims: BridgeTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BridgeTokenClaims
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (claims.incarnation !== expectedIncarnation) return { ok: false, reason: 'wrong_incarnation' }
  if (Math.floor(now / 1000) >= claims.exp) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}

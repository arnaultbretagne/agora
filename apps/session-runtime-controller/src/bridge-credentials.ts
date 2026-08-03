import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * docs/specs/08 "ACP endpoint": credentials are Session-bound, single-purpose, one-time or very
 * short-lived, never stored in product tables, redacted from logs. "Repeating a connection request
 * ID may return the same still-unused credential; a consumed or expired credential is never
 * revived." All state here is in-memory and process-local — correct because these credentials are
 * meant to be worthless outside the seconds it takes the caller to open the bridge connection they
 * were minted for.
 *
 * The credential is HMAC-signed (tamper-evident) but verification is NOT signature-only: `verify`
 * also requires the credential's nonce to still be present in `byNonce`. That's what makes
 * `revokeSession` (docs/specs/08 "Revoke bridge/grant during dematerialization") actually revoke an
 * already-handed-out, still-unexpired credential — a pure self-contained signature check could
 * never do that, since nothing about revocation is encoded in the token itself.
 */

const DEFAULT_TTL_MS = 60_000

export interface MintedConnection {
  readonly transport: 'websocket'
  readonly url: string
  readonly credential: string
  readonly expiresAt: string
}

interface StoredCredential {
  readonly sessionId: string
  readonly nonce: string
  readonly token: string
  readonly expiresAt: number
}

export class BridgeCredentialIssuer {
  private readonly byRequest = new Map<string, StoredCredential>()
  private readonly byNonce = new Map<string, StoredCredential>()
  private readonly secret: Buffer
  private readonly ttlMs: number

  constructor(options: { readonly secret?: Buffer; readonly ttlMs?: number } = {}) {
    this.secret = options.secret ?? randomBytes(32)
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  /** Idempotent by (sessionId, requestId): a retry before expiry returns the SAME unused credential. */
  mint(sessionId: string, requestId: string, endpointFor: (sessionId: string) => string, now = Date.now()): MintedConnection {
    const requestKey = `${sessionId}:${requestId}`
    const existing = this.byRequest.get(requestKey)
    if (existing && existing.expiresAt > now) return this.toConnection(existing, endpointFor)

    // An expired credential is never revived — mint a genuinely new one under the same request key.
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = now + this.ttlMs
    const token = this.sign(sessionId, nonce, expiresAt)
    const stored: StoredCredential = { sessionId, nonce, token, expiresAt }
    this.byRequest.set(requestKey, stored)
    this.byNonce.set(`${sessionId}:${nonce}`, stored)
    return this.toConnection(stored, endpointFor)
  }

  /**
   * The Pod-side bridge (or, in this plan, a test standing in for it) validates a presented
   * credential this way. required: "Session A cannot connect using Session B bridge credential" —
   * the credential is bound to its Session in the signed payload, not just by which map it lives in.
   */
  verify(sessionId: string, credential: string, now = Date.now()): boolean {
    const parsed = this.parse(credential)
    if (!parsed) return false
    if (parsed.sessionId !== sessionId) return false
    if (parsed.expiresAt <= now) return false
    const expected = this.sign(parsed.sessionId, parsed.nonce, parsed.expiresAt)
    const expectedBuf = Buffer.from(expected)
    const actualBuf = Buffer.from(credential)
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return false
    return this.byNonce.has(`${sessionId}:${parsed.nonce}`)
  }

  /** Invalidates every credential minted for this Session, including ones already handed out. */
  revokeSession(sessionId: string): void {
    for (const [key, value] of this.byRequest) if (value.sessionId === sessionId) this.byRequest.delete(key)
    for (const [key, value] of this.byNonce) if (value.sessionId === sessionId) this.byNonce.delete(key)
  }

  private toConnection(stored: StoredCredential, endpointFor: (sessionId: string) => string): MintedConnection {
    return {
      transport: 'websocket',
      url: endpointFor(stored.sessionId),
      credential: stored.token,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    }
  }

  private sign(sessionId: string, nonce: string, expiresAt: number): string {
    const payload = `${sessionId}.${nonce}.${expiresAt}`
    const mac = createHmac('sha256', this.secret).update(payload).digest('base64url')
    return `${payload}.${mac}`
  }

  private parse(credential: string): { sessionId: string; nonce: string; expiresAt: number } | undefined {
    const parts = credential.split('.')
    if (parts.length !== 4) return undefined
    const [sessionId, nonce, expiresAtText] = parts
    const expiresAt = Number(expiresAtText)
    if (!sessionId || !nonce || Number.isNaN(expiresAt)) return undefined
    return { sessionId, nonce, expiresAt }
  }
}

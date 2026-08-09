import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * docs/specs/07-custody.md "Access control": "session-runtime: no database credentials; bytes
 * enter through one-time restore/capture streams." Unlike `BridgeCredentialIssuer` (short-TTL but
 * reusable within that window — an ACP bridge connection may legitimately be retried), a restore
 * credential is genuinely single-use: `consume` deletes it on its first successful presentation,
 * so a Pod that restores once and later crashes-and-restarts (a NEW materialize, hence a NEW
 * credential) can never replay the old one.
 */

const DEFAULT_TTL_MS = 60_000

interface StoredCredential {
  readonly sessionId: string
  readonly snapshotId: string
  readonly nonce: string
  readonly expiresAt: number
}

export class CustodyStreamIssuer {
  private readonly byNonce = new Map<string, StoredCredential>()
  private readonly secret: Buffer
  private readonly ttlMs: number

  constructor(options: { readonly secret?: Buffer; readonly ttlMs?: number } = {}) {
    this.secret = options.secret ?? randomBytes(32)
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  mint(sessionId: string, snapshotId: string, now = Date.now()): string {
    const nonce = randomBytes(16).toString('hex')
    const expiresAt = now + this.ttlMs
    const stored: StoredCredential = { sessionId, snapshotId, nonce, expiresAt }
    this.byNonce.set(nonce, stored)
    return this.sign(sessionId, snapshotId, nonce, expiresAt)
  }

  /** Verifies AND consumes: a second presentation of the same credential always fails, even within its TTL. */
  consume(sessionId: string, credential: string, now = Date.now()): { readonly snapshotId: string } | undefined {
    const parsed = this.parse(credential)
    if (!parsed) return undefined
    if (parsed.sessionId !== sessionId) return undefined
    const stored = this.byNonce.get(parsed.nonce)
    if (!stored) return undefined
    if (stored.expiresAt <= now) {
      this.byNonce.delete(parsed.nonce)
      return undefined
    }
    const expected = this.sign(stored.sessionId, stored.snapshotId, stored.nonce, stored.expiresAt)
    const expectedBuf = Buffer.from(expected)
    const actualBuf = Buffer.from(credential)
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return undefined

    this.byNonce.delete(parsed.nonce)
    return { snapshotId: stored.snapshotId }
  }

  /** Invalidates every not-yet-consumed credential minted for this Session (e.g. a superseding materialize). */
  revokeSession(sessionId: string): void {
    for (const [key, value] of this.byNonce) if (value.sessionId === sessionId) this.byNonce.delete(key)
  }

  private sign(sessionId: string, snapshotId: string, nonce: string, expiresAt: number): string {
    const payload = `${sessionId}.${snapshotId}.${nonce}.${expiresAt}`
    const mac = createHmac('sha256', this.secret).update(payload).digest('base64url')
    return `${payload}.${mac}`
  }

  private parse(credential: string): { sessionId: string; snapshotId: string; nonce: string; expiresAt: number } | undefined {
    const parts = credential.split('.')
    if (parts.length !== 5) return undefined
    const [sessionId, snapshotId, nonce, expiresAtText] = parts
    const expiresAt = Number(expiresAtText)
    if (!sessionId || !snapshotId || !nonce || Number.isNaN(expiresAt)) return undefined
    return { sessionId, snapshotId, nonce, expiresAt }
  }
}

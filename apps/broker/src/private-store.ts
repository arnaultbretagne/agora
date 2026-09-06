// The Broker-private upstream authority (ADR 0009): the Agent's OneCLI gateway bearer never
// reaches the Pod. Held here, encrypted at rest with an externally supplied key — loss of the key
// closes access (nothing recoverable, nothing to roll back to a weaker mode).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export interface PrivateStore {
  put(incarnation: string, bearer: string): void
  get(incarnation: string): string | undefined
  delete(incarnation: string): void
}

/** In-memory, encrypted at rest (AES-256-GCM) — the bearer never sits as plaintext even in a heap dump of this process beyond the brief window a call needs it. */
export class EncryptedPrivateStore implements PrivateStore {
  readonly #key: Buffer
  readonly #entries = new Map<string, { readonly iv: Buffer; readonly ciphertext: Buffer; readonly authTag: Buffer }>()

  constructor(encryptionKey: string) {
    this.#key = scryptSync(encryptionKey, 'agora-broker-private-store', 32)
  }

  put(incarnation: string, bearer: string): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const ciphertext = Buffer.concat([cipher.update(bearer, 'utf8'), cipher.final()])
    this.#entries.set(incarnation, { iv, ciphertext, authTag: cipher.getAuthTag() })
  }

  get(incarnation: string): string | undefined {
    const entry = this.#entries.get(incarnation)
    if (entry === undefined) return undefined
    const decipher = createDecipheriv('aes-256-gcm', this.#key, entry.iv)
    decipher.setAuthTag(entry.authTag)
    return Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]).toString('utf8')
  }

  delete(incarnation: string): void {
    this.#entries.delete(incarnation)
  }
}

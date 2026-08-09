import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * docs/specs/10-equipment-and-broker.md "Secrets": the dedicated OneCLI Agent upstream bearer is
 * "encrypted in Broker-private operational state" — AES-256-GCM with an externally supplied key
 * (matching the OneCLI spike's own "external encryption key" pattern, ONECLI-SPIKE.md
 * "Persistence and restart"), never derived from anything stored beside the ciphertext.
 */
const AUTH_TAG_LENGTH = 16
const NONCE_LENGTH = 12

export interface EncryptedBearer {
  readonly ciphertext: Buffer
  readonly nonce: Buffer
}

export function encryptUpstreamBearer(key: Buffer, plaintext: string): EncryptedBearer {
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([encrypted, authTag]), nonce }
}

export function decryptUpstreamBearer(key: Buffer, encrypted: EncryptedBearer): string {
  const authTag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - AUTH_TAG_LENGTH)
  const body = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** Fail-fast: no default key — prod without BROKER_ENCRYPTION_KEY must not silently encrypt with a random, unrecoverable one. */
export function requireEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env['BROKER_ENCRYPTION_KEY']
  if (!hex) throw new Error('BROKER_ENCRYPTION_KEY is required')
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) throw new Error('BROKER_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters)')
  return key
}

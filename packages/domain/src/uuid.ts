import { createHash } from 'node:crypto'

const HEX = '0123456789abcdef'

function toUuidString(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function parseUuid(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) throw new TypeError(`not a UUID: ${uuid}`)
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * RFC 9562 name-based UUID (version 5, SHA-1): the same (namespace, name) pair always yields the
 * same UUID. Commands use this to derive their identity from (Workstream, idempotency scope,
 * idempotency key) so an identical retry resolves to the same durable command by construction,
 * without a database round trip.
 */
export function nameBasedUuid(namespaceUuid: string, name: string): string {
  const namespaceBytes = parseUuid(namespaceUuid)
  const nameBytes = Buffer.from(name, 'utf8')
  const digest = createHash('sha1').update(namespaceBytes).update(nameBytes).digest()
  const bytes = digest.subarray(0, 16)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  return toUuidString(bytes)
}

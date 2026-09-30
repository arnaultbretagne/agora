import { createHash } from 'node:crypto'
import { parse, stringify, isLosslessNumber } from 'lossless-json'

export function decode(text: string): unknown {
  return parse(text, null, {
    onDuplicateKey: () => {
      throw new Error('duplicate_key')
    },
  })
}
export function encode(value: unknown): string {
  const text = stringify(value)
  if (text === undefined) throw new Error('unsupported_json_value')
  return text
}
function numeric(raw: string): string {
  const [mantissa = '', power = '0'] = raw.toLowerCase().split('e')
  const negative = mantissa.startsWith('-'),
    [whole = '', fraction = ''] = mantissa.replace('-', '').split('.')
  let digits = (whole + fraction).replace(/^0+/, '')
  if (!digits) return '0'
  let exponent = Number(power) - fraction.length
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exponent++
  }
  return `${negative ? '-' : ''}${digits}e${exponent}`
}
export function canonical(value: unknown): string {
  if (isLosslessNumber(value)) return numeric(value.value)
  if (typeof value === 'number') return numeric(String(value))
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return encode(value)
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isLosslessNumber(value)
    ? (value as Record<string, unknown>)
    : null
}
// Ajv needs ordinary numbers only for validation. The original line always goes directly to jsonb.
export function schemaValue(value: unknown): unknown {
  if (isLosslessNumber(value)) return Number(value.value)
  if (Array.isArray(value)) return value.map(schemaValue)
  if (object(value))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, schemaValue(v)]))
  return value
}
export function supported(value: unknown): boolean {
  if (typeof value === 'string')
    return (
      !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    )
  if (isLosslessNumber(value)) {
    const [mantissa = '', exponent = '0'] = value.value.toLowerCase().split('e')
    const exp = Number(exponent)
    const [whole = '', fraction = ''] = mantissa.replace('-', '').split('.')
    return Number.isSafeInteger(exp) && whole.length + exp <= 131072 && fraction.length - exp <= 16383
  }
  if (Array.isArray(value)) return value.every(supported)
  if (object(value))
    return Object.entries(value as Record<string, unknown>).every(([key, v]) => supported(key) && supported(v))
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid_identifier')
  return value.toLowerCase()
}
export function cursor(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('invalid_cursor')
  const n = BigInt(value)
  if (n > 9223372036854775807n) throw new Error('invalid_cursor')
  return n
}
export function identity(...parts: string[]): string {
  // RFC 9562 UUIDv5, salvaged from projections/src/ids.ts; scope is a stable Agora namespace.
  const namespace = Buffer.from('dda9fd6b8f705dd09b18d5c9143ac501', 'hex')
  const bytes = createHash('sha1').update(namespace).update(encode(parts)).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

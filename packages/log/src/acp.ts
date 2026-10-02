import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { default as addFormatsModule } from 'ajv-formats'
import { isLosslessNumber } from 'lossless-json'
import { decode, object, schemaValue, supported, encode, canonical } from './json.ts'

export const MAX_LINE = 16 * 1024 * 1024
export type Direction = 'in' | 'out'
export type RpcKind = 'request' | 'response' | 'error' | 'notification'
export type Reason =
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_envelope'
  | 'batch'
  | 'wrong_direction'
  | 'invalid_body'
  | 'unsafe_id'
  | 'line_too_large'
  | 'unsupported_json_value'
  | 'transport_error'
  | 'response_timeout'
  | 'deadline_refused'
  | 'startup_failed'
  | 'restore_failed'
  | 'claim_conflict'
  | 'claim_missing'
  | 'adapter_exited'
  | 'instance_changed'
  | 'deadline_reached'
  | 'stopped'
  | 'replaced'
  | 'anchor_missing'
  | 'credentials_refused'
export interface Envelope {
  value: Record<string, unknown>
  raw: string
  kind: RpcKind
  method: string | null
  id: unknown
  extension: boolean
}
export type Validation = { ok: true; envelope: Envelope } | { ok: false; reason: Reason; id?: unknown }
const schema = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('@agentclientprotocol/sdk/schema/schema.json'), 'utf8'),
) as { $defs: Record<string, Record<string, unknown>> }
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true })
const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void
addFormats(ajv)
for (const format of ['uint16', 'uint32', 'uint64'])
  ajv.addFormat(format, {
    type: 'number',
    validate: (n: number) =>
      Number.isInteger(n) &&
      n >= 0 &&
      n <= ({ uint16: 65535, uint32: 4294967295, uint64: 18446744073709551615 }[format] ?? 0),
  })
ajv.addSchema({ $id: 'acp', $defs: schema.$defs })
const methods = new Map<string, { kind: RpcKind; side: string; validate: ReturnType<Ajv2020['compile']> }[]>()
const updates = new Set<string>(
  ((schema.$defs.SessionUpdate?.oneOf as Record<string, unknown>[]) ?? []).map((v) =>
    String(object(object(v.properties)?.sessionUpdate)?.const),
  ),
)
for (const [name, def] of Object.entries(schema.$defs)) {
  const discriminator = object(object(def.properties)?.sessionUpdate)
  if (typeof discriminator?.const === 'string') updates.add(discriminator.const)
  if (typeof def['x-method'] !== 'string') continue
  const kind = name.endsWith('Request') ? 'request' : name.endsWith('Response') ? 'response' : 'notification'
  const list = methods.get(def['x-method']) ?? []
  list.push({ kind, side: String(def['x-side']), validate: ajv.compile({ $ref: `acp#/$defs/${name}` }) })
  methods.set(def['x-method'], list)
}
export function requestMethod(method: string): boolean {
  return methods.get(method)?.some((d) => d.kind === 'request') ?? true
}
function safeId(id: unknown): boolean {
  if (id === null || typeof id === 'string') return true
  const n = isLosslessNumber(id) ? Number(id.value) : id
  return typeof n === 'number' && Number.isSafeInteger(n) && canonical(id) === canonical(n)
}
export function idKey(id: unknown): string {
  return isLosslessNumber(id) ? encode(Number(id.value)) : encode(id)
}
export function validate(
  raw: string | Uint8Array,
  direction: Direction,
  correlated?: { method: string; direction: Direction },
): Validation {
  if (Buffer.byteLength(raw) > MAX_LINE) return { ok: false, reason: 'line_too_large' }
  let text: string
  try {
    text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return { ok: false, reason: 'invalid_utf8' }
  }
  let value: unknown
  try {
    value = decode(text)
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && ['duplicate_key', 'unsafe_key'].includes(error.message)
          ? 'unsupported_json_value'
          : 'invalid_json',
    }
  }
  if (Array.isArray(value)) return { ok: false, reason: 'batch' }
  const v = object(value)
  if (!v) return { ok: false, reason: 'invalid_envelope' }
  const hasId = Object.hasOwn(v, 'id')
  const id = v.id
  if (hasId && !safeId(id)) return { ok: false, reason: 'unsafe_id' }
  const invalid = (reason: Reason): Validation => ({ ok: false, reason, ...(hasId ? { id } : {}) })
  if (!supported(v)) return invalid('unsupported_json_value')
  const method = typeof v.method === 'string' ? v.method : null
  const hasResult = Object.hasOwn(v, 'result'),
    hasError = Object.hasOwn(v, 'error')
  if (
    v.jsonrpc !== '2.0' ||
    (Object.hasOwn(v, 'method') && (method === null || method === '')) ||
    (method !== null && (hasResult || hasError)) ||
    (method === null && (!hasId || hasResult === hasError)) ||
    (Object.hasOwn(v, 'params') && method === null)
  )
    return invalid('invalid_envelope')
  if (Object.hasOwn(v, 'params') && object(v.params) === null && !Array.isArray(v.params))
    return invalid('invalid_envelope')
  const kind: RpcKind = method !== null ? (hasId ? 'request' : 'notification') : hasError ? 'error' : 'response'
  if (correlated && kind !== 'request' && kind !== 'notification' && correlated.direction === direction)
    return invalid('wrong_direction')
  if (kind === 'error') {
    const e = object(v.error),
      code = e ? schemaValue(e.code) : null
    if (!e || typeof code !== 'number' || !Number.isInteger(code) || typeof e.message !== 'string')
      return invalid('invalid_body')
  }
  const routed = method ?? correlated?.method
  const descriptors = routed ? methods.get(routed) : undefined
  let extension = !descriptors
  if (descriptors) {
    const side =
      kind === 'response' || kind === 'error'
        ? direction === 'in'
          ? 'agent'
          : 'client'
        : direction === 'out'
          ? 'agent'
          : 'client'
    const candidates = descriptors.filter(
      (d) =>
        (kind === 'error' ? d.kind === 'response' : d.kind === kind) &&
        (d.side === side || d.side === 'both' || d.side === 'protocol'),
    )
    if (candidates.length === 0) return invalid('wrong_direction')
    if (kind !== 'error') {
      const params = object(v.params),
        update = object(params?.update)
      if (
        method === 'session/update' &&
        typeof params?.sessionId === 'string' &&
        typeof update?.sessionUpdate === 'string' &&
        !updates.has(update.sessionUpdate)
      )
        extension = true
      else if (!candidates.some((d) => d.validate(schemaValue(kind === 'response' ? v.result : (v.params ?? {})))))
        return invalid('invalid_body')
    }
  }
  return { ok: true, envelope: { value: v, raw: text, kind, method, id: hasId ? id : null, extension } }
}

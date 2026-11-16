// An elicitation (docs/specs/log.md, "Requests"): ACP's `elicitation/create` in form mode, a JSON Schema of flat
// fields — a text, a number, an integer, true or false, one option (`oneOf` or `enum`), several (`array`, its `items`
// `anyOf` or `enum`). Agora shows it to whoever answers, checks what comes back against it, and declines itself what it
// does not show.
import { object, schemaValue } from './json.ts'

/** The requests an agent blocks on until someone answers: a permission, an elicitation. */
export const REQUEST_METHODS: readonly string[] = ['session/request_permission', 'elicitation/create']

export interface Field {
  readonly key: string
  readonly type: string
  readonly title: string | null
  readonly description: string | null
  readonly required: boolean
  /** Its options' values, titles and descriptions: one of them for a choice, any of them for an `array`. */
  readonly options: readonly { value: string; title: string; description: string | null }[] | null
  readonly minimum: number | null
  readonly maximum: number | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const bound = (value: unknown): number | null => {
  const n = schemaValue(value)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function optionsOf(list: unknown): Field['options'] {
  if (!Array.isArray(list)) return null
  return list.map((raw) => {
    const o = object(raw)
    if (o === null) return { value: String(raw), title: String(raw), description: null }
    return { value: String(o.const), title: text(o.title) ?? String(o.const), description: text(o.description) }
  })
}

/**
 * The order of a form's fields: the log keeps no member order (docs/specs/log.md, "ACP lines"), so those its `required`
 * list names come first, in its order — Codex's questions —, then the others by name, a number compared as a number —
 * Claude Code's `question_<n>`.
 */
export function fieldOrder(keys: readonly string[], required: readonly string[]): string[] {
  const rank = (key: string) => (required.includes(key) ? required.indexOf(key) : required.length)
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
}

/** A form's fields, in their order (`fieldOrder`). */
export function fieldsOf(params: unknown): Field[] {
  const schema = object(object(params)?.requestedSchema)
  const listed = Array.isArray(schema?.required) ? schema.required.map(String) : []
  const required = new Set(listed)
  const properties = object(schema?.properties) ?? {}
  return fieldOrder(Object.keys(properties), listed).map((key) => [key, properties[key]] as const).map(([key, raw]) => {
    const p = object(raw) ?? {}
    const items = object(p.items)
    const options = p.type === 'array' ? (optionsOf(items?.anyOf) ?? optionsOf(items?.enum)) : (optionsOf(p.oneOf) ?? optionsOf(p.enum))
    const array = p.type === 'array'
    return {
      key,
      type: String(p.type),
      title: text(p.title),
      description: text(p.description),
      required: required.has(key),
      options,
      minimum: bound(array ? p.minItems : p.type === 'string' ? p.minLength : p.minimum),
      maximum: bound(array ? p.maxItems : p.type === 'string' ? p.maxLength : p.maximum),
    }
  })
}

/**
 * Why Agora answers an elicitation itself, declining it, or null when it goes to whoever answers (docs/specs/log.md,
 * "Requests"): `mode`, not a form — Agora declares no other; `async`, a question Codex asks without waiting
 * (`_meta.codex.delivery` `async`); `secret`, a field Codex marks secret (`_meta.codex.isSecret`), which the log would
 * keep in clear.
 */
export function declinedBy(params: unknown): 'mode' | 'async' | 'secret' | null {
  const p = object(params)
  if (p?.mode !== 'form') return 'mode'
  if (object(object(p._meta)?.codex)?.delivery === 'async') return 'async'
  const fields = Object.values(object(object(p.requestedSchema)?.properties) ?? {})
  if (fields.some((f) => object(object(object(f)?._meta)?.codex)?.isSecret === true)) return 'secret'
  return null
}

const quoted = (value: unknown): string => JSON.stringify(schemaValue(value))

/** Why this content does not fit the form, naming the field, or null when it does (docs/specs/log.md, "Commands"). */
export function contentRefusal(params: unknown, content: unknown): string | null {
  const given = content === undefined || content === null ? {} : object(content)
  if (given === null) return 'not an object'
  const fields = new Map(fieldsOf(params).map((f) => [f.key, f]))
  for (const [key, raw] of Object.entries(given)) {
    const field = fields.get(key)
    if (field === undefined) return `${key}: not a field of the form`
    const value = schemaValue(raw)
    const values = field.options?.map((o) => o.value)
    if (field.type === 'string') {
      if (typeof value !== 'string') return `${key}: not a text`
      if (values && !values.includes(value)) return `${key}: ${quoted(value)} is not one of its options`
      if ((field.minimum !== null && value.length < field.minimum) || (field.maximum !== null && value.length > field.maximum)) return `${key}: its length is out of bounds`
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${key}: not a number`
      if (field.type === 'integer' && !Number.isInteger(value)) return `${key}: not an integer`
      if ((field.minimum !== null && value < field.minimum) || (field.maximum !== null && value > field.maximum)) return `${key}: out of bounds`
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') return `${key}: not true or false`
    } else if (field.type === 'array') {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return `${key}: not a list of texts`
      const strange = values ? value.find((v) => !values.includes(v as string)) : undefined
      if (strange !== undefined) return `${key}: ${quoted(strange)} is not one of its options`
      if (new Set(value).size !== value.length) return `${key}: an option twice`
      if ((field.minimum !== null && value.length < field.minimum) || (field.maximum !== null && value.length > field.maximum)) return `${key}: out of bounds`
    } else return `${key}: a field of a type Agora does not know`
  }
  const missing = [...fields.values()].find((f) => f.required && !Object.hasOwn(given, f.key))
  return missing === undefined ? null : `${missing.key}: required`
}

const KIND: Record<string, string> = { string: 'text', number: 'a number', integer: 'an integer', boolean: 'true or false' }

/** A form's fields as its delegator reads them (docs/specs/delegation.md, "Requests"): one line each, its options under it. */
export function fieldsText(params: unknown): string[] {
  return fieldsOf(params).flatMap((f) => {
    const kind = f.options ? (f.type === 'array' ? 'any of the options below' : 'one of the options below') : (KIND[f.type] ?? f.type)
    const range = f.minimum !== null || f.maximum !== null ? `, ${f.minimum ?? '…'} to ${f.maximum ?? '…'}` : ''
    const about = [f.title, f.description].filter((s) => s !== null).join(' — ')
    return [
      `- \`${f.key}\` (${kind}${range}${f.required ? ', required' : ''})${about === '' ? '' : `: ${about}`}`,
      ...(f.options ?? []).map((o) => `  - \`${o.value}\`${o.title !== o.value ? ` "${o.title}"` : ''}${o.description ? `: ${o.description}` : ''}`),
    ]
  })
}

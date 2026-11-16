// An elicitation (docs/specs/log.md, "Requests"): ACP's `elicitation/create` in form mode, a JSON Schema of flat
// fields — a text, a number, an integer, true or false, one option (`oneOf` or `enum`), several (`array`, its `items`
// `anyOf` or `enum`). Agora shows it to whoever answers, checks what comes back against it, and declines itself what it
// does not show.
import { Worker } from 'node:worker_threads'
import { fullFormats } from 'ajv-formats/dist/formats.js'
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
  /** A number's or an integer's bounds; a list's, in items; a text's, in code points. */
  readonly minimum: number | null
  readonly maximum: number | null
  /** A text's `format` (`email`, `uri`, `date`, `date-time`) and `pattern`, as its schema gives them. */
  readonly format: string | null
  readonly pattern: string | null
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
      format: p.type === 'string' ? text(p.format) : null,
      pattern: p.type === 'string' ? text(p.pattern) : null,
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

/** ACP's formats (`StringFormat`), checked as ajv-formats checks them: the same checks Agora validates its lines with. */
const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  email: (v) => (fullFormats.email as RegExp).test(v),
  uri: (v) => (fullFormats.uri as (value: string) => boolean)(v),
  date: (v) => (fullFormats.date as { validate: (value: string) => boolean }).validate(v),
  'date-time': (v) => (fullFormats['date-time'] as { validate: (value: string) => boolean }).validate(v),
}

/** A text's length as JSON Schema counts it: in code points, not UTF-16 units. */
const length = (value: string): number => [...value].length

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
      if ((field.minimum !== null && length(value) < field.minimum) || (field.maximum !== null && length(value) > field.maximum)) return `${key}: its length is out of bounds`
      if (field.format !== null && !(FORMATS[field.format]?.(value) ?? true)) return `${key}: not ${field.format === 'email' ? 'an' : 'a'} ${field.format}`
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

/** How long an agent's pattern may run, off the main thread, before the content it checks is refused. */
const PATTERN_MS = 1_000

/** What a worker runs: each value against its pattern, as JSON Schema means it — ECMAScript, Unicode, found anywhere. */
const PATTERNS = `
const { parentPort, workerData } = require('node:worker_threads')
let out = null
for (const c of workerData) {
  let re
  try { re = new RegExp(c.pattern, 'u') } catch { out = c.key + ': its pattern is no regular expression'; break }
  if (!re.test(c.value)) { out = c.key + ': does not match its pattern'; break }
}
parentPort.postMessage(out)
`

/** The texts of a content that have a `pattern` to match: what `patternRefusal` checks, none when it needs no worker. */
export function patternChecks(params: unknown, content: unknown): { key: string; pattern: string; value: string }[] {
  const given = object(content) ?? {}
  return fieldsOf(params)
    .filter((f) => f.pattern !== null && typeof schemaValue(given[f.key]) === 'string')
    .map((f) => ({ key: f.key, pattern: f.pattern!, value: schemaValue(given[f.key]) as string }))
}

/**
 * Why a content's texts do not match their fields' `pattern`, or null when they do (docs/specs/log.md, "Requests"). A
 * pattern is the agent's, from a hostile sandbox: never run on the server's thread, where a runaway one (ReDoS) would
 * hold every Workstream. It runs in a worker of its own, 16 MB, cut after PATTERN_MS: past that, the content is
 * refused, never the server held.
 */
export function patternRefusal(params: unknown, content: unknown): Promise<string | null> {
  const checks = patternChecks(params, content)
  if (checks.length === 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    const worker = new Worker(PATTERNS, { eval: true, workerData: checks, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 } })
    const done = (answer: string | null) => {
      clearTimeout(timer)
      worker.removeAllListeners()
      void worker.terminate()
      resolve(answer)
    }
    const timer = setTimeout(() => done(`${checks[0]!.key}: its pattern could not be checked in time`), PATTERN_MS)
    worker.once('message', (answer: string | null) => done(answer))
    worker.once('error', () => done(`${checks[0]!.key}: its pattern could not be checked`))
  })
}

const KIND: Record<string, string> = { string: 'text', number: 'a number', integer: 'an integer', boolean: 'true or false' }

/** A form's fields as its delegator reads them (docs/specs/delegation.md, "Requests"): one line each, its options under it. */
export function fieldsText(params: unknown): string[] {
  return fieldsOf(params).flatMap((f) => {
    const kind = f.options ? (f.type === 'array' ? 'any of the options below' : 'one of the options below') : (KIND[f.type] ?? f.type)
    const range = f.minimum !== null || f.maximum !== null ? `, ${f.minimum ?? '…'} to ${f.maximum ?? '…'}${f.type === 'string' ? ' characters' : f.type === 'array' ? ' of them' : ''}` : ''
    const shape = `${f.format !== null ? `, ${f.format}` : ''}${f.pattern !== null ? `, matching \`${f.pattern}\`` : ''}`
    const about = [f.title, f.description].filter((s) => s !== null).join(' — ')
    return [
      `- \`${f.key}\` (${kind}${range}${shape}${f.required ? ', required' : ''})${about === '' ? '' : `: ${about}`}`,
      ...(f.options ?? []).map((o) => `  - \`${o.value}\`${o.title !== o.value ? ` "${o.title}"` : ''}${o.description ? `: ${o.description}` : ''}`),
    ]
  })
}

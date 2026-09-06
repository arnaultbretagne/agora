// Structured logs (S11 Step 3 — execution.md "Harness and owner conformance", logs paragraph).
//
// The rule is an ALLOW LIST, not a redaction pass. A denylist asks "does this look like a secret?"
// of every value, and the answer is wrong the first time a prompt happens not to look like one —
// prompts, tool results, Save bytes and query strings are not credentials and would sail through
// any pattern check. So a log line carries the correlation set and nothing else, and a field nobody
// registered simply does not appear.
//
// What is allowed, and why each one is safe: they are all identifiers or closed vocabularies that
// the product API already exposes to the person who owns the Workstream.
export const ALLOWED_FIELDS = [
  'actor',
  'workstream',
  'session',
  'target',
  'revision',
  'rule',
  'verb',
  'outcome',
  'errorClass',
  'harness',
  'incarnation',
  'command',
  'durationMs',
  'count',
] as const

export type AllowedField = (typeof ALLOWED_FIELDS)[number]

export type LogFields = Partial<Record<AllowedField, string | number>>

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly fields: LogFields
  /** Fields that were dropped because they are not in the allow list — counted, never printed. */
  readonly dropped: number
}

const ALLOWED = new Set<string>(ALLOWED_FIELDS)

/**
 * Builds the line. Values are stringified and truncated: an allowed field holding a 4 MB tool result
 * would still be a leak of volume even if it is not a leak of a secret, and an id that long is not
 * an id.
 */
export function buildLogLine(level: LogLine['level'], event: string, fields: Record<string, unknown>): LogLine {
  const kept: Record<string, string | number> = {}
  let dropped = 0
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) {
      dropped += 1
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      kept[key] = value
      continue
    }
    if (value === undefined || value === null) continue
    const text = String(value)
    kept[key] = text.length > 200 ? `${text.slice(0, 200)}…` : text
  }
  return { level, event, fields: kept as LogFields, dropped }
}

export function formatLogLine(line: LogLine): string {
  return JSON.stringify({ level: line.level, event: line.event, ...line.fields, ...(line.dropped > 0 ? { droppedFields: line.dropped } : {}) })
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/**
 * A logger over a sink (stdout by default). Deliberately not a general-purpose logger: there is no
 * `log(message)` that takes free text, because free text is exactly how a prompt ends up in a log
 * line. An event name plus registered fields, or nothing.
 */
export function createLogger(write: (line: string) => void = (line) => console.log(line)): Logger {
  const emit = (level: LogLine['level']) => (event: string, fields: Record<string, unknown> = {}) => {
    write(formatLogLine(buildLogLine(level, event, fields)))
  }
  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}

/**
 * The error's CLASS, never its message. A message can contain anything the failing call had in
 * scope — a URL with a query string, a bearer, the prompt that failed to send.
 */
export function errorClass(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code.length > 0 ? code : error.name
  }
  return 'unknown'
}

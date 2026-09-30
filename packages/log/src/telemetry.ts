import { UUID, cursor } from './json.ts'
const operations = new Set([
  'admission',
  'capture',
  'dispatch',
  'connect',
  'recover',
  'renew',
  'anchor',
  'project',
  'shutdown',
])
const outcomes = new Set(['accepted', 'refused', 'succeeded', 'failed', 'blocked', 'unclean'])
const classes = new Set(['database', 'transport', 'validation', 'deadline', 'conflict', 'unknown'])
const identifiers = ['actor', 'workstream', 'session', 'execution', 'connection', 'command'] as const
export function telemetry(input: Record<string, unknown>, sink: (line: string) => void): void {
  const line: Record<string, unknown> = {}
  for (const key of identifiers) if (typeof input[key] === 'string' && UUID.test(input[key])) line[key] = input[key]
  if (typeof input.position === 'string') {
    try {
      cursor(input.position)
      line.position = input.position
    } catch {
      /* Untrusted fields are dropped. */
    }
  }
  for (const [key, allowed] of [
    ['operation', operations],
    ['outcome', outcomes],
    ['errorClass', classes],
  ] as const)
    if (typeof input[key] === 'string' && allowed.has(input[key])) line[key] = input[key]
  for (const key of ['bytes', 'durationMs'])
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0) line[key] = input[key]
  try {
    sink(JSON.stringify(line))
  } catch {
    /* Operational logging cannot change acceptance. */
  }
}

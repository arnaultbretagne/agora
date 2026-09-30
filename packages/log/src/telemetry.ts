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
const stages = new Set([
  'command_queue', 'command_commit', 'command_drive', 'command_return', 'command_to_write',
  'credential_provider', 'credentials', 'connect_handshake', 'claim_read', 'claim_renew',
  'dispatch_marker', 'dispatch_write', 'dispatch_commit',
  'capture_queue', 'capture_commit', 'receive_to_commit', 'receive_queue',
  'receive_state', 'receive_drive', 'receive_to_projection', 'projection_commit',
])
const identifiers = ['actor', 'workstream', 'session', 'execution', 'connection', 'command'] as const
export function telemetry(input: Record<string, unknown>, sink: (line: string) => void): void {
  const line: Record<string, unknown> = {}
  for (const key of identifiers) if (typeof input[key] === 'string' && UUID.test(input[key])) line[key] = input[key]
  for (const key of ['position', 'requestPosition', 'receiveOrdinal', 'threadPosition']) {
    if (typeof input[key] === 'string') {
      try {
        cursor(input[key])
        line[key] = input[key]
      } catch {
        /* Untrusted fields are dropped. */
      }
    }
  }
  for (const [key, allowed] of [
    ['operation', operations],
    ['outcome', outcomes],
    ['errorClass', classes],
    ['stage', stages],
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

/** Time promise completion with a monotonic clock, including pool/queue waits inside the call. */
export async function measured<T>(
  fields: Record<string, unknown>,
  run: () => Promise<T>,
  sink: (line: string) => void,
): Promise<T> {
  const started = performance.now()
  let outcome = 'failed'
  try {
    const result = await run()
    outcome = 'succeeded'
    return result
  } finally {
    telemetry({ ...fields, outcome, durationMs: performance.now() - started }, sink)
  }
}

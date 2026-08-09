import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

/**
 * `agents/codex/SPIKE.md` "Required native resume files/state are identified and bounded": the
 * ONLY file that matters for `session/resume` continuity is one rollout transcript under
 * `$HOME/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<sessionId>.jsonl` — proven minimal
 * live (resume succeeded from a bare `HOME` containing ONLY this file, no sqlite state/cache).
 * Everything else under `$HOME/.codex` (`*.sqlite` state/memories/goals/logs, `cache/`, `skills/`,
 * `models_cache.json`) is GLOBAL installation state, not Session-specific.
 *
 * Unlike Claude Code, this path is NOT deterministic from `sessionId` alone (date-partitioned, the
 * filename embeds the file's own creation timestamp) — so capture must locate it, and, critically,
 * **restore must reproduce its exact original relative path**: verified live that `session/resume`
 * fails ("Internal error") if the same file is moved to a different date directory or given a
 * different embedded timestamp, even keeping the same `sessionId` in the new filename. So this
 * driver's own wire format is a small self-describing envelope — `{relativePath, contentBase64}` —
 * rather than Claude's simpler "the raw bytes ARE the transcript" (docs/specs/07 "only the
 * Session's custody driver may interpret payload bytes" covers exactly this kind of driver-specific
 * choice).
 */
export const CODEX_NATIVE_FORMAT_ID = 'codex-transcript-v1'
export const CODEX_NATIVE_FORMAT_VERSION = '1'
const SESSIONS_ROOT = '.codex/sessions'
const ROLLOUT_SUFFIX = '.jsonl'
const SESSION_ID_SCAN_LINE_LIMIT = 20
/** Bounds the recursive directory walk below — `sessions/<yyyy>/<mm>/<dd>/` is 3 levels deep in
 * every version observed; a small margin over that catches a harmless layout tweak without ever
 * silently traversing something unbounded. */
const MAX_WALK_DEPTH = 6

export class CustodyCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyCaptureError'
  }
}

export class CustodyRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyRestoreError'
  }
}

export interface CapturedNativeState {
  readonly bytes: Uint8Array
  readonly sha256: string
}

interface Envelope {
  readonly relativePath: string
  readonly contentBase64: string
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).relativePath === 'string' &&
    typeof (value as Record<string, unknown>).contentBase64 === 'string'
  )
}

/** Refuses any relative path escaping `.codex/sessions/` — same defensive intent as
 * `restoreCollision: 'fail-if-present'` below: opaque bytes are still bytes someone else wrote. */
function assertSafeRelativePath(relativePath: string): void {
  if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new CustodyRestoreError(`unsafe relative path in custody envelope: ${relativePath}`)
  }
  if (!relativePath.startsWith(`${SESSIONS_ROOT}/`)) {
    throw new CustodyRestoreError(`custody envelope path is not under ${SESSIONS_ROOT}/: ${relativePath}`)
  }
}

/** Recursively finds the one rollout file whose name ends in `-<sessionId>.jsonl` under
 * `$homeDir/.codex/sessions/`. Bounded by `MAX_WALK_DEPTH`, not by an assumed exact 3-level
 * year/month/day shape — resilient to a harmless layout tweak, not to malicious depth. */
async function findRolloutFile(homeDir: string, sessionId: string): Promise<string | undefined> {
  const root = join(homeDir, SESSIONS_ROOT)
  const suffix = `-${sessionId}${ROLLOUT_SUFFIX}`

  async function walk(dir: string, depth: number): Promise<string | undefined> {
    if (depth > MAX_WALK_DEPTH) return undefined
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(full, depth + 1)
        if (found) return found
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return full
      }
    }
    return undefined
  }

  return walk(root, 0)
}

/**
 * docs/specs/07 "Capture MUST operate on a quiescent... state": the controller only calls this
 * between turns (never mid-stream), matching the same orchestration point P06's fake-agent driver
 * and `agents/claude-code`'s own driver already use — this module has no turn-awareness of its own.
 */
export async function captureNativeState(homeDir: string, sessionId: string): Promise<CapturedNativeState> {
  const absolutePath = await findRolloutFile(homeDir, sessionId)
  if (!absolutePath) {
    throw new CustodyCaptureError(`no native rollout file found for sessionId ${sessionId} under ${join(homeDir, SESSIONS_ROOT)}`)
  }
  let content: Uint8Array
  try {
    content = await readFile(absolutePath)
  } catch (error) {
    throw new CustodyCaptureError(`failed to read native rollout file at ${absolutePath}: ${String(error)}`)
  }
  const relativePath = relative(homeDir, absolutePath)
  const envelope: Envelope = { relativePath, contentBase64: Buffer.from(content).toString('base64') }
  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Every real Codex rollout file's first line is a `session_meta` event carrying its own
 * `payload.session_id` (verified live) — this is the driver reading its own opaque format's
 * structure, not product code parsing custody. */
export function sessionIdFromTranscriptBytes(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes)
  const lines = text.split('\n').slice(0, SESSION_ID_SCAN_LINE_LIMIT)
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as { payload?: { session_id?: unknown } }
      const sessionId = parsed.payload?.session_id
      if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
    } catch {
      // not a JSON line — keep scanning
    }
  }
  throw new CustodyRestoreError(`no payload.session_id field found in the first ${SESSION_ID_SCAN_LINE_LIMIT} rollout lines`)
}

/** Decodes this driver's own envelope and extracts the sessionId from the wrapped rollout content —
 * used by the bridge server the same way `agents/claude-code`'s equivalent is: to know which
 * sessionId a restore-before-ready stream is for, before any WS connection exists. */
export function sessionIdFromEnvelopeBytes(envelopeBytes: Uint8Array): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(new TextDecoder().decode(envelopeBytes))
  } catch (error) {
    throw new CustodyRestoreError(`custody payload is not a valid ${CODEX_NATIVE_FORMAT_ID} envelope: ${String(error)}`)
  }
  if (!isEnvelope(envelope)) {
    throw new CustodyRestoreError(`custody payload is missing relativePath/contentBase64`)
  }
  return sessionIdFromTranscriptBytes(Buffer.from(envelope.contentBase64, 'base64'))
}

/**
 * docs/specs/07 "Restore contract" step 6: "prevents overwrite of unexpected pre-existing native
 * state" — a freshly materialized Pod's sessions directory never has this file yet; refuses rather
 * than silently overwriting if it somehow does (matches the registry's own
 * `restoreCollision: 'fail-if-present'`). Writes the rollout file back at its EXACT original
 * relative path (see module doc comment for why that's required, not optional). Returns the
 * sessionId it restored under, so the caller (`bridge-server.ts`) can serve `/custody` correctly
 * even before any WebSocket connection exists.
 */
export async function restoreNativeState(homeDir: string, envelopeBytes: Uint8Array): Promise<{ sessionId: string }> {
  let envelope: unknown
  try {
    envelope = JSON.parse(new TextDecoder().decode(envelopeBytes))
  } catch (error) {
    throw new CustodyRestoreError(`custody payload is not a valid ${CODEX_NATIVE_FORMAT_ID} envelope: ${String(error)}`)
  }
  if (!isEnvelope(envelope)) {
    throw new CustodyRestoreError(`custody payload is missing relativePath/contentBase64`)
  }
  assertSafeRelativePath(envelope.relativePath)
  const content = Buffer.from(envelope.contentBase64, 'base64')
  const sessionId = sessionIdFromTranscriptBytes(content)

  const absolutePath = join(homeDir, envelope.relativePath)
  const alreadyExists = await stat(absolutePath).then(
    () => true,
    () => false,
  )
  if (alreadyExists) {
    throw new CustodyRestoreError(`refusing to restore over existing native state at ${absolutePath}`)
  }
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, { flag: 'wx' })
  return { sessionId }
}

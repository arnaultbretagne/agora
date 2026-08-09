import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * `agents/claude-code/SPIKE.md` "Native state required for resume is identified without relying
 * on product parsing": the ONLY file that matters for `session/resume` continuity is
 * `$HOME/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. Everything else under `$HOME/.claude`
 * (`.claude.json`, `policy-limits.json`, `remote-settings.json`, `backups/`) is GLOBAL installation
 * state, not Session-specific — capturing it would leak one Session's harness identity/trust state
 * into another's restore, so this module never touches it.
 *
 * The project-directory slug is Claude Code's own derivation from the working directory
 * (`/` -> `-`), verified live in the spike. `AGORA_WORKSPACE_ROOT` (`pod-spec.ts`) is a FIXED,
 * platform-wide constant (`/home/node/work`), never Session-specific, so the slug is fixed too —
 * this driver hardcodes it rather than reimplementing Claude Code's own slug algorithm generically,
 * matching docs/specs/09 "the driver may know native harness layout; product code may not".
 *
 * docs/specs/07 "Only the Session's custody driver may interpret payload bytes" — the ONE thing
 * this driver needs beyond opaque bytes is WHICH sessionId to restore as. `custody.snapshots` has
 * no such metadata column (correctly: the fake-agent driver P06 built never needed one, since its
 * native state has no on-disk path of its own). Rather than extending that shared, already-shipped
 * schema for a single driver's need, this driver reads its OWN sessionId back out of the opaque
 * bytes it wrote in the first place — real Claude Code transcript lines already carry a
 * `sessionId` field on every record (verified live in the spike) — matching the spec's own
 * allowance that the driver, and only the driver, may interpret its own payload's structure.
 */
export const CLAUDE_NATIVE_FORMAT_ID = 'claude-code-transcript-v1'
export const CLAUDE_NATIVE_FORMAT_VERSION = '1'
const PROJECT_SLUG = '-home-node-work'
const SESSION_ID_SCAN_LINE_LIMIT = 20

export function nativeTranscriptPath(homeDir: string, sessionId: string): string {
  return `${homeDir}/.claude/projects/${PROJECT_SLUG}/${sessionId}.jsonl`
}

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

/**
 * docs/specs/07 "Capture MUST operate on a quiescent... state": the controller only calls this
 * between turns (never mid-stream), matching the same orchestration point P06's fake-agent driver
 * already uses — this module has no turn-awareness of its own, by design (that belongs to the
 * controller's capture-request timing, not the driver).
 */
export async function captureNativeState(homeDir: string, sessionId: string): Promise<CapturedNativeState> {
  const path = nativeTranscriptPath(homeDir, sessionId)
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new CustodyCaptureError(`no native transcript at ${path} to capture: ${String(error)}`)
  }
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Every real Claude Code transcript line carries its own `sessionId` field (verified live) — this
 * is the driver reading its own opaque format's structure, not product code parsing custody. */
export function sessionIdFromTranscriptBytes(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes)
  const lines = text.split('\n').slice(0, SESSION_ID_SCAN_LINE_LIMIT)
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as { sessionId?: unknown }
      if (typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) return parsed.sessionId
    } catch {
      // not a JSON line — keep scanning
    }
  }
  throw new CustodyRestoreError(`no sessionId field found in the first ${SESSION_ID_SCAN_LINE_LIMIT} transcript lines`)
}

/**
 * docs/specs/07 "Restore contract" step 6: "prevents overwrite of unexpected pre-existing native
 * state" — a freshly materialized Pod's transcript directory never has this file yet; refuses
 * rather than silently overwriting if it somehow does (matches the registry's own
 * `restoreCollision: 'fail-if-present'`). Returns the sessionId it restored under, so the caller
 * (`bridge-server.ts`) can serve `/custody` correctly even before any WebSocket connection exists.
 */
export async function restoreNativeState(homeDir: string, bytes: Uint8Array): Promise<{ sessionId: string }> {
  const sessionId = sessionIdFromTranscriptBytes(bytes)
  const path = nativeTranscriptPath(homeDir, sessionId)
  const alreadyExists = await stat(path).then(
    () => true,
    () => false,
  )
  if (alreadyExists) {
    throw new CustodyRestoreError(`refusing to restore over existing native state at ${path}`)
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes, { flag: 'wx' })
  return { sessionId }
}

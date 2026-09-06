// The codex custody driver (S10 Step 1 — continuity.md, P12 for codex).
//
// What it captures is one file: the adapter's own rollout JSONL, under
// `<HOME>/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<contextId>.jsonl`. The context id is
// in the FILENAME, which is what makes a single context's state addressable at all here — measured,
// and confirmed by a round trip: that one file, copied into a home that had never seen the context,
// is enough for `session/resume` to bring the conversation back (harnesses/codex/README.md).
//
// Everything else under `.codex` is excluded, and unlike claude-code that exclusion is doing heavy
// lifting rather than tidying. The current CLI keeps its state in installation-wide SQLite databases
// — `state_*.sqlite`, `logs_*.sqlite`, `goals_*.sqlite`, `memories_*.sqlite`, `queue_*.sqlite`,
// `thread_history_*.sqlite` — plus `session_index.jsonl`, `auth.json` and a model cache. None of
// those are per-context: capturing any of them would carry every OTHER conversation in that
// installation, and the credential, into somebody else's restore.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CapturedSave, CustodyDriver, OpeningDescriptor, OpeningProof, QuiescentCut, RestorePlacement } from '@agora/custody'

export const FORMAT_ID = 'codex-rollout'
export const FORMAT_VERSION = 1
export const DRIVER_REVISION = 'codex-rollout-1'

/** Same first values as the claude-code driver: one conversation's transcript, one shutdown budget. */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
export const CAPTURE_TIMEOUT_MS = 10_000
export const RESTORE_TIMEOUT_MS = 30_000

export class CustodyRefusedError extends Error {
  constructor(
    readonly code: 'capture_refused' | 'restore_refused',
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`)
    this.name = 'CustodyRefusedError'
  }
}

export interface CodexDriverOptions {
  /** The adapter's `HOME`, under which it keeps `.codex/`. */
  readonly harnessHome: string
  /** Declared for symmetry with the other drivers; codex's rollout path does not encode it. */
  readonly workspaceRoot: string
  readonly now?: () => number
  readonly stabilityWindowMs?: number
  readonly captureTimeoutMs?: number
}

interface RolloutFile {
  readonly path: string
  /** Path relative to `<HOME>/.codex`, which is what a restore has to reproduce exactly. */
  readonly relative: string
}

/** Every rollout file under a codex home, in path order. */
export async function rolloutFiles(harnessHome: string): Promise<readonly RolloutFile[]> {
  const base = join(harnessHome, '.codex', 'sessions')
  const found: RolloutFile[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.jsonl')) found.push({ path, relative: path.slice(join(harnessHome, '.codex').length + 1) })
    }
  }
  await walk(base)
  return found
}

/**
 * The rollout file for one context. Located by the context id in the FILENAME rather than by parsing
 * every file: the name is the index codex itself maintains, and reading each candidate's first line
 * to find one would mean opening other conversations to answer a question about this one.
 */
export async function rolloutFor(harnessHome: string, contextId: string): Promise<RolloutFile | null> {
  const files = await rolloutFiles(harnessHome)
  return files.find((file) => file.path.includes(contextId)) ?? null
}

function checksumOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

interface RolloutLine {
  readonly type?: unknown
  readonly payload?: { readonly session_id?: unknown; readonly content?: unknown; readonly role?: unknown; readonly [key: string]: unknown }
}

function parseRollout(bytes: Uint8Array): readonly RolloutLine[] {
  const lines: RolloutLine[] = []
  for (const line of new TextDecoder().decode(bytes).split('\n')) {
    if (line.trim().length === 0) continue
    try {
      lines.push(JSON.parse(line) as RolloutLine)
    } catch {
      // Unparseable lines carry no evidence and are not a reason to reject the payload, which stays
      // opaque and byte-exact. Only proof is affected.
    }
  }
  return lines
}

/** The context id the payload itself claims, from its `session_meta` line (measured). */
export function contextIdFromPayload(bytes: Uint8Array): string {
  for (const line of parseRollout(bytes)) {
    const id = line.payload?.session_id
    if (line.type === 'session_meta' && typeof id === 'string' && id.length > 0) return id
  }
  throw new CustodyRefusedError('restore_refused', 'the payload has no session_meta line, so it is not a codex rollout')
}

export class CodexCustodyDriver implements CustodyDriver {
  readonly harnessId = 'codex'
  readonly driverRevision = DRIVER_REVISION
  readonly formatId = FORMAT_ID
  readonly formatVersion = FORMAT_VERSION

  /** Where the last capture found its file, so a restore can put it back at the same relative path. */
  #lastRelative: string | null = null

  constructor(private readonly options: CodexDriverOptions) {}

  /**
   * Captures the one rollout file at a quiescent cut. Like claude-code's, this waits for the file to
   * settle rather than refusing the first time two reads disagree — a process that has just been
   * killed is not the same as a file that has finished being written.
   */
  async capture(cut: QuiescentCut): Promise<CapturedSave> {
    const now = this.options.now ?? (() => Date.now())
    const budgetMs = this.options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS
    const windowMs = this.options.stabilityWindowMs ?? 250
    const startedAt = now()

    const file = await rolloutFor(this.options.harnessHome, cut.contextId)
    if (file === null) throw new CustodyRefusedError('capture_refused', `no rollout file for context ${cut.contextId}`)
    this.#lastRelative = file.relative

    let previous = new Uint8Array(await readFile(file.path))
    for (;;) {
      if (previous.byteLength > MAX_PAYLOAD_BYTES) {
        throw new CustodyRefusedError('capture_refused', `the rollout is ${String(previous.byteLength)} bytes, over the ${String(MAX_PAYLOAD_BYTES)} byte limit`)
      }
      await new Promise((resolve) => setTimeout(resolve, windowMs))
      const current = new Uint8Array(await readFile(file.path))
      if (current.byteLength === previous.byteLength && checksumOf(current) === checksumOf(previous)) {
        previous = current
        break
      }
      previous = current
      if (now() - startedAt > budgetMs) {
        throw new CustodyRefusedError('capture_refused', `the rollout was still changing after ${String(budgetMs)}ms, so no quiescent cut was reached`)
      }
    }

    return {
      bytes: previous,
      checksum: checksumOf(previous),
      formatId: FORMAT_ID,
      formatVersion: FORMAT_VERSION,
      // The conservative floor, exactly as for claude-code: what this driver can prove from the
      // rollout alone is delivery of a Handoff digest, and no digest exists until one is rendered.
      frontierW: 0,
      nativeOrigin: { podUid: cut.podUid, processGeneration: cut.processGeneration, contextId: cut.contextId, relativePath: file.relative },
      // The conversation, not the workspace.
      workspaceDeps: {},
    }
  }

  /**
   * Places the rollout back under the context id the payload claims. The date-partitioned directory
   * is reconstructed from the payload's own `session_meta` timestamp — codex finds the file by
   * scanning `sessions/`, so what matters is that the file exists under that tree with the context
   * id in its name; the exact date directory is cosmetic, and using the payload's own timestamp
   * keeps a restored home looking like the one it came from.
   */
  async restore(bytes: Uint8Array): Promise<RestorePlacement> {
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
      throw new CustodyRefusedError('restore_refused', `the payload is ${String(bytes.byteLength)} bytes, over the ${String(MAX_PAYLOAD_BYTES)} byte limit`)
    }
    const contextId = contextIdFromPayload(bytes)
    const path = join(this.options.harnessHome, '.codex', this.#lastRelative ?? relativePathFor(bytes, contextId))
    const staging = `${path}.partial`
    const checksum = checksumOf(bytes)

    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(staging, bytes)
      const written = new Uint8Array(await readFile(staging))
      if (checksumOf(written) !== checksum) throw new CustodyRefusedError('restore_refused', 'the placed bytes do not match the payload checksum')
      await rename(staging, path)
    } catch (error) {
      await rm(staging, { force: true })
      throw error
    }
    const placed = await stat(path)
    return { path, byteLength: placed.size, checksum }
  }

  /**
   * Whether the context provably incorporated the opening range. Same rule as every other driver:
   * an empty range is vacuous; a non-empty one is proven by the Handoff digest appearing as a
   * received user message; anything else is `unprovable`, never `not_incorporated`.
   */
  async proveOpening(descriptor: OpeningDescriptor): Promise<OpeningProof> {
    if (descriptor.w === descriptor.h) {
      return { kind: 'incorporated', evidence: { range: 'empty', w: descriptor.w, contextId: descriptor.contextId } }
    }
    if (descriptor.handoffDigest === undefined) {
      return { kind: 'unprovable', reason: 'a non-empty opening range is proven by its Handoff digest, and the descriptor carries none' }
    }
    const file = await rolloutFor(this.options.harnessHome, descriptor.contextId)
    if (file === null) return { kind: 'unprovable', reason: `no rollout file for context ${descriptor.contextId}` }

    let lines: readonly RolloutLine[]
    try {
      lines = parseRollout(new Uint8Array(await readFile(file.path)))
    } catch (error) {
      return { kind: 'unprovable', reason: `the rollout is unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
    const digest = descriptor.handoffDigest
    const delivered = lines.some((line) => JSON.stringify(line.payload ?? null).includes(digest))
    return delivered
      ? { kind: 'incorporated', evidence: { handoffDigest: digest, w: descriptor.w, h: descriptor.h, contextId: descriptor.contextId } }
      : {
          kind: 'unprovable',
          reason: 'the Handoff digest is absent from the rollout, which is not evidence it was never delivered — compaction removes exactly this record (CONT-006)',
        }
  }
}

/** `sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<contextId>.jsonl`, from the payload's own meta line. */
function relativePathFor(bytes: Uint8Array, contextId: string): string {
  const meta = parseRollout(bytes).find((line) => line.type === 'session_meta')
  const stamp = typeof meta?.payload?.['timestamp'] === 'string' ? (meta.payload['timestamp'] as string) : new Date(0).toISOString()
  const date = new Date(stamp)
  const iso = Number.isNaN(date.getTime()) ? new Date(0) : date
  const yyyy = String(iso.getUTCFullYear())
  const mm = String(iso.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(iso.getUTCDate()).padStart(2, '0')
  const name = `rollout-${iso.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${contextId}.jsonl`
  return join('sessions', yyyy, mm, dd, name)
}

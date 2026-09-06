// The claude-code custody driver (S9 Step 2 — continuity.md, "Registered driver: `claude-code`").
// It lives in the harness's own workspace because only the harness knows what its native state is;
// core moves the bytes it produces and never interprets them.
//
// What it captures is exactly one file — the adapter's own JSONL transcript for the context — at the
// path measured against the pinned adapter, not guessed:
// `<HOME>/.claude/projects/<workspace root slug>/<contextId>.jsonl` (see workspaceSlug).
// Everything else under that home is excluded, credentials first: `.claude/.credentials.json`,
// `.claude.json`, `policy-limits.json`, `remote-settings.json`, `backups/` are installation-wide,
// and capturing them would carry one execution's harness identity into another's restore.
//
// `@agora/custody` is imported for TYPES only (a harness may depend on packages/*, ADR 0001): the
// import is erased at build time, so the image never loads it or its `pg` dependency, while the
// compiler still checks this class against the contract core actually calls.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CapturedSave, CustodyDriver, OpeningDescriptor, OpeningProof, QuiescentCut, RestorePlacement } from '@agora/custody'

export const FORMAT_ID = 'claude-code-transcript'
export const FORMAT_VERSION = 1
/**
 * Bumped whenever capture, restore or proof semantics change, so an invalidation can exclude the
 * exact (Save, driver revision) pair without excluding Saves a corrected revision can still read
 * (CONT-008).
 */
export const DRIVER_REVISION = 'claude-code-transcript-1'

/** continuity.md's first values. A limit refuses the capture; it never silently extends the budget. */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
export const CAPTURE_TIMEOUT_MS = 10_000
export const RESTORE_TIMEOUT_MS = 30_000

/** Placement of a payload the driver refuses to treat as a transcript. Never thrown for an outage. */
export class CustodyRefusedError extends Error {
  constructor(
    readonly code: 'capture_refused' | 'restore_refused',
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`)
    this.name = 'CustodyRefusedError'
  }
}

export interface ClaudeCodeDriverOptions {
  /** The adapter's `HOME`, under which it keeps `.claude/` — configuration, never a request-supplied path. */
  readonly harnessHome: string
  /** The fixed workspace root the adapter was launched with; the slug is derived from it. */
  readonly workspaceRoot: string
  /** Test seam: the clock the capture deadline is measured against. */
  readonly now?: () => number
  /**
   * The gap between two stability reads. The default is 250ms because the transcript was measured
   * still changing for roughly 100-200ms after the adapter process was SIGKILLed — the writes are
   * asynchronous, and "the process is gone" is not yet "the file is finished".
   */
  readonly stabilityWindowMs?: number
  /** Test seam: the capture budget, so a test need not wait ten real seconds to see it expire. */
  readonly captureTimeoutMs?: number
}

/**
 * The adapter's own directory slug for a workspace root, measured against the pinned adapter rather
 * than assumed: every character outside `[A-Za-z0-9-]` becomes `-`, and case is preserved.
 * `/home/agent/work` gives `-home-agent-work`; `/a/A_b.c-d 1` gives `-a-A-b-c-d-1`. Reading this as
 * "slashes become dashes" is what the first version did, and it looked in the wrong directory the
 * moment a path contained a dot — which every path under a `.claude` home does.
 */
export function workspaceSlug(workspaceRoot: string): string {
  return workspaceRoot.replace(/[^A-Za-z0-9-]/g, '-')
}

export function transcriptPath(options: { harnessHome: string; workspaceRoot: string; contextId: string }): string {
  return join(options.harnessHome, '.claude', 'projects', workspaceSlug(options.workspaceRoot), `${options.contextId}.jsonl`)
}

interface TranscriptLine {
  readonly type?: unknown
  readonly sessionId?: unknown
  readonly message?: { readonly content?: unknown }
}

function parseTranscript(bytes: Uint8Array): readonly TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const line of new TextDecoder().decode(bytes).split('\n')) {
    if (line.trim().length === 0) continue
    try {
      lines.push(JSON.parse(line) as TranscriptLine)
    } catch {
      // A line the driver cannot parse carries no evidence, and is not a reason to reject the
      // payload either: the bytes stay opaque and byte-exact. Only proof is affected.
    }
  }
  return lines
}

function checksumOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * The context id every line of the transcript agrees on (findings §2.2: "every transcript line
 * carries the `sessionId`"). Restore takes it from the payload rather than from a caller-supplied
 * value, so bytes can never be placed under a name they do not claim.
 */
export function contextIdFromPayload(bytes: Uint8Array): string {
  const ids = new Set<string>()
  for (const line of parseTranscript(bytes)) {
    if (typeof line.sessionId === 'string' && line.sessionId.length > 0) ids.add(line.sessionId)
  }
  if (ids.size === 0) throw new CustodyRefusedError('restore_refused', 'the payload carries no sessionId, so it is not a claude-code transcript')
  if (ids.size > 1) {
    throw new CustodyRefusedError('restore_refused', `the payload mixes ${String(ids.size)} context ids, so it is not one context's transcript`)
  }
  return [...ids][0]!
}

export class ClaudeCodeCustodyDriver implements CustodyDriver {
  readonly harnessId = 'claude-code'
  readonly driverRevision = DRIVER_REVISION
  readonly formatId = FORMAT_ID
  readonly formatVersion = FORMAT_VERSION

  constructor(private readonly options: ClaudeCodeDriverOptions) {}

  /**
   * Captures the one transcript at a quiescent cut. Three of continuity.md's four conditions are the
   * control plane's own knowledge (admission closed, no turn in flight and none acceptable, process
   * alive at the keyed generation) and are asserted by passing the cut; the fourth is this driver's
   * to check — the file must be unchanged across two consecutive reads, because a transcript read
   * while a turn is being written is a truncated stream and a truncated stream does not resume.
   */
  async capture(cut: QuiescentCut): Promise<CapturedSave> {
    const now = this.options.now ?? (() => Date.now())
    const budgetMs = this.options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS
    const windowMs = this.options.stabilityWindowMs ?? 250
    const startedAt = now()
    const path = this.pathFor(cut.contextId)

    let previous: Uint8Array
    try {
      previous = new Uint8Array(await readFile(path))
    } catch (error) {
      throw new CustodyRefusedError('capture_refused', `no transcript for context ${cut.contextId}: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Waits for the file to settle rather than refusing the first time it has not: the transcript
    // was measured still growing for ~100-200ms after the process was killed, so a single
    // disagreement means "not yet", not "never". The budget is what turns "not yet" into a refusal.
    for (;;) {
      if (previous.byteLength > MAX_PAYLOAD_BYTES) {
        throw new CustodyRefusedError('capture_refused', `the transcript is ${String(previous.byteLength)} bytes, over the ${String(MAX_PAYLOAD_BYTES)} byte limit`)
      }
      await new Promise((resolve) => setTimeout(resolve, windowMs))
      const current = new Uint8Array(await readFile(path))
      if (current.byteLength === previous.byteLength && checksumOf(current) === checksumOf(previous)) {
        previous = current
        break
      }
      previous = current
      if (now() - startedAt > budgetMs) {
        throw new CustodyRefusedError(
          'capture_refused',
          `the transcript was still changing after ${String(budgetMs)}ms, so no quiescent cut was reached`,
        )
      }
    }

    const second = previous
    const checksum = checksumOf(second)
    if (now() - startedAt > budgetMs) {
      throw new CustodyRefusedError('capture_refused', `capture exceeded its ${String(budgetMs)}ms budget`)
    }

    return {
      bytes: second,
      checksum,
      formatId: FORMAT_ID,
      formatVersion: FORMAT_VERSION,
      // Deliberately the conservative floor, never the journal head (CONT-009). What this driver can
      // prove from the transcript is delivery of a Handoff digest, and no digest exists to look for
      // until the renderer does (S9 Step 5); a capture whose opening range was empty proves W = 0
      // because nothing was pending, and anything else is claimed by proveOpening, not here.
      frontierW: 0,
      nativeOrigin: { podUid: cut.podUid, processGeneration: cut.processGeneration, contextId: cut.contextId },
      // The transcript is the conversation, not the workspace (continuity.md): this driver declares
      // no workspace dependency rather than implying the bundle reconstructs one. A Save that named
      // one it could not version would be refused at restore by checkCompatibility (CONT-011).
      workspaceDeps: {},
    }
  }

  /**
   * Places the bytes where the adapter will look for them, under the context id the payload itself
   * claims. Placement is atomic from the adapter's point of view: the bytes land on a staging path
   * in the same directory and are renamed only after they read back byte-identical, so a partially
   * written file is never visible as a transcript, and a crashed placement leaves nothing but its
   * own staging file — which the next attempt for the same context overwrites and cleans, never
   * touching unrelated state.
   */
  async restore(bytes: Uint8Array): Promise<RestorePlacement> {
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
      throw new CustodyRefusedError('restore_refused', `the payload is ${String(bytes.byteLength)} bytes, over the ${String(MAX_PAYLOAD_BYTES)} byte limit`)
    }
    const contextId = contextIdFromPayload(bytes)
    const path = this.pathFor(contextId)
    const staging = `${path}.partial`
    const checksum = checksumOf(bytes)

    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(staging, bytes)
      const written = new Uint8Array(await readFile(staging))
      if (checksumOf(written) !== checksum) {
        throw new CustodyRefusedError('restore_refused', 'the placed bytes do not match the payload checksum')
      }
      await rename(staging, path)
    } catch (error) {
      await rm(staging, { force: true })
      throw error
    }

    const placed = await stat(path)
    return { path, byteLength: placed.size, checksum }
  }

  /**
   * Whether the native context provably incorporated the opening range. An empty range is vacuously
   * incorporated. A non-empty one needs the rendered Handoff's digest to appear in the transcript as
   * a received user message. Anything else is `unprovable` — which is not `not_incorporated`, never
   * authorises a resend, and in particular is what an absent digest means after native compaction
   * has removed exactly this evidence (CONT-006).
   */
  async proveOpening(descriptor: OpeningDescriptor): Promise<OpeningProof> {
    if (descriptor.w === descriptor.h) {
      return { kind: 'incorporated', evidence: { range: 'empty', w: descriptor.w, contextId: descriptor.contextId } }
    }
    if (descriptor.handoffDigest === undefined) {
      return { kind: 'unprovable', reason: 'a non-empty opening range is proven by its Handoff digest, and the descriptor carries none' }
    }

    let lines: readonly TranscriptLine[]
    try {
      lines = parseTranscript(new Uint8Array(await readFile(this.pathFor(descriptor.contextId))))
    } catch (error) {
      return { kind: 'unprovable', reason: `the transcript is unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }

    const digest = descriptor.handoffDigest
    const delivered = lines.some((line) => line.type === 'user' && JSON.stringify(line.message?.content ?? null).includes(digest))
    return delivered
      ? { kind: 'incorporated', evidence: { handoffDigest: digest, w: descriptor.w, h: descriptor.h, contextId: descriptor.contextId } }
      : {
          kind: 'unprovable',
          reason: 'the Handoff digest is absent from the transcript, which is not evidence it was never delivered — native compaction removes exactly this record (CONT-006)',
        }
  }

  private pathFor(contextId: string): string {
    return transcriptPath({ harnessHome: this.options.harnessHome, workspaceRoot: this.options.workspaceRoot, contextId })
  }
}

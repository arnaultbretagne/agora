// Anchor drivers (sandbox-image.md, "L'anchor"). Carried over from the S9 custody driver of the
// previous implementation — arnaultbretagne/agora main, harnesses/claude-code/src/driver.ts — and
// kept to what that work measured: ONE native transcript file per session, captured byte-exact once
// it is stable, restored atomically under the session id the payload itself claims. Only the path
// differs between harnesses; the layout is the one thing each harness supplies.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const MAX_ANCHOR_BYTES = 32 * 1024 * 1024
export const CAPTURE_BUDGET_MS = 10_000
export const STABILITY_WINDOW_MS = 250

export interface TranscriptLayout {
  readonly format: string
  pathFor(sessionId: string): string
}

/**
 * claude-code's own directory slug for a working directory, measured against the pinned adapter:
 * every character outside `[A-Za-z0-9-]` becomes `-`, case preserved. Reading it as "slashes become
 * dashes" looked in the wrong directory the moment a path contained a dot (S9 findings).
 */
export function workspaceSlug(workspace: string): string {
  return workspace.replace(/[^A-Za-z0-9-]/g, '-')
}

export function claudeCodeLayout(home: string, workspace: string): TranscriptLayout {
  return {
    format: 'claude-code-transcript/1',
    pathFor: (sessionId) => join(home, '.claude', 'projects', workspaceSlug(workspace), `${sessionId}.jsonl`),
  }
}

export function mockLayout(home: string, workspace: string): TranscriptLayout {
  return {
    format: 'mock-agent-transcript/1',
    pathFor: (sessionId) => join(home, '.mock-agent', 'sessions', workspaceSlug(workspace), `${sessionId}.jsonl`),
  }
}

export function layoutFor(driver: string, home: string, workspace: string): TranscriptLayout {
  if (driver === 'claude-code') return claudeCodeLayout(home, workspace)
  if (driver === 'mock') return mockLayout(home, workspace)
  throw new Error(`driver d'anchor inconnu : ${driver}`)
}

/** An answer, not an outage: the caller learns why no anchor exists and carries on with its deletion. */
export class AnchorRefused extends Error {
  readonly status: 404 | 409
  readonly reason: string
  constructor(status: 404 | 409, reason: string) {
    super(reason)
    this.name = 'AnchorRefused'
    this.status = status
    this.reason = reason
  }
}

export function checksumOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** A session id ends up in a path: anything that could climb out of the directory is refused. */
export function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) || sessionId.includes('..')) {
    throw new AnchorRefused(409, `identifiant de session refusé : ${JSON.stringify(sessionId)}`)
  }
}

export interface Capture {
  readonly bytes: Uint8Array
  readonly checksum: string
  readonly sessionId: string
  readonly format: string
}

/**
 * Captures the one transcript once two reads a stability window apart agree: a transcript read while
 * a turn is being written is a truncated stream, and it was measured still growing ~100-200 ms after
 * the adapter was killed. The budget turns "not yet" into a refusal.
 */
export async function captureTranscript(
  layout: TranscriptLayout,
  sessionId: string,
  options: { budgetMs?: number; windowMs?: number } = {},
): Promise<Capture> {
  assertSessionId(sessionId)
  const budgetMs = options.budgetMs ?? CAPTURE_BUDGET_MS
  const windowMs = options.windowMs ?? STABILITY_WINDOW_MS
  const path = layout.pathFor(sessionId)
  const startedAt = Date.now()

  let previous: Uint8Array
  try {
    previous = new Uint8Array(await readFile(path))
  } catch {
    throw new AnchorRefused(404, `aucun fichier natif pour la session ${sessionId} (session encore vide ?)`)
  }
  for (;;) {
    if (previous.byteLength > MAX_ANCHOR_BYTES) {
      throw new AnchorRefused(409, `le fichier fait ${String(previous.byteLength)} octets, au-delà de ${String(MAX_ANCHOR_BYTES)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    const current = new Uint8Array(await readFile(path))
    if (checksumOf(current) === checksumOf(previous)) break
    previous = current
    if (Date.now() - startedAt > budgetMs) {
      throw new AnchorRefused(409, `le fichier bougeait encore après ${String(budgetMs)} ms`)
    }
  }
  return { bytes: previous, checksum: checksumOf(previous), sessionId, format: layout.format }
}

/** Every transcript line carries the session id; restore takes it from the bytes, never from the caller. */
export function sessionIdFromPayload(bytes: Uint8Array): string {
  const ids = new Set<string>()
  for (const line of new TextDecoder().decode(bytes).split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as { sessionId?: unknown }
      if (typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) ids.add(parsed.sessionId)
    } catch {
      // An unparsable line carries no evidence; the bytes stay opaque and byte-exact.
    }
  }
  if (ids.size === 0) throw new AnchorRefused(409, 'le contenu ne porte aucun sessionId')
  if (ids.size > 1) throw new AnchorRefused(409, `le contenu mélange ${String(ids.size)} sessions`)
  const [sessionId] = [...ids]
  assertSessionId(sessionId!)
  return sessionId!
}

export interface Placement {
  readonly path: string
  readonly byteLength: number
  readonly checksum: string
  readonly sessionId: string
}

/** Written beside the target, read back, compared, then renamed: a half-written transcript is never visible. */
export async function restoreTranscript(layout: TranscriptLayout, bytes: Uint8Array): Promise<Placement> {
  if (bytes.byteLength > MAX_ANCHOR_BYTES) {
    throw new AnchorRefused(409, `l'anchor fait ${String(bytes.byteLength)} octets, au-delà de ${String(MAX_ANCHOR_BYTES)}`)
  }
  const sessionId = sessionIdFromPayload(bytes)
  const path = layout.pathFor(sessionId)
  const staging = `${path}.partial`
  const checksum = checksumOf(bytes)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(staging, bytes)
    if (checksumOf(new Uint8Array(await readFile(staging))) !== checksum) {
      throw new AnchorRefused(409, 'les octets écrits ne correspondent pas au checksum')
    }
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
  const placed = await stat(path)
  return { path, byteLength: placed.size, checksum, sessionId }
}

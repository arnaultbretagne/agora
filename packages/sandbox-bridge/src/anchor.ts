// Anchors (docs/backend.md, "La fin du Pod et l'anchor"): the harness's native files, saved en bloc and nothing
// else. What is kept from the S9 custody driver of the previous implementation (arnaultbretagne/agora
// main, harnesses/claude-code/src/driver.ts): the native location and claude-code's slug rule, the
// stability read before a capture, the size limit, and restoration written beside the target, read
// back, compared, then renamed. What changed: the whole native directory instead of one session's
// file, pushed by the Pod when it ends rather than pulled.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

export const ANCHOR_FORMAT = 'agora-anchor/1'
export const MAX_ANCHOR_BYTES = 32 * 1024 * 1024
export const STABILITY_WINDOW_MS = 250
export const STABILITY_BUDGET_MS = 10_000

/**
 * claude-code's own directory slug for a working directory, measured against the pinned adapter:
 * every character outside `[A-Za-z0-9-]` becomes `-`, case preserved (S9 findings).
 */
export function workspaceSlug(workspace: string): string {
  return workspace.replace(/[^A-Za-z0-9-]/g, '-')
}

/** Where each harness keeps its native state for a workspace — the directory saved en bloc. */
export function nativeDir(harness: string, home: string, workspace: string): string {
  if (harness === 'claude-code') return join(home, '.claude', 'projects', workspaceSlug(workspace))
  if (harness === 'mock') return join(home, '.mock-agent', 'sessions', workspaceSlug(workspace))
  throw new Error(`harness sans dossier natif connu : ${harness}`)
}

export interface AnchorFile {
  /** Relative to the native directory. */
  readonly path: string
  readonly checksum: string
  /** base64 */
  readonly content: string
}

export interface Bundle {
  readonly format: string
  readonly harness: string
  readonly files: readonly AnchorFile[]
  /** False when the files still moved at the end of the budget: the last read is sent anyway. */
  readonly stable: boolean
  readonly error?: string
}

export class AnchorRefused extends Error {
  readonly status: number
  constructor(status: number, reason: string) {
    super(reason)
    this.name = 'AnchorRefused'
    this.status = status
  }
}

export function checksumOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)))
    else if (entry.isFile() && !entry.name.endsWith('.partial')) files.push(relative(root, path))
  }
  return files.sort()
}

async function snapshot(root: string): Promise<{ files: Map<string, Buffer>; digest: string; size: number }> {
  const files = new Map<string, Buffer>()
  const hash = createHash('sha256')
  let size = 0
  for (const path of await listFiles(root)) {
    const bytes = await readFile(join(root, path))
    size += bytes.byteLength
    if (size > MAX_ANCHOR_BYTES) throw new AnchorRefused(413, `les fichiers natifs dépassent ${String(MAX_ANCHOR_BYTES)} octets`)
    files.set(path, bytes)
    hash.update(path).update('\0').update(bytes)
  }
  return { files, digest: hash.digest('hex'), size }
}

/** Reads the whole native directory once two reads a window apart agree, within the budget. */
export async function readBundle(harness: string, root: string, options: { windowMs?: number; budgetMs?: number } = {}): Promise<Bundle> {
  const windowMs = options.windowMs ?? STABILITY_WINDOW_MS
  const budgetMs = options.budgetMs ?? STABILITY_BUDGET_MS
  const started = Date.now()
  let previous = await snapshot(root)
  let stable = false
  while (Date.now() - started <= budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    const current = await snapshot(root)
    stable = current.digest === previous.digest
    previous = current
    if (stable) break
  }
  return {
    format: ANCHOR_FORMAT,
    harness,
    stable,
    files: [...previous.files].map(([path, bytes]) => ({ path, checksum: checksumOf(bytes), content: bytes.toString('base64') })),
  }
}

/** A relative path that stays inside the native directory, or a refusal. */
function inside(root: string, path: string): string {
  const clean = normalize(path)
  if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`) || clean.includes(`${sep}..${sep}`)) {
    throw new AnchorRefused(409, `chemin refusé : ${JSON.stringify(path)}`)
  }
  return join(root, clean)
}

export function parseBundle(bytes: Uint8Array): Bundle {
  let bundle: Bundle
  try {
    bundle = JSON.parse(Buffer.from(bytes).toString('utf8')) as Bundle
  } catch {
    throw new AnchorRefused(400, "l'anchor n'est pas du JSON")
  }
  if (bundle.format !== ANCHOR_FORMAT || !Array.isArray(bundle.files)) throw new AnchorRefused(400, `format inconnu : ${String(bundle.format)}`)
  return bundle
}

/** Each file is written beside its target, read back, compared, then renamed. */
export async function writeBundle(root: string, bundle: Bundle): Promise<{ path: string; byteLength: number }[]> {
  const placed: { path: string; byteLength: number }[] = []
  for (const file of bundle.files) {
    const target = inside(root, file.path)
    const bytes = Buffer.from(file.content, 'base64')
    if (checksumOf(bytes) !== file.checksum) throw new AnchorRefused(409, `checksum faux pour ${file.path}`)
    const staging = `${target}.partial`
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(staging, bytes)
      if (checksumOf(new Uint8Array(await readFile(staging))) !== file.checksum) throw new AnchorRefused(409, `relecture fausse pour ${file.path}`)
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { force: true })
      throw error
    }
    placed.push({ path: file.path, byteLength: bytes.byteLength })
  }
  return placed
}

/** The Pod's push (docs/backend.md, "La fin du Pod et l'anchor"): a fresh projected token each attempt. */
export async function pushBundle(url: string, tokenFile: string, bundle: Bundle, options: { attempts?: number; log?: (message: string) => void } = {}): Promise<boolean> {
  const log = options.log ?? (() => {})
  const body = JSON.stringify(bundle)
  for (let attempt = 1; attempt <= (options.attempts ?? 3); attempt++) {
    try {
      const token = (await readFile(tokenFile, 'utf8')).trim()
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      })
      const answer = await response.text()
      if (response.ok) {
        log(`anchor poussé : ${String(bundle.files.length)} fichier(s), ${String(body.length)} octets — ${answer}`)
        return true
      }
      log(`poussée refusée (essai ${String(attempt)}) : ${String(response.status)} ${answer}`)
      if (response.status < 500) return false
    } catch (error) {
      log(`poussée impossible (essai ${String(attempt)}) : ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

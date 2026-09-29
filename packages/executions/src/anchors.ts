// Where Agora keeps anchors (docs/executions.md, "Receiving an anchor"): durable and on Agora's side —
// a volume of the lab, Agora's database later. The bundle the Pod pushed is kept
// byte-exact, next to what Agora knows about it.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface AnchorMeta {
  readonly id: string
  readonly harness: string
  readonly pool: string
  readonly format: string
  /** The session noted on the claim when the Pod ended: the one a restore resumes. */
  readonly sessionId: string | null
  readonly files: readonly { readonly path: string; readonly byteLength: number }[]
  readonly byteLength: number
  readonly stable: boolean
  /** The execution (claim name) whose Pod pushed this anchor. */
  readonly execution: string
  readonly reason: string
  readonly createdAt: string
}

const ID = /^anc-\d{14}-[0-9a-f]{6}$/

export class AnchorStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async save(meta: Omit<AnchorMeta, 'id' | 'createdAt'>, bundle: Uint8Array): Promise<AnchorMeta> {
    await mkdir(this.dir, { recursive: true })
    const now = new Date()
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const full: AnchorMeta = { ...meta, id: `anc-${stamp}-${randomBytes(3).toString('hex')}`, createdAt: now.toISOString() }
    await writeFile(join(this.dir, `${full.id}.bundle.partial`), bundle)
    await rename(join(this.dir, `${full.id}.bundle.partial`), join(this.dir, `${full.id}.bundle`))
    await writeFile(join(this.dir, `${full.id}.json`), JSON.stringify(full, null, 2))
    return full
  }

  async list(): Promise<AnchorMeta[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const metas: AnchorMeta[] = []
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const meta = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as AnchorMeta
      // Anchors pulled by the first version of the lab (one transcript, no file list) are not bundles.
      if (Array.isArray(meta.files)) metas.push(meta)
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async meta(id: string): Promise<AnchorMeta | null> {
    if (!ID.test(id)) return null
    try {
      const meta = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as AnchorMeta
      return Array.isArray(meta.files) ? meta : null
    } catch {
      return null
    }
  }

  async bundle(id: string): Promise<Uint8Array | null> {
    if (!ID.test(id)) return null
    try {
      return new Uint8Array(await readFile(join(this.dir, `${id}.bundle`)))
    } catch {
      return null
    }
  }
}

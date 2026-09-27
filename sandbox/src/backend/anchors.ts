// Where Agora keeps anchors (sandbox-backend.md, "Qui fait quoi ?"): durable and on Agora's side —
// a volume of the back-end in the lab, Agora's database later. One payload file and one metadata
// file per anchor; the payload is stored byte-exact and never read by the back-end.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface AnchorMeta {
  readonly id: string
  readonly harness: string
  readonly pool: string
  readonly format: string
  readonly sessionId: string
  readonly checksum: string
  readonly byteLength: number
  readonly sandbox: string
  readonly reason: string
  readonly createdAt: string
}

const ID = /^anc-\d{14}-[0-9a-f]{6}$/

export class AnchorStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async save(meta: Omit<AnchorMeta, 'id' | 'createdAt'>, bytes: Uint8Array): Promise<AnchorMeta> {
    await mkdir(this.dir, { recursive: true })
    const now = new Date()
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const full: AnchorMeta = { ...meta, id: `anc-${stamp}-${randomBytes(3).toString('hex')}`, createdAt: now.toISOString() }
    await writeFile(join(this.dir, `${full.id}.bin.partial`), bytes)
    await rename(join(this.dir, `${full.id}.bin.partial`), join(this.dir, `${full.id}.bin`))
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
      metas.push(JSON.parse(await readFile(join(this.dir, name), 'utf8')) as AnchorMeta)
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async meta(id: string): Promise<AnchorMeta | null> {
    if (!ID.test(id)) return null
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as AnchorMeta
    } catch {
      return null
    }
  }

  async bytes(id: string): Promise<Uint8Array | null> {
    if (!ID.test(id)) return null
    try {
      return new Uint8Array(await readFile(join(this.dir, `${id}.bin`)))
    } catch {
      return null
    }
  }
}

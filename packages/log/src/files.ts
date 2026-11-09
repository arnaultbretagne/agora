// Files (docs/specs/files.md): a file's bytes are stored once, in R2, under their SHA-256; an entry holds
// a reference where the file was, and lists where. Only Agora writes to the bucket, and it names each
// object from the bytes it hashed itself.
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { isLosslessNumber } from 'lossless-json'
import type { Pool, PoolClient } from 'pg'

/** A string of at least this many characters, in canonical base64, is a file ("A file"). */
export const FILE_MIN = 65_536
const PREFIX = 'agora-file:sha256:'
const REFERENCE = /^agora-file:sha256:([0-9a-f]{64})$/
const DIGEST = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** The files lock ("Storing", "The sweep"): shared while a file is stored and referenced, exclusive for the sweep. */
export const FILES_LOCK = 1_179_208_773
/** An object nothing references is deleted once it is this old ("The sweep"). */
export const SWEEP_AGE_MS = 24 * 3600 * 1000

/** Where an entry holds a reference: its JSON Pointer, the file's SHA-256 and byte count. */
export interface FileRef {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/** The files found in a value: the value with references, where they are, and the bytes by SHA-256. */
export interface Found {
  readonly value: unknown
  readonly refs: FileRef[]
  readonly bytes: Map<string, Buffer>
}

export const reference = (sha256: string): string => `${PREFIX}${sha256}`
/** The SHA-256 a string names, when it reads as a reference. */
export const referenced = (value: unknown): string | null => (typeof value === 'string' ? (REFERENCE.exec(value)?.[1] ?? null) : null)
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export const isDigest = (value: string): boolean => DIGEST.test(value)

/** A string's bytes when it is base64 of a file in its canonical form, else null. */
function fileBytes(value: string): Buffer | null {
  if (value.length < FILE_MIN || value.length % 4 !== 0 || !BASE64.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : null
}

const token = (key: string | number): string => String(key).replaceAll('~', '~0').replaceAll('/', '~1')
const untoken = (part: string): string => part.replaceAll('~1', '/').replaceAll('~0', '~')

/** Each file in a value, at any depth, replaced by its reference; null when there is none. */
export function findFiles(value: unknown): Found | null {
  const refs: FileRef[] = []
  const bytes = new Map<string, Buffer>()
  // The path is kept as its keys, and written as a pointer only for a file: a line without one costs a walk.
  const keys: (string | number)[] = []
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const found = fileBytes(node)
      if (found === null) return node
      const sha256 = digest(found)
      bytes.set(sha256, found)
      refs.push({ path: keys.map((k) => `/${token(k)}`).join(''), sha256, size: found.byteLength })
      return reference(sha256)
    }
    if (Array.isArray(node)) {
      let copy: unknown[] | null = null
      node.forEach((item, i) => {
        keys.push(i)
        const next = walk(item)
        keys.pop()
        if (next !== item) (copy ??= [...node])[i] = next
      })
      return copy ?? node
    }
    if (node !== null && typeof node === 'object' && !isLosslessNumber(node)) {
      let copy: Record<string, unknown> | null = null
      for (const [key, item] of Object.entries(node)) {
        keys.push(key)
        const next = walk(item)
        keys.pop()
        if (next !== item) (copy ??= { ...(node as Record<string, unknown>) })[key] = next
      }
      return copy ?? node
    }
    return node
  }
  const out = walk(value)
  return refs.length === 0 ? null : { value: out, refs, bytes }
}

/** A value with each listed reference given its bytes back, as base64; the value is not modified. */
export function expandFiles(value: unknown, refs: readonly FileRef[], bytes: ReadonlyMap<string, Buffer>): unknown {
  let out = value
  for (const ref of refs) {
    const parts = ref.path.split('/').slice(1).map(untoken)
    const set = (node: unknown, i: number): unknown => {
      if (i === parts.length) {
        const found = bytes.get(ref.sha256)
        if (referenced(node) !== ref.sha256 || found === undefined) throw new Error('files_unavailable')
        return found.toString('base64')
      }
      const key = parts[i]!
      if (Array.isArray(node)) {
        const copy = [...node]
        copy[Number(key)] = set(node[Number(key)], i + 1)
        return copy
      }
      if (node === null || typeof node !== 'object') throw new Error('files_unavailable')
      return { ...(node as Record<string, unknown>), [key]: set((node as Record<string, unknown>)[key], i + 1) }
    }
    out = set(out, 0)
  }
  return out
}

export interface FilesOptions {
  /** The account's S3 endpoint (`FILES_ENDPOINT`). */
  readonly endpoint: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

const status = (error: unknown): number | undefined => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
const code = (error: unknown): string | undefined => (error as { name?: string; Code?: string }).Code ?? (error as { name?: string }).name

/** The bucket (docs/specs/files.md, "Storing", "Reading a file", "The sweep"). Any failure of R2 is `files_unavailable`. */
export class Files {
  readonly bucket: string
  private readonly s3: S3Client
  constructor(options: FilesOptions) {
    this.bucket = options.bucket
    this.s3 = new S3Client({
      endpoint: options.endpoint,
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // The SHA-256 is given with each upload; nothing else is computed or checked by the client.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // A request runs under a Workstream's lock: it gives up rather than hang ("Storing", "R2 failing").
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    })
  }

  /** The server's configuration ("The server"): all four variables, or none at all. */
  static fromEnv(env: NodeJS.ProcessEnv): Files {
    const read = (name: string): string => {
      const value = env[name]
      if (value === undefined || value === '') throw new Error(`${name} is required`)
      return value
    }
    return new Files({
      endpoint: read('FILES_ENDPOINT'),
      bucket: read('FILES_BUCKET'),
      accessKeyId: read('FILES_ACCESS_KEY_ID'),
      secretAccessKey: read('FILES_SECRET_ACCESS_KEY'),
    })
  }

  static key(sha256: string): string {
    return `sha256/${sha256}`
  }

  /** Stores the bytes at their key: a `412` means they are there; a `400 BadDigest` is tried again. */
  async put(sha256: string, bytes: Buffer): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: Files.key(sha256),
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: 'application/octet-stream',
            IfNoneMatch: '*',
            ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          }),
        )
        return
      } catch (error) {
        if (status(error) === 412) return
        if (code(error) === 'BadDigest' && attempt < 3) continue
        throw new Error('files_unavailable')
      }
    }
  }

  /** The object's bytes; a missing object or a failing R2 is `files_unavailable`. */
  async get(sha256: string): Promise<Buffer> {
    try {
      const answer = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: Files.key(sha256) }))
      return Buffer.from(await answer.Body!.transformToByteArray())
    } catch {
      throw new Error('files_unavailable')
    }
  }

  /** The object as a stream, for `GET /api/files`; null when it does not exist. */
  async stream(sha256: string): Promise<{ body: Readable; size: number | undefined } | null> {
    try {
      const answer = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: Files.key(sha256) }))
      return { body: answer.Body as Readable, size: answer.ContentLength }
    } catch (error) {
      if (status(error) === 404 || code(error) === 'NoSuchKey') return null
      throw new Error('files_unavailable')
    }
  }

  /** Every object of the bucket under `sha256/`, with when it was last modified. */
  async *objects(): AsyncGenerator<{ sha256: string; modified: number }> {
    let token: string | undefined
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'sha256/', ...(token ? { ContinuationToken: token } : {}) }))
      for (const o of page.Contents ?? []) {
        const sha256 = (o.Key ?? '').slice('sha256/'.length)
        if (isDigest(sha256)) yield { sha256, modified: o.LastModified?.getTime() ?? 0 }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }

  /** Deletes objects, a thousand at a time; an object R2 does not delete is an error. */
  async remove(sha256s: readonly string[]): Promise<void> {
    for (let i = 0; i < sha256s.length; i += 1000) {
      const batch = sha256s.slice(i, i + 1000)
      const answer = await this.s3.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((s) => ({ Key: Files.key(s) })), Quiet: true } }),
      )
      if ((answer.Errors ?? []).length > 0) throw new Error('files_unavailable')
    }
  }

  /**
   * Makes sure each file is stored and has its row, inside the caller's transaction ("Storing"): under the
   * files lock, shared, so no sweep runs until that transaction ends; uploaded unless a row names it.
   */
  async keep(client: PoolClient, bytes: ReadonlyMap<string, Buffer>): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [FILES_LOCK])
    // In one order for every writer: two inserting the same new rows never wait on each other in a cycle.
    const sha256s = [...bytes.keys()].sort()
    const known = new Set((await client.query('SELECT sha256 FROM files WHERE sha256 = ANY($1)', [sha256s])).rows.map((r) => r.sha256 as string))
    for (const sha256 of sha256s) if (!known.has(sha256)) await this.put(sha256, bytes.get(sha256)!)
    await client.query('INSERT INTO files(sha256,size) SELECT * FROM unnest($1::text[], $2::bigint[]) ON CONFLICT DO NOTHING', [
      sha256s,
      sha256s.map((s) => bytes.get(s)!.byteLength),
    ])
  }

  /**
   * The sweep ("The sweep"): the bucket listed first, then, holding the files lock exclusive, the rows nothing
   * references and their objects, and the listed objects with no row; all once older than `ageMs`. While a
   * file is being stored, the lock is not free: the sweep waits for its next run, never queuing writers behind it.
   */
  async sweep(pool: Pool, ageMs = SWEEP_AGE_MS): Promise<{ rows: number; orphans: number } | null> {
    const before = new Date(Date.now() - ageMs)
    const old: string[] = []
    for await (const o of this.objects()) if (o.modified < before.getTime()) old.push(o.sha256)
    const client = await pool.connect()
    let held = false
    try {
      held = (await client.query('SELECT pg_try_advisory_lock($1) AS held', [FILES_LOCK])).rows[0]?.held === true
      if (!held) return null
      try {
        const gone = await client.query(
          `DELETE FROM files f WHERE f.time < $1
             AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.files IS NOT NULL AND e.files @> jsonb_build_array(jsonb_build_object('sha256', f.sha256)))
             AND NOT EXISTS (SELECT 1 FROM anchors a WHERE a.file = f.sha256)
           RETURNING sha256`,
          [before],
        )
        const rows = gone.rows.map((r) => r.sha256 as string)
        await this.remove(rows)
        const kept = new Set((await client.query('SELECT sha256 FROM files WHERE sha256 = ANY($1)', [old])).rows.map((r) => r.sha256 as string))
        const orphans = old.filter((s) => !kept.has(s) && !rows.includes(s))
        await this.remove(orphans)
        return { rows: rows.length, orphans: orphans.length }
      } finally {
        // A lock not given back goes with its connection, never to another caller.
        held = !(await client.query('SELECT pg_advisory_unlock($1) AS done', [FILES_LOCK]).then((r) => r.rows[0]?.done === true).catch(() => false))
      }
    } finally {
      client.release(held)
    }
  }
}

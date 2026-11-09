// An S3 endpoint for tests, standing in for R2 (Agora's docs/specs/files.md): the operations Agora uses,
// with the answers measured on the real bucket on 2026-11-08 — `412` for `If-None-Match: *` on a key that
// exists, `400 BadDigest` for an `x-amz-checksum-sha256` that does not match the body. Signatures are not
// checked. Stopping it makes R2 unreachable for real: connections are refused until it starts again.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export interface S3Object {
  bytes: Buffer
  modified: number
}

const xml = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`
const escape = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const unescape = (s: string): string => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
const NS = 'http://s3.amazonaws.com/doc/2006-03-01/'

export class FakeS3 {
  readonly bucket = 'agora-files'
  readonly objects = new Map<string, S3Object>()
  /** Every request, in order: its method and S3 operation, and the answer's status. */
  readonly requests: { operation: string; key?: string; status: number }[] = []
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  port = 0

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`
  }

  /** What Agora's server reads from its environment for this bucket. */
  env(): Record<string, string> {
    return { FILES_ENDPOINT: this.url, FILES_BUCKET: this.bucket, FILES_ACCESS_KEY_ID: 'test', FILES_SECRET_ACCESS_KEY: 'test' }
  }

  options(): { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string } {
    return { endpoint: this.url, bucket: this.bucket, accessKeyId: 'test', secretAccessKey: 'test' }
  }

  /** Starts listening, on the same port again after a stop. */
  async start(): Promise<this> {
    const server = createServer((req, res) => void this.handle(req, res).catch(() => res.destroy()))
    // It never keeps a test's process alive: the process ends when its tests do.
    server.on('connection', (socket) => {
      socket.unref()
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve))
    server.unref()
    this.port = (server.address() as { port: number }).port
    this.server = server
    return this
  }

  /** Stops answering: every connection is cut and new ones are refused. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Makes an object as old as given, as its last modification says. */
  age(sha256: string, ms: number): void {
    const o = this.objects.get(`sha256/${sha256}`)
    if (o) o.modified = Date.now() - ms
  }

  count(operation: string, status?: number): number {
    return this.requests.filter((r) => r.operation === operation && (status === undefined || r.status === status)).length
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://s3')
    const [, bucket, ...rest] = url.pathname.split('/')
    const key = decodeURIComponent(rest.join('/'))
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const answer = (operation: string, status: number, headers: Record<string, string> = {}, out: string | Buffer = '') => {
      this.requests.push({ operation, ...(key ? { key } : {}), status })
      res.writeHead(status, { ...(typeof out === 'string' && out !== '' ? { 'content-type': 'application/xml' } : {}), ...headers })
      res.end(out)
    }
    const error = (operation: string, status: number, code: string) =>
      answer(operation, status, {}, req.method === 'HEAD' ? '' : xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`))
    if (bucket !== this.bucket) return error('Unknown', 404, 'NoSuchBucket')
    if (req.method === 'PUT' && key) {
      const checksum = req.headers['x-amz-checksum-sha256']
      if (typeof checksum === 'string' && checksum !== createHash('sha256').update(body).digest('base64')) return error('PutObject', 400, 'BadDigest')
      if (req.headers['if-none-match'] === '*' && this.objects.has(key)) return error('PutObject', 412, 'PreconditionFailed')
      this.objects.set(key, { bytes: body, modified: Date.now() })
      return answer('PutObject', 200, { etag: `"${createHash('md5').update(body).digest('hex')}"` })
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && key) {
      const o = this.objects.get(key)
      if (!o) return error(req.method === 'GET' ? 'GetObject' : 'HeadObject', 404, 'NoSuchKey')
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(o.bytes.byteLength),
        'last-modified': new Date(o.modified).toUTCString(),
        etag: `"${createHash('md5').update(o.bytes).digest('hex')}"`,
      }
      return answer(req.method === 'GET' ? 'GetObject' : 'HeadObject', 200, headers, req.method === 'GET' ? o.bytes : '')
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const after = url.searchParams.get('continuation-token') ?? ''
      const max = Number(url.searchParams.get('max-keys') ?? 1000)
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()
      const page = keys.slice(0, max)
      const truncated = keys.length > page.length
      const contents = page
        .map((k) => {
          const o = this.objects.get(k)!
          return `<Contents><Key>${escape(k)}</Key><LastModified>${new Date(o.modified).toISOString()}</LastModified><Size>${String(o.bytes.byteLength)}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        })
        .join('')
      return answer(
        'ListObjectsV2',
        200,
        {},
        xml(
          `<ListBucketResult xmlns="${NS}"><Name>${this.bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${String(page.length)}</KeyCount><MaxKeys>${String(max)}</MaxKeys><IsTruncated>${String(truncated)}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${escape(page.at(-1)!)}</NextContinuationToken>` : ''}</ListBucketResult>`,
        ),
      )
    }
    if (req.method === 'POST' && url.searchParams.has('delete')) {
      const keys = [...body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unescape(m[1]!))
      for (const k of keys) this.objects.delete(k)
      const quiet = /<Quiet>true<\/Quiet>/.test(body.toString('utf8'))
      const deleted = quiet ? '' : keys.map((k) => `<Deleted><Key>${escape(k)}</Key></Deleted>`).join('')
      return answer('DeleteObjects', 200, {}, xml(`<DeleteResult xmlns="${NS}">${deleted}</DeleteResult>`))
    }
    return error('Unknown', 400, 'NotImplemented')
  }
}

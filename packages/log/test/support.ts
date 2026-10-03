// What the log's tests stand on (docs/reliability/README.md): a database of their own, Agora in this
// process or as a real lab process, real bridges with the mock agent, and real failures — a killed
// process, a terminated connection, a cut socket.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, Socket, type Server as NetServer } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createAnchorReceiver, ExecutionManager, type CredentialSource, type ManagerOptions } from '@agora/executions'
import { GrantSigner } from '@agora/credentials'
import { generateKeyPairSync } from 'node:crypto'
import { keys } from '@agora/testkit'
import { FakeKube } from '../../executions/test/fake-kube.ts'
import { serveFakeKube, type FakeKubeApi } from '../../executions/test/fake-kube-api.ts'
import { LogStore, Workstreams, logHttp, decode, encode, object, type WorkstreamsOptions, type Answer, type Command, type State, type Execution, type Entry, type ThreadRow } from '../src/index.ts'

export const POOL = 'mock-test'
let counter = 0

export async function until<T>(what: string, find: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await find()
    if (found !== undefined && found !== null && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function login(role: string): { user: string; password: string } {
  const [user, password] = String(process.env[`LOG_TEST_${role.toUpperCase()}_LOGIN`]).split(':')
  return { user: user!, password: password! }
}

export interface Db {
  readonly name: string
  readonly urls: { writer: string; projector: string; anchors: string }
  /** The provisioning login on this database: to break it for real, never to do Agora's work. */
  readonly admin: Pool
  /** Opens or closes the database to new connections, as PostgreSQL itself refuses them. */
  connections(allow: boolean): Promise<void>
  drop(): Promise<void>
}

/** The provisioning login on the cluster's `postgres` database: databases and roles. */
export function provisioning(): Pool {
  const pool = new Pool({ connectionString: String(process.env.LOG_TEST_ADMIN_URL) })
  pool.on('error', () => {})
  return pool
}

/** The suffix of this run: databases and roles named with it are removed after the run. */
export const RUN = String(process.env.LOG_TEST_TEMPLATE).split('_').at(-1)!

/** A database of the test's own, cloned from the migrated template, or empty. */
export async function database(options: { empty?: boolean } = {}): Promise<Db> {
  const base = new URL(String(process.env.LOG_TEST_ADMIN_URL))
  const name = `agora_log_t${String(++counter)}_${RUN}_${randomBytes(3).toString('hex')}`
  const server = provisioning()
  await server.query(options.empty ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} TEMPLATE ${String(process.env.LOG_TEST_TEMPLATE)}`)
  const at = (role: string) => {
    const url = new URL(base.href)
    const { user, password } = login(role)
    url.username = user
    url.password = password
    url.pathname = `/${name}`
    return url.href
  }
  const adminUrl = new URL(base.href)
  adminUrl.pathname = `/${name}`
  const admin = new Pool({ connectionString: adminUrl.href })
  admin.on('error', () => {})
  admin.on('connect', (client) => client.on('error', () => {}))
  return {
    name,
    urls: { writer: at('writer'), projector: at('projector'), anchors: at('anchors') },
    admin,
    async connections(allow) {
      await server.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS ${allow ? 'true' : 'false'}`)
    },
    async drop() {
      await server.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS true`).catch(() => {})
      await admin.end().catch(() => {})
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {})
      await server.end()
    },
  }
}

/** A TCP relay in front of a bridge: `cut` destroys both sides at once, as a network drop would. */
export class Relay {
  private readonly sockets = new Set<Socket>()
  private server: NetServer | null = null
  private readonly target: () => string
  port = 0
  constructor(target: () => string) {
    this.target = target
  }
  async listen(): Promise<this> {
    this.server = createServer((client) => {
      const [host, port] = this.target().split(':')
      const upstream = new Socket()
      upstream.connect(Number(port), host!)
      this.sockets.add(client).add(upstream)
      client.pipe(upstream).pipe(client)
      const drop = () => {
        client.destroy()
        upstream.destroy()
        this.sockets.delete(client)
        this.sockets.delete(upstream)
      }
      client.on('error', drop).on('close', drop)
      upstream.on('error', drop).on('close', drop)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }
  cut(): void {
    for (const socket of this.sockets) socket.resetAndDestroy()
    this.sockets.clear()
  }
  async close(): Promise<void> {
    this.cut()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }
}

/**
 * A TCP relay in front of PostgreSQL that can lose the reply to one COMMIT, as a network drop would:
 * the transaction is committed on the server, and its client only sees its connection fail. Armed with
 * a fragment of SQL, it drops the connection at the next COMMIT reply of the transaction that sent it.
 */
export class PgRelay {
  private readonly sockets = new Set<Socket>()
  private readonly target: { host: string; port: number }
  private server: NetServer | null = null
  private armed: string | null = null
  port = 0
  dropped = 0
  constructor(target: { host: string; port: number }) {
    this.target = target
  }
  arm(sql: string): void {
    this.armed = sql
  }
  async listen(): Promise<this> {
    this.server = createServer((client) => {
      const upstream = new Socket()
      upstream.connect(this.target.port, this.target.host)
      this.sockets.add(client).add(upstream)
      let marked = false
      let pending = Buffer.alloc(0)
      const drop = () => {
        client.destroy()
        upstream.destroy()
        this.sockets.delete(client)
        this.sockets.delete(upstream)
      }
      client.on('data', (chunk: Buffer) => {
        if (this.armed !== null && chunk.includes(this.armed)) marked = true
        upstream.write(chunk)
      })
      // The server's side is a stream of typed messages (no TLS here): forwarded one message at a time.
      upstream.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 5) {
          const size = 1 + pending.readInt32BE(1)
          if (pending.length < size) break
          const message = pending.subarray(0, size)
          pending = pending.subarray(size)
          if (marked && message[0] === 0x43 && message.subarray(5, size - 1).toString() === 'COMMIT') {
            this.armed = null
            this.dropped++
            drop()
            return
          }
          client.write(message)
        }
      })
      client.on('error', drop).on('close', drop)
      upstream.on('error', drop).on('close', drop)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }
}

export interface LabOptions {
  readonly db: Db
  readonly kube?: FakeKube
  readonly keys?: { privateKey: KeyObject; publicKey: KeyObject }
  /** Every bridge connection goes through a Relay, cut with `lab.cut()`. */
  readonly relay?: boolean
  readonly receiver?: boolean
  /** The writer login goes through a PgRelay, at `lab.pg`. */
  readonly pgRelay?: boolean
  /** Signs the tokens: the pools' Pods are warmed, executions get theirs before `initialize`. */
  readonly credentials?: CredentialSource
  readonly workstreams?: Partial<WorkstreamsOptions>
  readonly executions?: Partial<ManagerOptions>
}

/** Agora in this process, on a FakeKube whose Pods run real bridges with the mock agent. */
export class Lab {
  readonly kube: FakeKube
  readonly keys: { privateKey: KeyObject; publicKey: KeyObject }
  readonly store: LogStore
  readonly executions: ExecutionManager
  readonly workstreams: Workstreams
  readonly options: LabOptions
  readonly relays = new Map<string, Relay>()
  readonly pg: PgRelay | null
  /** What the operational logger emitted, one line each. */
  readonly logs: string[] = []
  ownershipLost = 0
  private receiver: HttpServer | null = null
  private api: HttpServer | null = null
  url = ''

  private constructor(options: LabOptions, pg: PgRelay | null) {
    this.options = options
    this.pg = pg
    this.keys = options.keys ?? keys()
    this.kube = options.kube ?? new FakeKube(this.keys.publicKey)
    const writer = new URL(options.db.urls.writer)
    if (pg) {
      writer.hostname = '127.0.0.1'
      writer.port = String(pg.port)
    }
    this.store = new LogStore({ ...options.db.urls, writer: writer.href })
    const relayed = (service: string, pod: string): string => {
      const relay = this.relays.get(pod)
      return relay ? `127.0.0.1:${String(relay.port)}` : this.kube.address(service, pod)
    }
    this.executions = new ExecutionManager({
      kube: this.kube,
      signingKey: this.keys.privateKey,
      bridgePort: 8080,
      bridgeAddress: options.relay ? relayed : this.kube.address,
      tickMs: 100,
      reconnectMs: 200,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials, warmEveryMs: 200 }),
      ...options.executions,
    })
    this.workstreams = new Workstreams({
      store: this.store,
      executions: this.executions,
      defaults: { leaseSeconds: 600, turnCapSeconds: 3600 },
      maxActive: 4,
      renewSeconds: 60,
      tickMs: 100,
      shutdownMs: 2000,
      onOwnershipLost: () => {
        this.ownershipLost++
      },
      sink: (line) => this.logs.push(line),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...options.workstreams,
    })
  }

  static async start(options: LabOptions): Promise<Lab> {
    const target = new URL(options.db.urls.writer)
    const pg = options.pgRelay ? await new PgRelay({ host: target.hostname, port: Number(target.port || 5432) }).listen() : null
    const lab = new Lab(options, pg)
    if (options.relay) {
      // A relay per Pod, in place before its claim is ready.
      const factory = lab.kube.bridgeFactory
      lab.kube.bridgeFactory = async (publicKey, pod) => {
        const bridge = await factory(publicKey, pod)
        lab.relays.set(pod, await new Relay(() => bridge.url).listen())
        return bridge
      }
    }
    if (options.receiver) {
      lab.receiver = createAnchorReceiver({
        receive: (pod, bundle, raw) => lab.workstreams.receiveAnchor(pod, bundle, raw),
        namespace: 'agora-sandboxes',
        verify: (token) => lab.kube.reviewToken(token),
      })
      await new Promise<void>((resolve) => lab.receiver!.listen(0, '127.0.0.1', resolve))
      lab.kube.anchorUrl = `http://127.0.0.1:${String((lab.receiver.address() as AddressInfo).port)}/anchors`
    }
    try {
      await lab.workstreams.start()
    } catch (error) {
      await lab.shutdown(options.kube === undefined)
      throw error
    }
    lab.api = createHttpServer((req, res) => {
      void logHttp(lab.workstreams, req, res, { testRoutes: true }).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => lab.api!.listen(0, '127.0.0.1', resolve))
    lab.url = `http://127.0.0.1:${String((lab.api.address() as AddressInfo).port)}`
    return lab
  }

  closed = false

  /** Agora again on the same database and cluster: after a clean stop, or after dying on the spot. */
  async restart(how: 'clean' | 'halt', options: Partial<LabOptions> = {}): Promise<Lab> {
    if (how === 'clean') await this.workstreams.stop()
    else this.workstreams.halt()
    await this.shutdown(false)
    return Lab.start({ ...this.options, ...options, kube: this.kube, keys: this.keys })
  }

  private async shutdown(kube: boolean): Promise<void> {
    this.closed = true
    this.api?.closeAllConnections()
    await new Promise<void>((resolve) => (this.api ? this.api.close(() => resolve()) : resolve()))
    for (const relay of this.relays.values()) await relay.close()
    await this.pg?.close()
    await new Promise<void>((resolve) => (this.receiver ? this.receiver.close(() => resolve()) : resolve()))
    await this.store.close().catch(() => {})
    if (kube) await this.kube.closeAll()
  }

  async close(): Promise<void> {
    await this.workstreams.stop().catch(() => this.workstreams.halt())
    await this.shutdown(true)
  }

  cut(): void {
    for (const relay of this.relays.values()) relay.cut()
  }

  async workstream(): Promise<string> {
    const id = randomUUID()
    await this.store.create(id, randomUUID())
    return id
  }

  command(workstream: string, kind: Command['kind'], target: Record<string, unknown> = {}, body: Record<string, unknown> = {}): Promise<Answer> {
    return this.workstreams.command(workstream, { id: randomUUID(), kind, target, body })
  }

  async state(workstream: string): Promise<State> {
    return this.store.state(workstream)
  }

  async entries(workstream: string): Promise<readonly Entry[]> {
    return this.store.entries(workstream)
  }

  /** Creates an execution and waits for its Session. */
  async open(workstream: string, body: Record<string, unknown> = {}): Promise<Execution> {
    const answer = await this.command(workstream, 'Create', {}, { pool: POOL, ...body })
    if (!answer.accepted) throw new Error(`Create refused: ${answer.reason}`)
    return until('Session open', async () => {
      const e = (await this.state(workstream)).current
      return e?.session && e.connection ? e : null
    })
  }

  async write(workstream: string, text: string): Promise<Answer> {
    const e = (await this.state(workstream)).current!
    return this.command(workstream, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text }] })
  }

  /** The latest turn, once it has one of these statuses. */
  async turn(workstream: string, status: string | string[], timeoutMs = 15_000) {
    const wanted = Array.isArray(status) ? status : [status]
    return until(`turn ${wanted.join('|')}`, async () => {
      const latest = [...(await this.state(workstream)).turns.values()].at(-1)
      return latest && wanted.includes(latest.status) ? latest : null
    }, timeoutMs)
  }
}

/** The real lab, as its own process, on FakeKube served over HTTP: a kill is a real kill. */
export class Server {
  readonly url: string
  readonly anchorUrl: string
  readonly child: ChildProcess
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  output = ''

  private constructor(child: ChildProcess, port: number, anchorPort: number) {
    this.child = child
    this.url = `http://127.0.0.1:${String(port)}`
    this.anchorUrl = `http://127.0.0.1:${String(anchorPort)}/anchors`
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    child.stdout?.on('data', (chunk: Buffer) => (this.output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (this.output += chunk.toString()))
  }

  static async start(options: { db: Db; api: FakeKubeApi; keys: { privateKey: KeyObject }; env?: Record<string, string> }): Promise<Server> {
    const dir = mkdtempSync(join(tmpdir(), 'lab-'))
    writeFileSync(join(dir, 'signing.pem'), options.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    writeFileSync(join(dir, 'token'), 'test')
    const [port, anchorPort] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, [new URL('../../../apps/server/src/main.ts', import.meta.url).pathname], {
      env: {
        ...process.env,
        SANDBOX_NAMESPACE: 'agora-sandboxes',
        SIGNING_KEY_FILE: join(dir, 'signing.pem'),
        KUBE_API: options.api.url,
        KUBE_TOKEN_FILE: join(dir, 'token'),
        LOG_WRITER_URL: options.db.urls.writer,
        LOG_PROJECTOR_URL: options.db.urls.projector,
        LOG_ANCHORS_URL: options.db.urls.anchors,
        PORT: String(port),
        ANCHOR_PORT: String(anchorPort),
        TEST_ROUTES: 'true',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const server = new Server(child, port, anchorPort)
    await until('lab ready', () => server.output.includes('anchor receiver on') || server.child.exitCode !== null, 20_000)
    if (server.child.exitCode !== null) throw new Error(`lab exited: ${server.output}`)
    return server
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  command(workstream: string, kind: Command['kind'], target: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
    return this.post(`/api/workstreams/${workstream}/commands`, { id: randomUUID(), kind, target, body })
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal)
    return this.exited
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A FakeKube served over HTTP, with its anchor pushes going to a lab process. */
export async function cluster(): Promise<{ kube: FakeKube; api: FakeKubeApi; keys: { privateKey: KeyObject; publicKey: KeyObject }; close(): Promise<void> }> {
  const k = keys()
  const kube = new FakeKube(k.publicKey)
  const api = await serveFakeKube(kube)
  return {
    kube,
    api,
    keys: k,
    async close() {
      await api.close()
      await kube.closeAll()
    },
  }
}

/** Terminates the backends of a login on a database — a real dropped connection. */
export async function terminate(db: Db, role: 'writer' | 'projector' | 'anchors', filter: 'owner' | 'others' | 'all'): Promise<number> {
  const user = login(role).user
  const where = filter === 'owner' ? "AND application_name='agora-owner'" : filter === 'others' ? "AND application_name<>'agora-owner'" : ''
  // From the cluster's `postgres` database: the test's own may be closed to new connections.
  const server = provisioning()
  try {
    const result = await server.query(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE usename=$1 AND datname=$2 ${where}`,
      [user, db.name],
    )
    return result.rows[0].n as number
  } finally {
    await server.end()
  }
}

export { FakeKube }

/** One JSON request: the status and the body, parsed losslessly. */
export async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : encode(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : (object(decode(text)) ?? {}) }
}

export interface ThreadRead {
  readonly status: number
  readonly body?: Record<string, unknown>
  readonly snapshot: ThreadRow[]
  /** H, from `snapshot-end`; null when the read was cut before it. */
  readonly end: string | null
  readonly live: ThreadRow[]
}

/**
 * Reads a thread over HTTP from `after`: the snapshot, H, then live rows while `more` asks for them.
 * `cut` closes the stream after that many snapshot rows, before `snapshot-end`.
 */
export async function readThread(
  base: string,
  workstream: string,
  after: string,
  options: { cut?: number; more?: (live: readonly ThreadRow[]) => boolean; timeoutMs?: number } = {},
): Promise<ThreadRead> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 15_000)
  try {
    const response = await fetch(`${base}/api/workstreams/${workstream}/thread?after=${encodeURIComponent(after)}`, { signal: abort.signal })
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
      return { status: response.status, body: object(decode(await response.text())) ?? {}, snapshot: [], end: null, live: [] }
    }
    const snapshot: ThreadRow[] = [],
      live: ThreadRow[] = []
    let end: string | null = null,
      buffer = ''
    const decoder = new TextDecoder()
    const reader = response.body!.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const event = object(decode(buffer.slice(0, at).replace(/^data: /, ''))) ?? {}
        buffer = buffer.slice(at + 2)
        const { type, ...row } = event
        if (type === 'snapshot') snapshot.push(row as unknown as ThreadRow)
        else if (type === 'snapshot-end') end = String(row.position)
        else live.push(row as unknown as ThreadRow)
        const stop =
          (end === null && options.cut !== undefined && snapshot.length >= options.cut) ||
          (end !== null && !(options.more?.(live) ?? false))
        if (stop) {
          abort.abort()
          return { status: response.status, snapshot, end, live }
        }
      }
    }
    return { status: response.status, snapshot, end, live }
  } catch (error) {
    if (abort.signal.aborted) throw new Error('timed out: thread read')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A fresh database, a Lab on it, a Workstream, and an open execution. The Lab in `lab` when the test
 * ends is closed, then the database dropped: a test that restarts Agora puts the new Lab there.
 */
export async function opened(
  t: { after(fn: () => Promise<void>): void },
  options: Omit<LabOptions, 'db'> = {},
  create: Record<string, unknown> = {},
): Promise<{ db: Db; lab: Lab; ws: string; e: Execution }> {
  const db = await database()
  const context = { db, lab: await Lab.start({ db, ...options }), ws: '', e: null as unknown as Execution }
  t.after(async () => {
    await context.lab.close()
    await db.drop()
  })
  context.ws = await context.lab.workstream()
  // A copy: the state's own object goes on changing with the log.
  context.e = { ...(await context.lab.open(context.ws, create)) }
  return context
}

/** The lines of a Workstream: kind `acp`, with a direction and a method or the method answered. */
export function lines(entries: readonly Entry[], direction: 'in' | 'out', method?: string): Entry[] {
  return entries.filter((x) => x.kind === 'acp' && x.direction === direction && (method === undefined || x.method === method || x.correlated_method === method))
}

export function base64(...values: (string | Buffer)[]): string {
  return Buffer.concat(values.map((v) => Buffer.concat([typeof v === 'string' ? Buffer.from(v) : v, Buffer.from('\n')]))).toString('base64')
}

/** The backends of a login waiting on a lock in this database. */
export async function waiting(db: Db, role: 'writer' | 'projector' | 'anchors'): Promise<number[]> {
  const result = await db.admin.query(
    "SELECT pid FROM pg_stat_activity WHERE usename=$1 AND datname=$2 AND wait_event_type='Lock'",
    [login(role).user, db.name],
  )
  return result.rows.map((r) => r.pid as number)
}

/** Holds a Workstream's row lock from the provisioning login, as a long transaction would. */
export async function hold(db: Db, workstream: string): Promise<() => Promise<void>> {
  const client = await db.admin.connect()
  await client.query('BEGIN')
  await client.query('SELECT id FROM workstreams WHERE id=$1 FOR UPDATE', [workstream])
  return async () => {
    await client.query('ROLLBACK')
    client.release()
  }
}

/**
 * The deadline brought to now by the cluster (FakeKube), again until the deletion starts: a renewal
 * Agora grants meanwhile — at the end of a turn — would otherwise move it back.
 */
export async function expire(kube: FakeKube, claimName: string): Promise<void> {
  await until('the claim expiring', () => {
    const claim = kube.claims.get(claimName)
    if (claim === undefined || claim.metadata.deletionTimestamp !== undefined) return true
    kube.expireAt(claimName, new Date())
    return false
  })
}

export interface Minted {
  readonly label: string
  readonly profiles: readonly string[]
  readonly sub: string
  readonly expiresAt: string | null
  readonly at: number
}

/**
 * A real signer (a key of its own) that records what it signs. `fail` makes it refuse, as a signer
 * that cannot sign would.
 */
export function grants(): { source: CredentialSource; minted: Minted[]; fail: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'))
  writeFileSync(join(dir, 'key.pem'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const real = new GrantSigner({ proxy: '127.0.0.1:9', keyFile: join(dir, 'key.pem'), keyId: 'k', issuer: 'agora', audience: 'agora-gateway' })
  const state = { minted: [] as Minted[], fail: false }
  return Object.assign(state, {
    source: {
      describe: () => real.describe(),
      async mint(input: { label: string; ttlSeconds: number; profiles?: readonly string[] }) {
        if (state.fail) throw new Error('signer unavailable')
        const credentials = await real.mint(input)
        const payload = JSON.parse(Buffer.from(credentials.token.split('.')[1]!, 'base64url').toString()) as { sub: string }
        state.minted.push({ label: input.label, profiles: input.profiles ?? [], sub: payload.sub, expiresAt: credentials.expiresAt, at: Date.now() })
        return credentials
      },
    },
  })
}

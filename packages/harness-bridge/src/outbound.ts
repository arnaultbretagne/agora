// The bridge's outbound proxy (docs/credentials.md). The adapter starts with the warm Pod, before
// any execution exists, so its environment cannot carry a credential: it starts with HTTPS_PROXY
// pointing here, on loopback, and Agora hands the bridge later the credential proxy to go through
// and the token that opens it (PUT /credentials). Each CONNECT is forwarded to that proxy with the
// token as Proxy-Authorization, and the proxy's answer (200, 407, 403…) goes back to the adapter
// as is. Nothing is decrypted here: TLS runs between the adapter and the credential proxy.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export interface Credentials {
  /** `host:port` of the credential proxy. */
  readonly proxy: string
  readonly token: string
  readonly expiresAt: string | null
}

export interface OutboundView {
  readonly proxy: string | null
  readonly expiresAt: string | null
  readonly attachedAt: string | null
  readonly tunnels: number
  readonly refused: number
  /** Per `host:port` asked by the adapter: how many tunnels, and the proxy's last answer. */
  readonly targets: Record<string, { count: number; lastStatus: number | null }>
}

export interface Outbound {
  readonly url: string
  set(credentials: Credentials): void
  describe(): OutboundView
  close(): Promise<void>
}

const TARGET = /^[A-Za-z0-9.-]+:\d{1,5}$/

export function parseCredentials(body: unknown): Credentials {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const { proxy, token, expiresAt } = input
  if (typeof proxy !== 'string' || !TARGET.test(proxy)) throw new Error('proxy doit être « hôte:port »')
  if (typeof token !== 'string' || token.trim() === '' || /[\s]/.test(token)) throw new Error('token absent ou invalide')
  if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) throw new Error('expiresAt doit être une date ISO')
  return { proxy, token, expiresAt: (expiresAt as string | null | undefined) ?? null }
}

export async function startOutbound(options: { port?: number; log: (message: string) => void }): Promise<Outbound> {
  let credentials: Credentials | null = null
  let attachedAt: string | null = null
  let tunnels = 0
  let refused = 0
  const targets: Record<string, { count: number; lastStatus: number | null }> = {}
  const open = new Set<Socket | Duplex>()

  function refuse(socket: Duplex, status: string, reason: string): void {
    refused += 1
    socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${reason}\n`)
  }

  const server: Server = createServer((_req, res) => {
    // Only CONNECT: plain http:// has no credential to carry and never leaves the Pod.
    res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('seul CONNECT est relayé\n')
  })

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const target = req.url ?? ''
    client.on('error', () => {})
    if (!TARGET.test(target)) return refuse(client, '400 Bad Request', 'cible attendue : hôte:port')
    const current = credentials
    if (current === null) return refuse(client, '503 Service Unavailable', 'aucun accès sortant branché sur cette exécution')

    tunnels += 1
    const stats = (targets[target] ??= { count: 0, lastStatus: null })
    stats.count += 1
    const [host, port] = current.proxy.split(':') as [string, string]
    const upstream = connect(Number(port), host)
    let connected = false
    for (const socket of [client, upstream]) {
      open.add(socket)
      socket.once('close', () => open.delete(socket))
    }
    upstream.once('connect', () => {
      connected = true
      upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${current.token}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.once('data', (chunk: Buffer) => {
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.subarray(0, 32).toString('latin1'))
        stats.lastStatus = status === null ? null : Number(status[1])
      })
      // The pipes carry the normal ends; an error on either side tears both down.
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', (error) => {
      if (connected) client.destroy()
      else {
        options.log(`proxy de credentials injoignable (${current.proxy}) : ${error.message}`)
        stats.lastStatus = 502
        refuse(client, '502 Bad Gateway', 'proxy de credentials injoignable')
      }
    })
    client.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`

  return {
    url,
    set: (next) => {
      credentials = next
      attachedAt = new Date().toISOString()
      // Never the token.
      options.log(`accès sortant branché : ${next.proxy}${next.expiresAt === null ? '' : `, jusqu'à ${next.expiresAt}`}`)
    },
    describe: () => ({
      proxy: credentials?.proxy ?? null,
      expiresAt: credentials?.expiresAt ?? null,
      attachedAt,
      tunnels,
      refused,
      targets: structuredClone(targets),
    }),
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

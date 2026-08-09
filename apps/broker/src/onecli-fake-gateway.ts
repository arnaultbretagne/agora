import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FakeOneCliControlAdapter } from './onecli-fake.js'

/**
 * A faithful double of OneCLI's own gateway (NOT of Agora's relay — that is real code in
 * `relay.ts`). Test-only: real automated tests dial THIS to prove the relay's CONNECT tunnel is
 * genuinely opaque end to end (workload -> relay -> "OneCLI gateway" -> "provider"), without ever
 * touching the real self-hosted OneCLI product. Reproduces the one check the real gateway still
 * performs for Agora after ADR 0015: reject an unrecognized/rotated Agent bearer.
 *
 * It deliberately does NOT filter hosts any more. On OneCLI ≥1.44 there is no project `block *`
 * left to publish — the project Default Rule is seeded `allow` and documented as "not a posture
 * dial", network rules being Enterprise-only — so a double that still returned 403 for an
 * unlisted host would be modelling a product behavior that no longer exists, and would mask the
 * only thing the relay egress tests are trying to prove: that **Agora's own relay** refuses the
 * host, before any byte reaches this gateway.
 *
 * Plain HTTP CONNECT over a plain TCP socket, not wrapped in an outer TLS listener — the outer
 * transport is a deployment-level concern this program does not re-implement anywhere (same
 * "trust the transport" convention as apps/session-runtime-controller/src/server.ts).
 */
export interface FakeOnecliGatewayHandle {
  readonly url: string
  close(): Promise<void>
}

export type DialTarget = (host: string, port: number) => Socket

const defaultDialTarget: DialTarget = (host, port) => netConnect(port, host)

export function startFakeOnecliGateway(adapter: FakeOneCliControlAdapter, dialTarget: DialTarget = defaultDialTarget): Promise<FakeOnecliGatewayHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(405).end()
    })
    server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      handleConnect(adapter, dialTarget, req, clientSocket, head)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

function handleConnect(adapter: FakeOneCliControlAdapter, dialTarget: DialTarget, req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
  clientSocket.on('error', () => {})

  // HTTP Basic, exactly like the real gateway — NOT Bearer. Found live, P11: this double used to
  // accept `Bearer`, matching the (wrong) relay implementation instead of the real product, so the
  // entire relay test suite passed green while every real CONNECT authenticated as anonymous and
  // silently lost TLS interception. A double that only mirrors our own code cannot catch our own
  // code being wrong; this one now enforces what was verified live against the real gateway.
  const authHeader = req.headers['proxy-authorization']
  const encoded = typeof authHeader === 'string' && authHeader.startsWith('Basic ') ? authHeader.slice('Basic '.length) : undefined
  const credential = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined
  const identifier = credential ? adapter.findIdentifierForProxyCredentialForTest(credential) : undefined
  if (!identifier) {
    clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    return
  }

  const target = req.url ?? ''
  const separatorIndex = target.lastIndexOf(':')
  const host = separatorIndex > 0 ? target.slice(0, separatorIndex) : ''
  const port = separatorIndex > 0 ? Number(target.slice(separatorIndex + 1)) : NaN
  if (!host || !Number.isInteger(port)) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }

  const upstream = dialTarget(host, port)
  upstream.on('error', () => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  upstream.once('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
}

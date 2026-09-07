// Bridge server (S8, replacing the S4 development shared secret — findings §7 structure kept, auth
// changed): the WebSocket peer of packages/acp's connectBridge, running inside the Pod. It frames
// but never interprets ACP — every byte from the adapter's stdout goes to the socket, every byte
// from the socket goes to the adapter's stdin, verbatim. The adapter process is spawned exactly
// once and OUTLIVES any single WebSocket connection: a dropped connection reconnects to the SAME
// process (same native session, same process_generation) rather than getting a fresh one — killing
// the adapter is a distinct, explicit action (a real process exit), never an artifact of the bridge
// losing a socket.
import type { Readable, Writable } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { verifyBridgeToken } from '@agora/acp'

export interface AdapterProcess {
  readonly stdout: Readable
  readonly stdin: Writable
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  kill(): void
}

/** Any Node ChildProcess spawned with stdout/stdin as pipes — stderr is deliberately not this function's concern (launch.ts wires it straight to the Pod's own, `inherit`). */
export interface SpawnedProcess {
  readonly stdout: Readable
  readonly stdin: Writable
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(): boolean
}

export function adapterProcessFrom(child: SpawnedProcess): AdapterProcess {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { stdout: child.stdout, stdin: child.stdin, exited, kill: () => void child.kill() }
}

export interface BridgeServerOptions {
  readonly port: number
  readonly incarnation: string
  readonly bridgeAuthSecret: string
  readonly adapter: AdapterProcess
  readonly onLog?: (message: string) => void
}

export interface BridgeServer {
  readonly processGeneration: number
  /** The actually-bound port — useful when `port: 0` asked the OS to pick one. */
  address(): number
  stop(): Promise<void>
}

export function startBridgeServer(options: BridgeServerOptions): BridgeServer {
  const log = options.onLog ?? ((message: string) => console.log(message))
  let adapterExited = false
  void options.adapter.exited.then((result) => {
    adapterExited = true
    log(`adapter process exited code=${result.code} signal=${result.signal}`)
  })

  const wss = new WebSocketServer({
    port: options.port,
    verifyClient: (info, callback) => {
      const header = info.req.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
      if (token === undefined) return callback(false, 401, 'missing bearer token')
      const verification = verifyBridgeToken(token, options.incarnation, options.bridgeAuthSecret)
      if (!verification.ok) return callback(false, 403, verification.reason)
      callback(true)
    },
  })

  // ONE attached client at a time. The adapter answers by JSON-RPC id, and every ACP connection
  // numbers its own requests from 0 — so with two sockets attached, both receive every frame and a
  // response to one connection's request 0 is delivered to the other's request 0 as well. Live,
  // that produced `Got response to unknown request 0` in the control plane and left a prompt
  // dispatch reserved for ever, which the one-turn-per-Workstream gate then read as a turn in
  // flight: the Workstream could never be prompted again.
  //
  // The newest connection wins, and the previous one is closed rather than left half-listening:
  // connect-act-disconnect is the caller's own model (verbs/start.ts), a dropped connection is
  // already retriable everywhere, and the adapter process itself is untouched — which is the whole
  // point of it outliving any single socket.
  let attached: { readonly socket: WebSocket; readonly onData: (chunk: Buffer) => void } | null = null

  wss.on('connection', (socket: WebSocket) => {
    if (adapterExited) {
      socket.close(1011, 'adapter process is gone')
      return
    }
    if (attached !== null) {
      log('a second bridge connection arrived: closing the previous one, which the adapter can no longer be answering for')
      options.adapter.stdout.off('data', attached.onData)
      attached.socket.close(1012, 'superseded by a newer bridge connection')
      attached = null
    }
    const onAdapterData = (chunk: Buffer): void => {
      if (socket.readyState === socket.OPEN) socket.send(chunk)
    }
    attached = { socket, onData: onAdapterData }
    options.adapter.stdout.on('data', onAdapterData)
    socket.on('message', (data: Buffer) => {
      options.adapter.stdin.write(data)
    })
    // Detaches this connection's relay only — the adapter process is untouched. A reconnect
    // attaches a fresh listener to the same still-running process (same process_generation).
    const detach = (): void => {
      options.adapter.stdout.off('data', onAdapterData)
      if (attached?.socket === socket) attached = null
    }
    socket.on('close', detach)
    socket.on('error', detach)
  })

  return {
    processGeneration: 1,
    address: () => {
      const address = wss.address()
      return typeof address === 'object' && address !== null ? address.port : options.port
    },
    stop: () =>
      new Promise((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

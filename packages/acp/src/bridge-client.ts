// Bridge client: the development bridge is an authenticated WebSocket carrying NDJSON frames
// (P4 — execution.md). This adapter exposes it as a DuplexByteStream for the capture seam.
// Connection loss is surfaced as an event carrying the connection_id — never silent (SESSION-A05
// attribution rides on that connection_id).
import { randomUUID } from 'node:crypto'
import type { DuplexByteStream } from './framing.js'

export interface BridgeClientOptions {
  readonly url: string
  /** S4 development credential: a shared secret. S8 replaces it with incarnation credentials. */
  readonly token: string
  readonly connectionId?: string
  readonly onLoss?: (connectionId: string) => void
}

export interface BridgeConnection {
  readonly connectionId: string
  readonly stream: DuplexByteStream
  readonly close: () => Promise<void>
  readonly closed: Promise<void>
}

export function connectBridge(options: BridgeClientOptions): Promise<BridgeConnection> {
  const connectionId = options.connectionId ?? randomUUID()
  const socket = new WebSocket(options.url, {
    headers: { authorization: `Bearer ${options.token}`, 'x-agora-connection-id': connectionId },
  } as never)

  let notifyLoss = (): void => {
    if (!lost) {
      lost = true
      options.onLoss?.(connectionId)
    }
  }
  let lost = false

  let opened: (() => void) | null = null
  let failed: ((error: unknown) => void) | null = null
  const openPromise = new Promise<void>((resolve, reject) => {
    opened = resolve
    failed = reject
  })

  let closedResolve: (() => void) | null = null
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve
  })

  const incomingController: { enqueue: (chunk: Uint8Array) => void; close: () => void; error: (reason: unknown) => void } = {
    enqueue: () => {},
    close: () => {},
    error: () => {},
  }

  socket.onopen = () => opened?.()
  socket.onerror = () => {
    const error = new Error('bridge connection error')
    failed?.(error)
    incomingController.error(error)
    notifyLoss()
    closedResolve?.()
  }
  socket.onclose = () => {
    if (failed && socket.readyState !== socket.OPEN) failed(new Error('bridge connection closed before opening'))
    incomingController.close()
    notifyLoss()
    closedResolve?.()
  }
  socket.onmessage = (event: WebSocketEventMap['message']) => {
    const data = event.data
    if (typeof data === 'string') incomingController.enqueue(new TextEncoder().encode(data))
    else incomingController.enqueue(new Uint8Array(data as ArrayBuffer))
  }

  // A socket can be errored and then closed, or closed twice, and a ReadableStream controller
  // THROWS on the second close/error — from a WebSocket event handler, where the throw is uncaught
  // and kills the process. That is not theoretical: the control-plane worker crash-looped on
  // `ERR_INVALID_STATE: Controller is already closed` the first time a verb closed a bridge while
  // its socket was already closing. The stream's terminal state is reached once, here.
  let terminated = false
  const incoming = new ReadableStream<Uint8Array>({
    start(controller) {
      incomingController.enqueue = (chunk) => {
        if (!terminated) controller.enqueue(chunk)
      }
      incomingController.close = () => {
        if (terminated) return
        terminated = true
        controller.close()
      }
      incomingController.error = (reason) => {
        if (terminated) return
        terminated = true
        controller.error(reason)
      }
    },
  })

  const outgoing = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (socket.readyState !== socket.OPEN) throw new Error('bridge connection is not open')
      await socket.send(chunk as unknown as Parameters<WebSocket['send']>[0])
    },
    async close() {
      socket.close(1000)
    },
  })

  return openPromise.then(() => ({
    connectionId,
    stream: { readable: incoming, writable: outgoing },
    close: async () => {
      socket.close(1000)
      await closed
    },
    closed,
  }))
}

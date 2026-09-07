import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { connectBridge } from '../src/bridge-client.js'
import { mintBridgeToken } from '../src/bridge-auth.js'

/**
 * A ReadableStream controller throws on a second close or error, and the bridge client drives its
 * controller from WebSocket event handlers — where a throw is uncaught and takes the process with
 * it. The control-plane worker crash-looped on exactly that (`ERR_INVALID_STATE: Controller is
 * already closed`) the first time a verb closed a bridge whose socket was already closing.
 */
test('S13: a socket that errors and then closes does not throw out of an event handler', async () => {
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (socket) => {
    // Close abruptly, twice over: an error path and a close path for the same connection.
    socket.terminate()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port

  const uncaught: unknown[] = []
  const onUncaught = (error: unknown): void => void uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    const token = mintBridgeToken('secret', 'inc-1')
    await connectBridge({ url: `ws://127.0.0.1:${port}/`, token }).catch(() => undefined)
    // Give the socket's own close/error events time to fire after the connect settled.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(uncaught, [], 'closing twice must not throw out of the WebSocket handler')
  } finally {
    process.off('uncaughtException', onUncaught)
    wss.close()
    http.close()
  }
})

test('S13: a stream that reached its terminal state elsewhere still does not throw on close', async () => {
  // The flag alone was not enough: a consumer that cancels, or a finished pipeline, closes the
  // controller without going through us — and the next socket event threw from an event handler,
  // which is uncatchable and fatal. The worker crash-looped a second time on this exact line.
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (socket) => {
    socket.send('{"jsonrpc":"2.0"}')
    setTimeout(() => socket.close(), 10)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port

  const uncaught: unknown[] = []
  const onUncaught = (error: unknown): void => void uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    const connection = await connectBridge({ url: `ws://127.0.0.1:${port}/`, token: mintBridgeToken('inc-1', 'secret') })
    // Cancel the readable from the consumer side: the controller is now terminal, and nothing we
    // track says so.
    await connection.stream.readable.cancel().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(uncaught, [])
  } finally {
    process.off('uncaughtException', onUncaught)
    wss.close()
    http.close()
  }
})

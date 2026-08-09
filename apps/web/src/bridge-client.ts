import { Duplex } from 'node:stream'
import type { DuplexByteStream } from '@agora/acp'
import { WebSocket, createWebSocketStream } from 'ws'

/**
 * Connects to the ACP bridge endpoint minted by the Session Runtime controller's
 * `openACPConnection` (docs/specs/08) and wraps it as the `DuplexByteStream`
 * `@agora/acp`'s `bootstrapSession` expects. Same construction proven live in P04's
 * cluster verification: `ws` -> `createWebSocketStream` -> `Duplex.toWeb`.
 */
export async function connectAcpBridge(url: string, credential: string): Promise<DuplexByteStream> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const duplex = createWebSocketStream(ws)
  const { readable, writable } = Duplex.toWeb(duplex)
  return { readable: readable as ReadableStream<Uint8Array>, writable: writable as WritableStream<Uint8Array> }
}

// The fixed fake capability policy/execution-grant placeholders that used to live here (from
// before the Broker, P08, existed) are gone — found live, P11: orchestration.ts now calls the
// real Broker (broker-grant-client.ts) for both. See orchestration.ts's own module doc.

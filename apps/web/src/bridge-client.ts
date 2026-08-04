import { createHash } from 'node:crypto'
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

/**
 * No Broker exists yet (ADR 0010/P08) to resolve real capability intent — this plan's non-goal
 * boundary matches P04's (`fakeRelayBundle`) and P03's (caller-supplied capability facts): a
 * fixed, honestly-fake policy every Session binds to, never a real access decision.
 */
export const FAKE_CAPABILITY_POLICY_VERSION = 'fake-no-broker-v1'

export function fakeCapabilityDigest(): Uint8Array {
  return createHash('sha256').update(FAKE_CAPABILITY_POLICY_VERSION).digest()
}

/** Broker-issued opaque reference in the real system (ADR 0010/0014) — fixed placeholder here, never a bearer token. */
export const FAKE_EXECUTION_GRANT_REF = 'fake-no-broker-execution-grant'

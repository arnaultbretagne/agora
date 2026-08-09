import { createHash, randomUUID } from 'node:crypto'
import type { AgentRuntimeDefinition, CustodyFormat } from '@agora/agent-registry'
import type pg from 'pg'
import { captureSnapshot } from '@agora/custody'

export interface CapturedRef {
  readonly snapshotId: string
  readonly sessionId: string
  readonly generation: number
  readonly captureRequestId: string
  readonly formatId: string
  readonly formatVersion: string
  readonly adapterVersion: string
  readonly syncedThroughSeq: number
  readonly sha256: string
  readonly sizeBytes: number
  readonly createdAt: string
}

export class CustodyCaptureError extends Error {
  constructor(
    readonly code: 'session_not_ready' | 'capture_transport_failed',
    message: string,
  ) {
    super(message)
    this.name = 'CustodyCaptureError'
  }
}

/** docs/specs/07 "Capture contract" step 2: "stream with a configured maximum size and timeout." */
const CAPTURE_TIMEOUT_MS = 30_000

/** `GET .../custody` on the fake Agent's own HTTP listener — direct Pod reach, the same pattern `handleOpenAcpConnection` already uses for the ACP bridge. `maxBytes` is the registry's own `AgentRuntimeDefinition.custody.maxBytes`, never a value this package invents. */
async function fetchNativeStateBytes(podIp: string, port: number, maxBytes: number): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(`http://${podIp}:${port}/custody`, { signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS) })
  } catch (error) {
    throw new CustodyCaptureError('capture_transport_failed', `could not reach Session Runtime Pod for capture: ${String(error)}`)
  }
  if (!response.ok) throw new CustodyCaptureError('capture_transport_failed', `Pod /custody returned ${response.status}`)

  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (declaredLength > maxBytes) {
    throw new CustodyCaptureError('capture_transport_failed', `Pod /custody declared ${declaredLength} bytes, exceeding the ${maxBytes}-byte capture limit`)
  }

  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new CustodyCaptureError('capture_transport_failed', `Pod /custody exceeded the ${maxBytes}-byte capture limit while streaming`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/**
 * docs/specs/07 "Capture contract". Idempotent by `(sessionId, captureRequestId)` — a retry
 * returns the SAME already-committed snapshot without touching the Pod again (steps 1-3, "capture
 * retry cannot allocate two generations for one request id"). A transport failure while fetching
 * bytes throws before any row is written — "a capture error leaves no ready partial snapshot" and
 * the Pod is never touched destructively (this function never deletes/restarts it).
 */
export async function captureCustody(
  custodyPool: pg.Pool,
  input: {
    readonly sessionId: string
    readonly captureRequestId: string
    readonly syncedThroughSeq: number
    readonly podIp: string
    readonly bridgePort: number
    /** The RESOLVED definition for the Session's own Agent — `custody.writeFormat`/`driverId`/`maxBytes` are never invented here. */
    readonly definition: AgentRuntimeDefinition
    readonly now?: () => Date
  },
): Promise<CapturedRef> {
  const now = input.now ?? (() => new Date())

  const existingClient = await custodyPool.connect()
  try {
    const { rows } = await existingClient.query<{
      id: string
      generation: number
      format_id: string
      format_version: string
      adapter_version: string
      synced_through_seq: number
      payload_sha256: Buffer
      size_bytes: number
      created_at: Date
    }>(
      `SELECT id, generation, format_id, format_version, adapter_version, synced_through_seq, payload_sha256, size_bytes, created_at
       FROM custody.snapshots WHERE session_id = $1 AND capture_request_id = $2`,
      [input.sessionId, input.captureRequestId],
    )
    const existing = rows[0]
    if (existing) {
      return {
        snapshotId: existing.id,
        sessionId: input.sessionId,
        generation: existing.generation,
        captureRequestId: input.captureRequestId,
        formatId: existing.format_id,
        formatVersion: existing.format_version,
        adapterVersion: existing.adapter_version,
        syncedThroughSeq: existing.synced_through_seq,
        sha256: existing.payload_sha256.toString('hex'),
        sizeBytes: existing.size_bytes,
        createdAt: existing.created_at.toISOString(),
      }
    }
  } finally {
    existingClient.release()
  }

  const { formatId, formatVersion } = input.definition.custody.writeFormat
  const adapterVersion = input.definition.custody.driverId

  // Bytes are fetched BEFORE the transaction opens: a transport failure must leave no DB trace at all.
  const payload = await fetchNativeStateBytes(input.podIp, input.bridgePort, input.definition.custody.maxBytes)

  const client = await custodyPool.connect()
  try {
    await client.query('BEGIN')
    // Advisory, transaction-scoped: `agora_custody_runtime` has no UPDATE grant on product.sessions
    // (metadata SELECT only), so a real row lock there is not an option — this serializes generation
    // allocation per Session without needing any additional grant.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.sessionId])
    const { rows: genRows } = await client.query<{ next_generation: number }>(
      'SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation FROM custody.snapshots WHERE session_id = $1',
      [input.sessionId],
    )
    const generation = genRows[0]?.next_generation ?? 1
    const snapshotId = randomUUID()
    const createdAt = now()
    await captureSnapshot(client, {
      snapshotId,
      sessionId: input.sessionId,
      generation,
      captureRequestId: input.captureRequestId,
      formatId,
      formatVersion,
      adapterVersion,
      syncedThroughSeq: input.syncedThroughSeq,
      payload,
      createdAt,
    })
    await client.query('COMMIT')

    return {
      snapshotId,
      sessionId: input.sessionId,
      generation,
      captureRequestId: input.captureRequestId,
      formatId,
      formatVersion,
      adapterVersion,
      syncedThroughSeq: input.syncedThroughSeq,
      sha256: createHash('sha256').update(payload).digest('hex'),
      sizeBytes: payload.length,
      createdAt: createdAt.toISOString(),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export interface RestoreSourceMetadata {
  readonly snapshotId: string
  readonly sessionId: string
  readonly formatId: string
  readonly formatVersion: string
  readonly invalidatedAt: Date | null
}

/** docs/specs/07 "Restore contract" steps 1-3, run BEFORE the Pod is even created — an invalid `restoreFrom` never produces a Pod. */
export async function checkRestoreSource(custodyPool: pg.Pool, snapshotId: string): Promise<RestoreSourceMetadata | undefined> {
  const client = await custodyPool.connect()
  try {
    const { rows } = await client.query<{ session_id: string; format_id: string; format_version: string; invalidated_at: Date | null }>(
      'SELECT session_id, format_id, format_version, invalidated_at FROM custody.snapshots WHERE id = $1',
      [snapshotId],
    )
    const row = rows[0]
    if (!row) return undefined
    return { snapshotId, sessionId: row.session_id, formatId: row.format_id, formatVersion: row.format_version, invalidatedAt: row.invalidated_at }
  } finally {
    client.release()
  }
}

/** docs/specs/07 "Restore contract" step 3: "validates format/adapter compatibility" — against the registry's OWN declared `readFormats`, never a hardcoded assumption. */
export function isReadableFormat(readFormats: readonly CustodyFormat[], formatId: string, formatVersion: string): boolean {
  return readFormats.some((f) => f.formatId === formatId && f.formatVersion === formatVersion)
}

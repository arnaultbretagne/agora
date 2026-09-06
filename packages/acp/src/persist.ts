// persist = validate → append the acp.envelope fact → commit. The raw frame text is the canonical
// value, bound as `$n::jsonb` — never parsed and reserialized (ADR 0004, findings §1). Only after
// this resolves is the frame forwarded; a failure stalls the stream instead.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { appendFact } from '@agora/journal'
import { classifyMessage } from './classify.js'
import { frameDigest, type Direction } from './framing.js'
import { losslessParse } from './lossless.js'
import { validateAcpMessage } from './validate.js'
import { recordDiagnostic } from './diagnostics.js'

export type FrameDirection = Direction

export interface PersistOptions {
  readonly workstreamId: string
  readonly sessionId: string
  readonly connectionId: string
  readonly nowSql?: string
  /** Outbound requests carry the command dispatch they belong to (prompts, cancels). */
  readonly commandIdFor: (direction: Direction, method: string | null) => string | null
}

/** In-flight outbound requests by (opposite direction, rpc id) so responses find their method. */
export function createCorrelator() {
  const requests = new Map<string, string>()
  const idKey = (direction: Direction, id: unknown): string => `${direction}:${JSON.stringify(id ?? null)}`
  return {
    noteRequest(direction: Direction, id: unknown, method: string): void {
      requests.set(idKey(direction, id), method)
    },
    correlatedMethod(direction: Direction, id: unknown): string | null {
      const opposite: Direction = direction === 'client_to_agent' ? 'agent_to_client' : 'client_to_agent'
      return requests.get(idKey(opposite, id)) ?? null
    },
  }
}

export type PersistFrameFn = (direction: Direction, frameText: string) => Promise<{ readonly seq: number; readonly observationId: string }>

export function createPersist(client: pg.PoolClient, options: PersistOptions): PersistFrameFn {
  const nowSql = options.nowSql ?? 'now()'
  const correlator = createCorrelator()
  return async (direction: Direction, frameText: string): Promise<{ seq: number; observationId: string }> => {
    // One transaction per frame: validate + fact commit together, before the frame is forwarded.
    await client.query('BEGIN')
    // Lossless scan first: an unsafe numeric inbound id is rejected with a diagnostic, never
    // captured (findings §1 — the TypeScript SDK cannot faithfully echo it).
    let parsed: ReturnType<typeof losslessParse>
    try {
      parsed = losslessParse(frameText)
    } catch {
      await recordDiagnostic(client, options.workstreamId, { direction, errorClass: 'invalid_json', size: frameText.length, digest: frameDigest(new TextEncoder().encode(frameText)) }, { nowSql })
      await client.query('COMMIT')
      throw new Error('acp_protocol_error:invalid_json')
    }
    const classification = classifyMessage(parsed.value)
    const correlatedMethod = classification.kind === 'response' ? correlator.correlatedMethod(direction, classification.requestId) : null
    const verdict = validateAcpMessage({
      direction,
      payload: parsed.value,
      kind: classification.kind,
      method: classification.method,
      correlatedMethod,
      unsafeIds: parsed.unsafeNumbers.filter((pointer) => pointer === '$/id'),
    })
    if (!verdict.canonical) {
      await recordDiagnostic(client, options.workstreamId, { direction, errorClass: verdict.errorClass, size: frameText.length, digest: frameDigest(new TextEncoder().encode(frameText)) }, { nowSql })
      await client.query('COMMIT')
      throw new Error(`acp_protocol_error:${verdict.errorClass}`)
    }
    if (classification.kind === 'request' && classification.method !== null) {
      correlator.noteRequest(direction, classification.requestId, classification.method)
    }

    const observationId = randomUUID()
    const appended = await appendFact(
      client,
      options.workstreamId,
      {
        sessionId: options.sessionId,
        kind: 'acp.envelope',
        payloadRawText: frameText,
        acp: {
          direction,
          rpcKind: classification.kind as 'request' | 'response' | 'notification',
          method: classification.method,
          correlatedMethod,
          rpcId: classification.requestId,
          commandId: options.commandIdFor(direction, classification.method) ?? null,
          connectionId: options.connectionId,
          observationId,
          frameSize: Buffer.byteLength(frameText, 'utf8'),
        },
      },
      { nowSql },
    )
    await client.query('COMMIT')
    return { seq: appended.seq, observationId }
  }
}

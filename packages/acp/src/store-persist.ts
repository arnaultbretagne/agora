import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { appendEvent, type EventPurpose, type IngestMode } from '@agora/store-pg'
import { classifyMessage } from './classify.js'
import type { Direction, PersistFrame } from './journaling-stream.js'

export interface CreateStorePersistOptions {
  readonly pool: pg.Pool
  readonly workstreamId: string
  readonly sessionId: string
}

export interface StorePersist {
  readonly persist: PersistFrame
  /**
   * docs/specs/04 "Prompt correlation": "the projector associates updates with the single
   * in-flight prompt turn". ACP v1 allows only one prompt turn per Session at a time, so a
   * mutable "current in-flight command" is correct and simpler than trying to correlate via
   * async context — an `AsyncLocalStorage` scope set around the OUTBOUND `session/prompt` request
   * does NOT survive to the INBOUND `session/update` notifications that request triggers: those
   * are delivered through the stream's own pull-driven read loop, a separate async chain (proven
   * empirically while building this — the first cut left every inbound update's `command_id`
   * NULL). Call with `undefined` to clear once the turn settles.
   */
  setInFlightCommand(commandId: string | undefined, purpose: EventPurpose | undefined): void
  /** docs/specs/05 ingest modes: `load_replay` tags a `session/load` replay window; default `live`. */
  setIngestMode(mode: IngestMode): void
}

/**
 * Builds the `PersistFrame` callback that commits raw ACP frames to the real canonical journal
 * (packages/store-pg's `appendEvent`) before they reach the wire (outbound) or the SDK (inbound).
 *
 * Deliberately does NOT run full ACP method-schema validation (the spike's `validateACPMessage`)
 * — out of this plan's scope; see plans/03-acp-session-coordinator.md Evidence. `batch`/`invalid`
 * classifications (stable v1 forbids batches; malformed JSON-RPC shapes) are not appended to the
 * journal — there is no `rpc_kind` for them — but the frame still forwards, so the SDK's own
 * protocol-level rejection still happens.
 */
export function createStorePersist(options: CreateStorePersistOptions): StorePersist {
  let inFlightCommandId: string | undefined
  let inFlightPurpose: EventPurpose | undefined
  let ingestMode: IngestMode = 'live'

  const persist: PersistFrame = async (direction: Direction, frameText: string): Promise<void> => {
    const payload: unknown = JSON.parse(frameText)
    const classification = classifyMessage(payload)
    if (classification.kind === 'batch' || classification.kind === 'invalid') return

    const client = await options.pool.connect()
    try {
      // exactOptionalPropertyTypes: omit `method`/`commandId` entirely rather than set `undefined`.
      const method = classification.kind === 'response' ? null : classification.method
      await appendEvent(client, {
        eventId: randomUUID(),
        workstreamId: options.workstreamId,
        sessionId: options.sessionId,
        direction,
        rpcKind: classification.kind,
        // DB CHECK: rpc_kind='response' requires method IS NULL (contracts/database/001-initial.sql).
        ...(method ? { method } : {}),
        rpcId: classification.requestId,
        envelope: frameText,
        ...(inFlightCommandId ? { commandId: inFlightCommandId } : {}),
        purpose: inFlightPurpose ?? 'protocol',
        ingestMode,
        observedAt: new Date(),
      })
    } finally {
      client.release()
    }
  }

  return {
    persist,
    setInFlightCommand(commandId, purpose) {
      inFlightCommandId = commandId
      inFlightPurpose = purpose
    },
    setIngestMode(mode) {
      ingestMode = mode
    },
  }
}

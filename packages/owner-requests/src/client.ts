// OwnerClient: the engine-side transport handle for one owner. `submit` sends an already-reserved
// request and classifies the transport outcome — a lost or ambiguous exchange resolves to `unknown`
// and stays that way until recovery finds the truth (CONT-005/ENGINE-008 shape at the owner
// boundary). The client carries no database state; engine/attempts.ts owns the reservation.
import type { OwnerRequest, OwnerResponse } from './protocol.js'

export interface Submitted {
  readonly request: OwnerRequest
  readonly response: OwnerResponse
}

export type OwnerTransport = (request: OwnerRequest) => Promise<OwnerResponse>

export class OwnerClient {
  constructor(private readonly transport: OwnerTransport) {}

  /**
   * Sends one request. `onLost` is invoked when the transport throws (crash, network loss): the
   * engine records `unknown` — the owner may or may not have accepted.
   */
  async submit(request: OwnerRequest, onLost?: (error: unknown) => void): Promise<Submitted> {
    try {
      const response = await this.transport(request)
      return { request, response }
    } catch (error) {
      onLost?.(error)
      return { request, response: { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) } }
    }
  }
}

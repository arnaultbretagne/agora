// The bridge token a Session can actually connect with, renewed when the stored one is spent (P4).
//
// runtime-control mints one at gate release and it lives an hour; a Session does not end when it
// expires. Left as it was, a Workstream simply became unreachable: the Pod's bridge answered
// `403 expired`, the probe read that as disconnected, `SESSION-002` selected RESTORE, and RESTORE
// reused the same dead token — three live Workstreams restored themselves about once a second for
// two hours against Pods that were healthy throughout.
//
// Renewal belongs at the two places a token is taken out of the Session row and used: the
// observation read that precedes every verb in a tick (so START/RESTORE/SET_MODEL/REFILL, which
// re-read the row, get the fresh one), and the prompt channel — which is NOT preceded by a tick.
// A converged Workstream does not tick at all, so a prompt arriving after an hour of quiet is
// exactly the case that would otherwise fail, and it is the one a person notices.
import type pg from 'pg'
import { bridgeTokenNeedsRenewal } from '@agora/acp'
import { recordBridgeToken } from '@agora/journal'

export interface BridgeTokenRenewal {
  readonly productPool: pg.Pool
  readonly runtimeControlBaseUrl: string
  /** Per-call deadline, as fetch options. Absent means unbounded, which only a test should choose. */
  readonly fetchInit?: { readonly signal?: AbortSignal }
  readonly logger?: (message: string) => void
}

/**
 * Returns a token good enough to start work with, renewing and persisting it first when the stored
 * one is spent — or `null` when it cannot be renewed, which is a fact about the Pod (gone, not
 * running, no incarnation) and must never be guessed past.
 */
export async function usableBridgeToken(
  options: BridgeTokenRenewal,
  workstreamId: string,
  session: { readonly sessionId: string; readonly bridgeToken: string | null },
  incarnation: string | null,
): Promise<string | null> {
  if (!bridgeTokenNeedsRenewal(session.bridgeToken)) return session.bridgeToken
  if (incarnation === null) return null
  try {
    const res = await fetch(`${options.runtimeControlBaseUrl}/v1/workstreams/${workstreamId}/incarnations/${incarnation}/bridge-token`, {
      ...(options.fetchInit ?? {}),
      method: 'POST',
    })
    if (!res.ok) {
      options.logger?.(`bridge token renewal for session ${session.sessionId} refused: HTTP ${String(res.status)}`)
      return null
    }
    const renewed = ((await res.json()) as { bridgeToken?: unknown }).bridgeToken
    if (typeof renewed !== 'string') return null
    const client = await options.productPool.connect()
    try {
      await client.query('SET ROLE agora_product')
      await recordBridgeToken(client, session.sessionId, renewed)
    } finally {
      await client.query('RESET ROLE').catch(() => {})
      client.release()
    }
    options.logger?.(`bridge token renewed for session ${session.sessionId}`)
    return renewed
  } catch (error) {
    options.logger?.(`bridge token renewal for session ${session.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

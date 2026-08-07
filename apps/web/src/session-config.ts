import type * as acp from '@agentclientprotocol/sdk'
import { setSessionConfigOption } from '@agora/acp'
import {
  listSessionConfigIntent,
  markSessionConfigIntentApplied,
  putAgentConfigCatalogue,
  putSessionConfigIntent,
  type ConfigOptionValue,
} from '@agora/store-pg'
import type pg from 'pg'

/**
 * P12 — the operator's configuration choices, kept where a Pod's death cannot take them.
 *
 * ACP config options live on a running Session, which is why the product surface used to lose them
 * twice: a conversation that has not started yet has no Session to ask, and a suspended one has no
 * Runtime to ask. The durable half is `product.session_config_intent` — what the operator wants —
 * and this module is the seam that turns it into real `session/set_config_option` calls at the two
 * moments a connection exists again: bootstrap and resume.
 *
 * Intent is desired state, not a queue: it is re-asserted on every resume rather than consumed, so
 * a conversation stays on the model it was set to instead of quietly reverting to the harness
 * default the next time its Pod is replaced.
 */

export interface RequestedConfigOption {
  readonly optionId: string
  readonly value: ConfigOptionValue
}

/** Records what the operator asked for, from a launch envelope or from a live change. Values are the Agent's own — nothing here validates them, because only the Agent can (docs/specs/04). */
export async function recordConfigIntent(
  pool: pg.Pool,
  sessionId: string,
  requested: readonly RequestedConfigOption[],
  at: Date,
): Promise<void> {
  if (requested.length === 0) return
  const client = await pool.connect()
  try {
    for (const option of requested) {
      await putSessionConfigIntent(client, { sessionId, optionId: option.optionId, value: option.value, requestedAt: at })
    }
  } finally {
    client.release()
  }
}

export interface AppliedConfigIntent {
  readonly optionId: string
  readonly value: ConfigOptionValue
  readonly rejection?: string
}

/**
 * Sends every pending choice to the Agent, in the order they were asked for.
 *
 * Only options that are not already applied are sent: a resume re-asserts what the last connection
 * never got to deliver, but a value the Agent already accepted on THIS connection is not re-sent on
 * every subsequent turn.
 *
 * A refusal is recorded and the next option is still attempted. The Agent is authoritative about
 * what it accepts, and an option that no longer exists (a harness upgrade dropped a model) must not
 * stop a conversation from starting — the client will show whatever the Agent actually reports.
 */
export async function applyConfigIntent(input: {
  readonly pool: pg.Pool
  readonly sessionId: string
  readonly connection: acp.ClientConnection
  readonly acpSessionId: string
  readonly now: () => Date
  /** Re-send even values already marked applied — used after a resume, where the Agent is a NEW process that never saw them. */
  readonly reassertApplied?: boolean
}): Promise<readonly AppliedConfigIntent[]> {
  const readClient = await input.pool.connect()
  let pending
  try {
    const all = await listSessionConfigIntent(readClient, input.sessionId)
    pending = input.reassertApplied ? all : all.filter((intent) => intent.appliedAt === null)
  } finally {
    readClient.release()
  }
  if (pending.length === 0) return []

  const outcomes: AppliedConfigIntent[] = []
  for (const intent of pending) {
    try {
      await setSessionConfigOption({
        connection: input.connection,
        acpSessionId: input.acpSessionId,
        optionId: intent.optionId,
        value: intent.value,
      })
      const client = await input.pool.connect()
      try {
        await markSessionConfigIntentApplied(client, {
          sessionId: input.sessionId,
          optionId: intent.optionId,
          value: intent.value,
          appliedAt: input.now(),
        })
      } finally {
        client.release()
      }
      outcomes.push({ optionId: intent.optionId, value: intent.value })
    } catch (error) {
      outcomes.push({ optionId: intent.optionId, value: intent.value, rejection: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}

/**
 * Records what an Agent advertised, so the NEXT conversation's composer has a list before any
 * Runtime exists. Best-effort by construction: a live Session must never fail because a cache write
 * did (`apps/web/src/config-catalogue.ts` documents the whole mechanism).
 */
export async function rememberAdvertisedOptions(
  pool: pg.Pool,
  input: { readonly agentId: string; readonly runtimeDefinitionVersion: string; readonly options: unknown; readonly observedAt: Date },
): Promise<void> {
  try {
    const client = await pool.connect()
    try {
      await putAgentConfigCatalogue(client, input)
    } finally {
      client.release()
    }
  } catch (error) {
    process.stderr.write(`session-config: could not record advertised options for ${input.agentId}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

import type { PoolClient } from 'pg'

/**
 * The two durable halves of session configuration (P12), neither of which is a product-owned model
 * list: what the harness said it offers (`product.agent_config_catalogue`) and what the operator
 * asked for (`product.session_config_intent`). docs/specs/04 permits exactly this — "the product MAY
 * cache them for selection but MUST validate changes against the current negotiated state" — and the
 * validation half stays where it always was: the Agent itself, which is still the only thing that
 * ever accepts or refuses a value.
 */

/** One advertised option, verbatim as the Agent published it, minus `currentValue` (see `putAgentConfigCatalogue`). */
export type AdvertisedConfigOption = Record<string, unknown>

export interface AgentConfigCatalogue {
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly options: readonly AdvertisedConfigOption[]
  readonly observedAt: Date
}

/**
 * Strips `currentValue` from every advertised option.
 *
 * A `currentValue` is one Session's live state — in the catalogue's case, whichever Session happened
 * to advertise last, which is usually somebody else's. Publishing it as the pre-launch default would
 * both leak one operator's choice to another and misrepresent what a fresh Session actually starts
 * on, which only the Agent decides and only its own `session/new` response reports.
 */
function withoutCurrentValue(options: readonly unknown[]): readonly AdvertisedConfigOption[] {
  const stripped: AdvertisedConfigOption[] = []
  for (const option of options) {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) continue
    const { currentValue: _currentValue, ...rest } = option as Record<string, unknown>
    stripped.push(rest)
  }
  return stripped
}

/**
 * Records what an Agent advertised. Called with the `session/new` response's own `configOptions`,
 * and with the full set an Agent hands back from `session/set_config_option` (it returns all of
 * them, because changing one may change the others).
 *
 * An empty or non-array advertisement is NOT written: an Agent that advertises nothing must leave
 * the previous memo alone rather than replace it with an empty list, which the client would read as
 * "this harness offers no choices" instead of "this frame carried none".
 */
export async function putAgentConfigCatalogue(
  client: PoolClient,
  input: {
    readonly agentId: string
    readonly runtimeDefinitionVersion: string
    readonly options: unknown
    readonly observedAt: Date
  },
): Promise<boolean> {
  if (!Array.isArray(input.options)) return false
  const options = withoutCurrentValue(input.options)
  if (options.length === 0) return false
  await client.query(
    `INSERT INTO product.agent_config_catalogue (agent_id, runtime_definition_version, options, observed_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (agent_id, runtime_definition_version) DO UPDATE SET
       options = EXCLUDED.options,
       observed_at = EXCLUDED.observed_at
     WHERE product.agent_config_catalogue.observed_at <= EXCLUDED.observed_at`,
    [input.agentId, input.runtimeDefinitionVersion, JSON.stringify(options), input.observedAt],
  )
  return true
}

export async function getAgentConfigCatalogue(
  client: PoolClient,
  agentId: string,
  runtimeDefinitionVersion: string,
): Promise<AgentConfigCatalogue | undefined> {
  const { rows } = await client.query<{ agent_id: string; runtime_definition_version: string; options: unknown[]; observed_at: Date }>(
    `SELECT agent_id, runtime_definition_version, options, observed_at
     FROM product.agent_config_catalogue
     WHERE agent_id = $1 AND runtime_definition_version = $2`,
    [agentId, runtimeDefinitionVersion],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    agentId: row.agent_id,
    runtimeDefinitionVersion: row.runtime_definition_version,
    options: row.options as readonly AdvertisedConfigOption[],
    observedAt: row.observed_at,
  }
}

/** A `select` option carries a value id, a `boolean` option carries a state — ACP's own union, kept as one. */
export type ConfigOptionValue = string | boolean

export interface SessionConfigIntent {
  readonly optionId: string
  readonly value: ConfigOptionValue
  readonly requestedAt: Date
  readonly appliedAt: Date | null
}

/**
 * Records the operator's desired value for one option on one Session.
 *
 * `applied_at` resets to NULL on every fresh request, including one that repeats the current value:
 * "applied" is a statement about the last successful `session/set_config_option`, and a value that
 * has been asked for again has not been sent again yet.
 */
export async function putSessionConfigIntent(
  client: PoolClient,
  input: { readonly sessionId: string; readonly optionId: string; readonly value: ConfigOptionValue; readonly requestedAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO product.session_config_intent (session_id, option_id, value, requested_at, applied_at)
     VALUES ($1, $2, $3::jsonb, $4, NULL)
     ON CONFLICT (session_id, option_id) DO UPDATE SET
       value = EXCLUDED.value,
       requested_at = EXCLUDED.requested_at,
       applied_at = NULL`,
    [input.sessionId, input.optionId, JSON.stringify(input.value), input.requestedAt],
  )
}

export async function listSessionConfigIntent(client: PoolClient, sessionId: string): Promise<readonly SessionConfigIntent[]> {
  const { rows } = await client.query<{ option_id: string; value: ConfigOptionValue; requested_at: Date; applied_at: Date | null }>(
    `SELECT option_id, value, requested_at, applied_at
     FROM product.session_config_intent
     WHERE session_id = $1
     ORDER BY requested_at, option_id`,
    [sessionId],
  )
  return rows.map((row) => ({ optionId: row.option_id, value: row.value, requestedAt: row.requested_at, appliedAt: row.applied_at }))
}

/**
 * Forgets one recorded choice — used when the Agent itself refuses the value.
 *
 * Scoped to the exact value for the same reason `markSessionConfigIntentApplied` is: a refusal is
 * asynchronous, and it must not delete a newer choice the operator made while it was in flight. A
 * refused value must not survive, or every future resume would re-assert something the Agent has
 * already said it will not accept.
 */
export async function deleteSessionConfigIntent(
  client: PoolClient,
  sessionId: string,
  optionId: string,
  value: ConfigOptionValue,
): Promise<void> {
  await client.query('DELETE FROM product.session_config_intent WHERE session_id = $1 AND option_id = $2 AND value = $3::jsonb', [
    sessionId,
    optionId,
    JSON.stringify(value),
  ])
}

/**
 * Marks an intent as really delivered to the Agent — and only the exact value that was delivered.
 *
 * The value is part of the WHERE clause because applying is asynchronous: an operator who changes
 * the model again while the previous change is in flight must not have the newer intent marked
 * applied by the older call's success.
 */
export async function markSessionConfigIntentApplied(
  client: PoolClient,
  input: { readonly sessionId: string; readonly optionId: string; readonly value: ConfigOptionValue; readonly appliedAt: Date },
): Promise<void> {
  await client.query(
    `UPDATE product.session_config_intent
     SET applied_at = $4
     WHERE session_id = $1 AND option_id = $2 AND value = $3::jsonb`,
    [input.sessionId, input.optionId, JSON.stringify(input.value), input.appliedAt],
  )
}

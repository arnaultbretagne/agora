// Attached and effective inventories as a consistent pair (002 Observation — exact grant
// comparison; S7 Step 3). OneCLI exposes no version/cursor on grants (apps/broker/README.md: no
// ETag, immediate effect) — a mutation can straddle two reads. The bracket is attached → effective
// → attached; only when the two attached reads agree is the effective read from between them
// trusted as belonging to that same attached state. A read that never settles within the budget
// produces no set (engine.md ENGINE-013: reacquire, never fabricate equality).
import type { Authorization } from '@agora/domain'
import type { AgentGrantConnection, AgentGrants, EffectiveCredentials, OneCliClient } from './onecli/client.js'

export interface ConsistentInventory {
  readonly attached: ReadonlySet<Authorization>
  readonly effective: ReadonlySet<Authorization>
}

export async function readConsistentInventory(
  client: OneCliClient,
  agentId: string,
  maxAttempts = 3,
  onTiming?: (message: string) => void,
): Promise<ConsistentInventory | undefined> {
  // Three OneCLI calls minimum — grants, effective credentials, grants again — and up to seven when
  // the two grant reads disagree and the loop retries. Each is a round trip to a third-party service
  // with its own database, and this whole thing runs inside every reconciliation tick AND every
  // prompt's admission check. Measured from the control plane: 106 ms when it settles first time,
  // 492 ms when it does not. That variance IS the retry, and the spans say so rather than implying
  // it: without them, "the broker is slow" and "the broker read three times" look identical.
  const started = Date.now()
  const spans: string[] = []
  const timed = async <T>(what: string, work: Promise<T>): Promise<T> => {
    const from = Date.now()
    try {
      return await work
    } finally {
      spans.push(`${what}=${String(Date.now() - from)}ms`)
    }
  }
  const report = (outcome: string): void => {
    onTiming?.(`onecli inventory for ${agentId} ${outcome} in ${String(Date.now() - started)}ms (${spans.join(' ')})`)
  }

  let before = await timed('grants', client.getAgentGrants(agentId))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const effective = await timed(`effective#${String(attempt + 1)}`, client.getEffectiveCredentials(agentId))
    const after = await timed(`grants#${String(attempt + 1)}`, client.getAgentGrants(agentId))
    if (grantsEqual(before, after)) {
      report(`settled after ${String(attempt + 1)} attempt(s)`)
      return { attached: normalizeAttached(after), effective: normalizeEffective(after, effective) }
    }
    before = after
  }
  report('never settled')
  return undefined
}

function grantsEqual(a: AgentGrants, b: AgentGrants): boolean {
  return stableStringify(a.connections) === stableStringify(b.connections) && stableStringify(a.secrets) === stableStringify(b.secrets)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function normalizeAttached(grants: AgentGrants): ReadonlySet<Authorization> {
  const authorizations: Authorization[] = []
  for (const secret of grants.secrets) {
    authorizations.push({ kind: 'secret', credential: secret.secretId, tools: 'full', approval: 'unconditional', restrictions: [] })
  }
  for (const connection of grants.connections) {
    authorizations.push(...connectionAuthorizations(connection))
  }
  return new Set(authorizations)
}

function connectionAuthorizations(connection: AgentGrantConnection): readonly Authorization[] {
  if (connection.access === 'full') {
    return [{ kind: 'connection', credential: connection.connectionId, tools: 'full', approval: 'unconditional', restrictions: [] }]
  }
  const authorizations: Authorization[] = []
  if (connection.allow.length > 0) authorizations.push({ kind: 'connection', credential: connection.connectionId, tools: new Set(connection.allow), approval: 'unconditional', restrictions: [] })
  if (connection.ask.length > 0) authorizations.push({ kind: 'connection', credential: connection.connectionId, tools: new Set(connection.ask), approval: 'required', restrictions: [] })
  return authorizations
}

/**
 * The effective view (S7 first cut): OneCLI's per-agent `effective-credentials` reports usability
 * per credential (organization policy applied) but not a per-tool breakdown — that lives on
 * `getEffectiveAppPermissions`/`getConnectionEffectiveAgents`, not yet wired here. A `usable`
 * credential is trusted at the SAME tool granularity as what is attached; anything else
 * (`limited`/`blocked`/`none`/absent) contributes nothing. This under-detects a per-tool
 * restriction (CAPS-004 fires at the whole-connection granularity, not per tool) — an explicit,
 * documented limitation, not a silent gap.
 */
export function normalizeEffective(attachedGrants: AgentGrants, effective: EffectiveCredentials): ReadonlySet<Authorization> {
  const usable = new Set([...effective.secrets, ...effective.connections].filter((c) => c.status === 'usable').map((c) => c.id))
  const attached = normalizeAttached(attachedGrants)
  return new Set([...attached].filter((authorization) => usable.has(authorization.credential)))
}

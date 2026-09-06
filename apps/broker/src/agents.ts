// Agent lifecycle bound to one Pod incarnation (ADR 0009; S7 Step 2): one selective Agent per
// incarnation, created ungranted, never rebound to another incarnation, deleted on retirement.
// Naming is deterministic from the incarnation so a lost creation is rediscoverable by identifier
// (OneCLI identifiers accept hyphens only, apps/broker/README.md) — the exact shape S6's
// create_pod already established for reserved-target correlation.
import { createHash } from 'node:crypto'
import type { HttpError, OneCliAgent, OneCliClient } from './onecli/client.js'

export function agentIdentifierFor(incarnation: string): string {
  return `agora-${createHash('sha256').update(incarnation).digest('hex').slice(0, 40)}`
}

/** Creates the Agent for this incarnation, or discovers the one a lost response already created. */
export async function ensureAgent(client: OneCliClient, incarnation: string): Promise<OneCliAgent> {
  const identifier = agentIdentifierFor(incarnation)
  try {
    const created = await client.createAgent(identifier, identifier)
    return { id: created.id, name: created.name, identifier: created.identifier, isDefault: false, createdAt: created.createdAt }
  } catch (error) {
    if ((error as HttpError).status === 409) {
      const existing = await findByIdentifier(client, identifier)
      if (existing !== undefined) return existing
    }
    throw error
  }
}

/** Deletes the incarnation's Agent if one was ever created. Never throws on "already gone". */
export async function retireAgent(client: OneCliClient, incarnation: string): Promise<void> {
  const identifier = agentIdentifierFor(incarnation)
  const existing = await findByIdentifier(client, identifier)
  if (existing !== undefined) await client.deleteAgent(existing.id)
}

async function findByIdentifier(client: OneCliClient, identifier: string): Promise<OneCliAgent | undefined> {
  // No get-by-identifier endpoint exists (apps/broker/README.md) — list and filter client-side.
  const agents = await client.listAgents()
  return agents.find((agent) => agent.identifier === identifier)
}

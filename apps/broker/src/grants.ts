// GRANT and REVOKE (003 verbs; S7 Step 4). The owner request's payload carries the complete exact
// desired grant set compiled for one policy revision — GRANT attaches only what attached/effective
// don't already cover, preserving rights shared by other desired capabilities; REVOKE narrows or
// detaches every attached/effective excess. OneCLI's connection grant is one PUT per connection (one
// combined access/allow/ask body, never additive) — both verbs operate per credential, not per
// Authorization entry, so an unconditional subset and a gated subset on the same connection land in
// one call.
import { equals, type Authorization, type GrantKind } from '@agora/domain'
import type { ConnectionGrantInput, OneCliClient } from './onecli/client.js'
import { normalizeAttached } from './inventory.js'

function groupByCredential(set: ReadonlySet<Authorization>): Map<string, Authorization[]> {
  const map = new Map<string, Authorization[]>()
  for (const authorization of set) {
    const key = `${authorization.kind}:${authorization.credential}`
    const list = map.get(key)
    if (list === undefined) map.set(key, [authorization])
    else list.push(authorization)
  }
  return map
}

function splitKey(key: string): { kind: GrantKind; credential: string } {
  const separator = key.indexOf(':')
  return { kind: key.slice(0, separator) as GrantKind, credential: key.slice(separator + 1) }
}

function toConnectionGrantInput(entries: readonly Authorization[]): ConnectionGrantInput {
  if (entries.some((e) => e.tools === 'full')) return { access: 'full' }
  const allow = entries.filter((e) => e.approval === 'unconditional').flatMap((e) => [...(e.tools as ReadonlySet<string>)])
  const ask = entries.filter((e) => e.approval === 'required').flatMap((e) => [...(e.tools as ReadonlySet<string>)])
  return { access: 'custom', allow, ask }
}

/** Attaches every credential in `desired` not already attached in exactly that shape. Never touches a credential absent from `desired` — that is REVOKE's job. */
export async function attachDesiredGrants(client: OneCliClient, agentId: string, desired: ReadonlySet<Authorization>): Promise<void> {
  const attached = normalizeAttached(await client.getAgentGrants(agentId))
  const desiredByCredential = groupByCredential(desired)
  const attachedByCredential = groupByCredential(attached)
  for (const [key, entries] of desiredByCredential) {
    const current = attachedByCredential.get(key) ?? []
    if (equals(new Set(current), new Set(entries))) continue // already exactly this — GRANT never appends broader defaults
    const { kind, credential } = splitKey(key)
    if (kind === 'secret') await client.setAgentSecretGrant(agentId, credential)
    else await client.setAgentConnectionGrant(agentId, credential, toConnectionGrantInput(entries))
  }
}

/** Narrows or detaches every attached credential `desired` does not name in exactly that shape. Never attaches anything new — that is GRANT's job. */
export async function revokeExcessGrants(client: OneCliClient, agentId: string, desired: ReadonlySet<Authorization>): Promise<void> {
  const attached = normalizeAttached(await client.getAgentGrants(agentId))
  const desiredByCredential = groupByCredential(desired)
  const attachedByCredential = groupByCredential(attached)
  for (const [key, entries] of attachedByCredential) {
    const { kind, credential } = splitKey(key)
    const desiredEntries = desiredByCredential.get(key)
    if (desiredEntries === undefined) {
      if (kind === 'secret') await client.removeAgentSecretGrant(agentId, credential)
      else await client.removeAgentConnectionGrant(agentId, credential)
      continue
    }
    if (kind === 'connection' && !equals(new Set(entries), new Set(desiredEntries))) {
      await client.setAgentConnectionGrant(agentId, credential, toConnectionGrantInput(desiredEntries))
    }
    // secrets are all-or-nothing (002/OneCLI): present in both desired and attached needs no narrowing.
  }
}

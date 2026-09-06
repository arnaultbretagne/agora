// Resolves a catalogue's stable credentialRef (a Secret's `type`, a Connection's `provider` —
// contracts/catalogue/grant-mappings.json, apps/broker/README.md) to the live OneCLI id this
// project actually has configured. Never a static catalogue value: secretId/connectionId are
// per-project runtime state, assigned by OneCLI itself when the operator configures a credential.
import type { CredentialResolver } from '@agora/policy'
import type { OneCliClient } from './client.js'

export class OneCliCredentialResolver implements CredentialResolver {
  #secrets: Map<string, string> | undefined
  #connections: Map<string, string> | undefined

  constructor(private readonly client: OneCliClient) {}

  async refresh(): Promise<void> {
    const [secrets, connections] = await Promise.all([this.client.listSecrets(), this.client.listConnections()])
    // Ambiguity (two secrets of the same type, two connections of the same provider) is a
    // reviewed-deployment error, not something this resolver silently picks a winner for.
    this.#secrets = uniqueBy(secrets, (s) => s.type)
    this.#connections = uniqueBy(connections, (c) => c.provider)
  }

  resolveSecret(ref: string): string | undefined {
    return this.#secrets?.get(ref)
  }

  resolveConnection(ref: string): string | undefined {
    return this.#connections?.get(ref)
  }
}

function uniqueBy<T extends { readonly id: string }>(items: readonly T[], keyOf: (item: T) => string): Map<string, string> {
  const seen = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) ambiguous.add(key)
    else seen.set(key, item.id)
  }
  for (const key of ambiguous) seen.delete(key) // ambiguous → unresolvable, never a guessed pick
  return seen
}

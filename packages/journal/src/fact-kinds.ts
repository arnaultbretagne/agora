// Loader for contracts/schemas/fact-kinds.json (the registry contract). A kind must be registered
// there before appendFact accepts it: registering the kind, its payload schema and its grounding
// is the "before coding" precondition of the slice that introduces it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface RegisteredKind {
  readonly kind: string
  readonly sessionScoped: boolean
  readonly payloadSchema: string
  readonly grounding: string
}

interface FactKindsContract {
  readonly kinds: readonly RegisteredKind[]
}

const REGISTRY_PATH = fileURLToPath(new URL('../../../../contracts/schemas/fact-kinds.json', import.meta.url))

const contract = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as FactKindsContract

const BY_KIND = new Map<string, RegisteredKind>(contract.kinds.map((entry) => [entry.kind, entry]))

export function isRegisteredKind(kind: string): boolean {
  return BY_KIND.has(kind)
}

export function isSessionScopedKind(kind: string): boolean {
  return BY_KIND.get(kind)?.sessionScoped === true
}

export function registeredKinds(): readonly string[] {
  return [...BY_KIND.keys()]
}

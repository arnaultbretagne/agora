// The reviewed capability catalogue (001 Intent — Capability compilation; S7 Step 1). Every right,
// including model/provider invocation, has a reviewed named mapping — nothing here is inferred at
// compile time. Loading is the only place these files are parsed; the compiler only ever sees the
// validated, digest-bound view.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ApprovalRequirement, GrantKind, Restriction } from '@agora/domain'

export interface GrantMappingEntry {
  readonly kind: GrantKind
  /** The OneCLI field the trusted resolver matches against — never a live secretId/connectionId. */
  readonly credentialRef: string
  readonly tools: readonly string[] | 'full'
  readonly approval: ApprovalRequirement
  readonly restrictions?: readonly Restriction[]
}

export interface CapabilityCatalogue {
  /** SHA-256 of the canonical (key-sorted) content of both reviewed files — the compiled output's provenance. */
  readonly revisionId: string
  readonly capabilities: ReadonlySet<string>
  grantsFor(capabilityId: string): readonly GrantMappingEntry[] | undefined
}

interface CapabilitiesFile {
  readonly capabilities: readonly { readonly id: string; readonly description: string }[]
}

interface GrantMappingsFile {
  readonly mappings: Record<string, readonly GrantMappingEntry[]>
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export class UnmappedCapabilityError extends Error {
  readonly code = 'unmapped_capability'
  constructor(readonly capabilityId: string) {
    super(`capability "${capabilityId}" is registered but has no entry in grant-mappings.json`)
    this.name = 'UnmappedCapabilityError'
  }
}

/** Loads and cross-validates both reviewed files: every registered capability must have a mapping, and vice versa. */
export function loadCapabilityCatalogue(capabilitiesPath: string, grantMappingsPath: string): CapabilityCatalogue {
  const capabilitiesRaw = readFileSync(capabilitiesPath, 'utf8')
  const grantMappingsRaw = readFileSync(grantMappingsPath, 'utf8')
  const capabilitiesFile = JSON.parse(capabilitiesRaw) as CapabilitiesFile
  const grantMappingsFile = JSON.parse(grantMappingsRaw) as GrantMappingsFile

  const capabilities = new Set(capabilitiesFile.capabilities.map((c) => c.id))
  for (const id of capabilities) {
    if (grantMappingsFile.mappings[id] === undefined) throw new UnmappedCapabilityError(id)
  }
  for (const id of Object.keys(grantMappingsFile.mappings)) {
    if (!capabilities.has(id)) throw new Error(`grant-mappings.json maps "${id}", which is not registered in capabilities.json`)
  }

  const revisionId = createHash('sha256')
    .update(stableStringify({ capabilities: capabilitiesFile, mappings: grantMappingsFile }))
    .digest('hex')

  return {
    revisionId,
    capabilities,
    grantsFor: (capabilityId) => grantMappingsFile.mappings[capabilityId],
  }
}

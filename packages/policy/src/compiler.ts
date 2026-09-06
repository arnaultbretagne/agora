// The trusted capability compiler (001 Intent — Capability compilation; ADR 0010; S7 Step 1).
// Consumes the complete capability set under one reviewed catalogue revision and the principal's
// permitted credential bindings; produces one exact non-secret desired OneCLI grant set, or a typed
// denial. It resolves nothing from Browser input and emits no image, MCP registration or egress
// policy — those belong to other owners.
import type { Authorization, GrantKind } from '@agora/domain'
import type { CapabilityCatalogue, GrantMappingEntry } from './catalogue.js'

/** Resolves a catalogue's stable credentialRef (a Secret's `type`, a Connection's `provider`) to
 * the live OneCLI id for this deployment. Never a static catalogue value (secretId/connectionId
 * are per-project runtime state) — apps/broker's onecli client supplies the real implementation. */
export interface CredentialResolver {
  resolveSecret(ref: string): string | undefined
  resolveConnection(ref: string): string | undefined
}

export type CompileDenialReason = 'unknown_capability' | 'unresolvable_credential' | 'unrepresentable_combination' | 'approval_unavailable'

export interface CompileDenial {
  readonly kind: 'denied'
  readonly reason: CompileDenialReason
  readonly detail: string
}

export interface CompileSuccess {
  readonly kind: 'compiled'
  readonly grants: ReadonlySet<Authorization>
  readonly revisionId: string
}

export type CompileResult = CompileSuccess | CompileDenial

export interface CompileOptions {
  /** False when this deployment has no human-in-the-loop path for an `ask` tool (execution.md). */
  readonly approvalSupported?: boolean
}

interface ResolvedEntry extends GrantMappingEntry {
  readonly credential: string
}

export function compile(capabilityIds: readonly string[], catalogue: CapabilityCatalogue, resolver: CredentialResolver, options: CompileOptions = {}): CompileResult {
  const approvalSupported = options.approvalSupported ?? true
  const uniqueIds = [...new Set(capabilityIds)]

  const resolved: ResolvedEntry[] = []
  for (const id of uniqueIds) {
    if (!catalogue.capabilities.has(id)) {
      return { kind: 'denied', reason: 'unknown_capability', detail: `capability "${id}" is not in the reviewed catalogue` }
    }
    const entries = catalogue.grantsFor(id) ?? []
    for (const entry of entries) {
      const credential = entry.kind === 'secret' ? resolver.resolveSecret(entry.credentialRef) : resolver.resolveConnection(entry.credentialRef)
      if (credential === undefined) {
        return { kind: 'denied', reason: 'unresolvable_credential', detail: `capability "${id}" needs ${entry.kind} "${entry.credentialRef}", which this project has not configured in OneCLI` }
      }
      if (entry.approval === 'required' && !approvalSupported) {
        return { kind: 'denied', reason: 'approval_unavailable', detail: `capability "${id}" requires per-call approval, which this deployment cannot serve` }
      }
      resolved.push({ ...entry, credential })
    }
  }

  const byCredential = new Map<string, ResolvedEntry[]>()
  for (const entry of resolved) {
    const key = `${entry.kind}:${entry.credential}`
    const bucket = byCredential.get(key)
    if (bucket === undefined) byCredential.set(key, [entry])
    else bucket.push(entry)
  }

  const grants = new Set<Authorization>()
  for (const entries of byCredential.values()) {
    const merged = mergeOneCredential(entries)
    if (merged.kind === 'denied') return merged
    for (const authorization of merged.authorizations) grants.add(authorization)
  }

  return { kind: 'compiled', grants, revisionId: catalogue.revisionId }
}

type MergeResult = { readonly kind: 'merged'; readonly authorizations: readonly Authorization[] } | CompileDenial

/**
 * Unions the rights every selected capability grants over ONE credential before any difference is
 * computed (001 Intent). OneCLI's own grant is one connection PUT with one `access` mode: a
 * blanket `full`/unconditional right and a separately gated (`required`) right on the same
 * credential cannot both be represented — full access silently bypasses the gate the other
 * capability asked for. That combination is rejected rather than silently resolved either way.
 */
function mergeOneCredential(entries: readonly ResolvedEntry[]): MergeResult {
  const kind: GrantKind = entries[0]!.kind
  const credential = entries[0]!.credential
  const restrictions = entries[0]!.restrictions ?? []

  let unconditionalTools: ReadonlySet<string> | 'full' = new Set()
  let requiredTools: ReadonlySet<string> | 'full' = new Set()
  for (const entry of entries) {
    if (entry.approval === 'unconditional') unconditionalTools = unionTools(unconditionalTools, entry.tools)
    else requiredTools = unionTools(requiredTools, entry.tools)
  }

  const conflict = (): CompileDenial => ({
    kind: 'denied',
    reason: 'unrepresentable_combination',
    detail: `credential "${credential}" is granted unconditionally by one capability and gated behind approval by another for an overlapping (or, without a full tool catalogue, unprovable-disjoint) set of tools`,
  })

  if (unconditionalTools === 'full' && requiredTools === 'full') return conflict()
  if (unconditionalTools === 'full') {
    if ((requiredTools as ReadonlySet<string>).size > 0) return conflict()
    return { kind: 'merged', authorizations: [{ kind, credential, tools: 'full', approval: 'unconditional', restrictions }] }
  }
  if (requiredTools === 'full') {
    if ((unconditionalTools as ReadonlySet<string>).size > 0) return conflict()
    return { kind: 'merged', authorizations: [{ kind, credential, tools: 'full', approval: 'required', restrictions }] }
  }

  // Both sides are explicit, finite tool sets: an unconditional grant always wins the overlap —
  // once a tool is unconditionally allowed, gating it too would ask for approval that never fires.
  const gatedTools = new Set([...requiredTools].filter((t) => !(unconditionalTools as ReadonlySet<string>).has(t)))
  const authorizations: Authorization[] = []
  if ((unconditionalTools as ReadonlySet<string>).size > 0) authorizations.push({ kind, credential, tools: unconditionalTools, approval: 'unconditional', restrictions })
  if (gatedTools.size > 0) authorizations.push({ kind, credential, tools: gatedTools, approval: 'required', restrictions })
  if (authorizations.length === 0) {
    // Every entry for this credential named an empty tool list — nothing to grant is itself a
    // reviewed mapping error, not a silent no-op.
    return { kind: 'denied', reason: 'unrepresentable_combination', detail: `credential "${credential}" has no tool named across the requested capabilities` }
  }
  return { kind: 'merged', authorizations }
}

function unionTools(a: ReadonlySet<string> | 'full', b: readonly string[] | 'full'): ReadonlySet<string> | 'full' {
  if (a === 'full' || b === 'full') return 'full'
  return new Set([...a, ...b])
}

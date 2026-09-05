export type GrantKind = 'secret' | 'connection'

export type ApprovalRequirement = 'unconditional' | 'required'

export interface Restriction {
  readonly kind: string
  readonly value: unknown
}

export interface Authorization {
  readonly kind: GrantKind
  readonly credential: string
  readonly tools: ReadonlySet<string> | 'full'
  readonly approval: ApprovalRequirement
  readonly restrictions: readonly Restriction[]
  readonly opaque?: Readonly<Record<string, unknown>>
}

export type RestrictionInclusionProof = (narrower: Restriction, broader: Restriction) => boolean

export interface GrantComparisonContext {
  readonly toolCatalogue?: ReadonlySet<string>
  readonly provesInclusion?: RestrictionInclusionProof
}

export function authorizationKey(authorization: Authorization): string {
  return `${authorization.kind}:${authorization.credential}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function opaqueEquals(a: Authorization, b: Authorization): boolean {
  if (a.opaque === undefined && b.opaque === undefined) {
    return true
  }
  if (a.opaque === undefined || b.opaque === undefined) {
    return false
  }
  return stableStringify(a.opaque) === stableStringify(b.opaque)
}

function approvalIncludes(broader: ApprovalRequirement, narrower: ApprovalRequirement): boolean {
  return broader === 'unconditional' || broader === narrower
}

function expandTools(tools: ReadonlySet<string> | 'full', context: GrantComparisonContext): ReadonlySet<string> | 'full' {
  if (tools !== 'full' || context.toolCatalogue === undefined) {
    return tools
  }
  return context.toolCatalogue
}

function toolsInclude(broader: ReadonlySet<string> | 'full', narrower: ReadonlySet<string> | 'full', context: GrantComparisonContext): boolean {
  const expandedBroader = expandTools(broader, context)
  const expandedNarrower = expandTools(narrower, context)
  if (expandedBroader === 'full') {
    return true
  }
  if (expandedNarrower === 'full') {
    return false
  }
  for (const tool of expandedNarrower) {
    if (!expandedBroader.has(tool)) {
      return false
    }
  }
  return true
}

function restrictionImpliesNarrower(narrower: Restriction, broader: Restriction, context: GrantComparisonContext): boolean {
  if (narrower.kind !== broader.kind) {
    return false
  }
  if (context.provesInclusion !== undefined) {
    return context.provesInclusion(narrower, broader)
  }
  return stableStringify(narrower.value) === stableStringify(broader.value)
}

function restrictionsInclude(broader: readonly Restriction[], narrower: readonly Restriction[], context: GrantComparisonContext): boolean {
  for (const requiredRestriction of broader) {
    const proven = narrower.some((candidate) => restrictionImpliesNarrower(candidate, requiredRestriction, context))
    if (!proven) {
      return false
    }
  }
  return true
}

export function includes(broader: Authorization, narrower: Authorization, context: GrantComparisonContext = {}): boolean {
  if (broader.kind !== narrower.kind || broader.credential !== narrower.credential) {
    return false
  }
  if (!opaqueEquals(broader, narrower)) {
    return false
  }
  if (!approvalIncludes(broader.approval, narrower.approval)) {
    return false
  }
  if (!toolsInclude(broader.tools, narrower.tools, context)) {
    return false
  }
  return restrictionsInclude(broader.restrictions, narrower.restrictions, context)
}

function includedByAny(narrower: Authorization, broaderSet: ReadonlySet<Authorization>, context: GrantComparisonContext): boolean {
  for (const broader of broaderSet) {
    if (includes(broader, narrower, context)) {
      return true
    }
  }
  return false
}

export function isSubset(narrower: ReadonlySet<Authorization>, broader: ReadonlySet<Authorization>, context: GrantComparisonContext = {}): boolean {
  for (const entry of narrower) {
    if (!includedByAny(entry, broader, context)) {
      return false
    }
  }
  return true
}

export function equals(left: ReadonlySet<Authorization>, right: ReadonlySet<Authorization>, context: GrantComparisonContext = {}): boolean {
  return isSubset(left, right, context) && isSubset(right, left, context)
}

export function excess(observed: ReadonlySet<Authorization>, desired: ReadonlySet<Authorization>, context: GrantComparisonContext = {}): readonly Authorization[] {
  return [...observed].filter((entry) => !includedByAny(entry, desired, context))
}

export function grantUnion(...sets: readonly ReadonlySet<Authorization>[]): ReadonlySet<Authorization> {
  const union = new Set<Authorization>()
  for (const set of sets) {
    for (const entry of set) {
      union.add(entry)
    }
  }
  return union
}

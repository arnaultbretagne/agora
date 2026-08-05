import type { EquipmentRequest } from '@agora/domain'
import { EQUIPMENT_CATALOGUE_VERSION, findCatalogueAccessLevel } from './catalogue.js'
import { sha256Hex, stableStringify } from './digest.js'
import { buildMcpServerDescriptor, type SafeMcpServerDescriptor } from './mcp-servers.js'

export const EQUIPMENT_POLICY_VERSION = 'equipment-policy-v1'

export interface CapabilityFact {
  readonly capabilityId: string
  readonly accessLevel: string
  readonly constraints: Readonly<Record<string, unknown>>
}

export interface PolicyContext {
  readonly principalId: string
  readonly workstreamCategory: 'discussion' | 'invocation'
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
}

export interface ResolvedPolicy {
  readonly policyVersion: string
  readonly capabilityDigest: string
  readonly capabilities: readonly CapabilityFact[]
  readonly mcpServers: readonly SafeMcpServerDescriptor[]
}

export type PolicyDenialCode =
  | 'catalogue_version_unknown'
  | 'duplicate_resource'
  | 'unknown_resource_or_access'
  | 'invocation_write_access_denied'

export class PolicyDenialError extends Error {
  constructor(
    readonly code: PolicyDenialCode,
    message: string,
  ) {
    super(message)
    this.name = 'PolicyDenialError'
  }
}

/**
 * docs/specs/10-equipment-and-broker.md "Policy resolution" + "No combined profiles": every check
 * here runs BEFORE any OneCLI mutation (required test: "Unknown/contradictory equipment intent is
 * denied before OneCLI mutation") — this function has no OneCLI dependency at all, so that
 * ordering is structural, not a runtime discipline someone could get wrong. Capability facts are
 * independent rows, never named combination profiles; two requests for the same
 * resources/access/Agent/category always resolve to the SAME digest regardless of principal.
 */
export function resolveEquipmentPolicy(request: EquipmentRequest, context: PolicyContext): ResolvedPolicy {
  if (request.catalogueVersion !== EQUIPMENT_CATALOGUE_VERSION) {
    throw new PolicyDenialError(
      'catalogue_version_unknown',
      `requested catalogueVersion '${request.catalogueVersion}' does not match the current catalogue '${EQUIPMENT_CATALOGUE_VERSION}'`,
    )
  }

  const seenResources = new Set<string>()
  for (const item of request.resources) {
    if (seenResources.has(item.resource)) {
      throw new PolicyDenialError('duplicate_resource', `resource '${item.resource}' requested more than once — a request contains at most one entry per resource`)
    }
    seenResources.add(item.resource)

    if (!findCatalogueAccessLevel(item.resource, item.access)) {
      throw new PolicyDenialError('unknown_resource_or_access', `'${item.resource}'/'${item.access}' is not in catalogue '${EQUIPMENT_CATALOGUE_VERSION}'`)
    }

    // A minimal, real "operator rule" (docs/specs/10 "Policy resolution" evaluates "operator
    // rules"): an `invocation` Workstream (one-shot, unattended) never gets write-capable
    // equipment — a durable `discussion` Workstream is required for that. This is illustrative of
    // the enforcement hook, not a claim that it is the ONLY rule a real deployment would need.
    if (context.workstreamCategory === 'invocation' && (item.access === 'read-write' || item.access === 'propose')) {
      throw new PolicyDenialError(
        'invocation_write_access_denied',
        `'invocation' Workstreams cannot request write-capable access ('${item.resource}'/'${item.access}')`,
      )
    }
  }

  const capabilities: CapabilityFact[] = [...request.resources]
    .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0))
    .map((item) => ({ capabilityId: item.resource, accessLevel: item.access, constraints: Object.freeze({ ...(item.scope ?? {}) }) }))

  const mcpServers = capabilities.map(buildMcpServerDescriptor)

  const digestInput = {
    policyVersion: EQUIPMENT_POLICY_VERSION,
    agentId: context.agentId,
    runtimeDefinitionVersion: context.runtimeDefinitionVersion,
    workstreamCategory: context.workstreamCategory,
    capabilities,
  }
  const capabilityDigest = sha256Hex(stableStringify(digestInput))

  return Object.freeze({
    policyVersion: EQUIPMENT_POLICY_VERSION,
    capabilityDigest,
    capabilities: Object.freeze(capabilities),
    mcpServers: Object.freeze(mcpServers),
  })
}

/**
 * docs/specs/10-equipment-and-broker.md "Equipment request": the Broker-authoritative safe
 * resource-intent vocabulary — versioned, never provider OAuth scopes/tokens/endpoints/OneCLI
 * rules. Matches `contracts/schemas/equipment-catalogue.schema.json` exactly (proven by a fixture
 * test loading the real schema, not a hand-copy).
 *
 * Two resources, matching the spec's own example — real tool/data equipment (Vault, GitHub) is
 * genuinely useful to prove the whole grant/policy/relay pipeline end to end, but no MCP server
 * BACKEND for either exists in this program (no later plan builds one either); this catalogue is
 * the descriptor/policy seam only, not a claim that Vault/GitHub access actually works yet.
 */
export const EQUIPMENT_CATALOGUE_VERSION = 'equipment-v1'

export interface CatalogueAccessLevel {
  readonly access: string
  readonly label: string
  readonly description?: string
}

export interface CatalogueResource {
  readonly resource: string
  readonly label: string
  readonly description: string
  readonly accessLevels: readonly CatalogueAccessLevel[]
}

export interface EquipmentCatalogue {
  readonly version: string
  readonly resources: readonly CatalogueResource[]
}

export function getEquipmentCatalogue(): EquipmentCatalogue {
  return Object.freeze({
    version: EQUIPMENT_CATALOGUE_VERSION,
    resources: Object.freeze([
      Object.freeze({
        resource: 'vault',
        label: 'Vault',
        description: 'Read or read-write access to the Workstream secret vault.',
        accessLevels: Object.freeze([
          Object.freeze({ access: 'read', label: 'Read' }),
          Object.freeze({ access: 'read-write', label: 'Read and write' }),
        ]),
      }),
      Object.freeze({
        resource: 'github',
        label: 'GitHub',
        description: 'Read repository content, or propose changes via pull request.',
        accessLevels: Object.freeze([
          Object.freeze({ access: 'read', label: 'Read' }),
          Object.freeze({ access: 'propose', label: 'Propose changes' }),
        ]),
      }),
    ]),
  })
}

export function findCatalogueAccessLevel(resource: string, access: string): CatalogueAccessLevel | undefined {
  const found = getEquipmentCatalogue().resources.find((r) => r.resource === resource)
  return found?.accessLevels.find((a) => a.access === access)
}

import type { CapabilityFact } from './resolve.js'

/** Mirrors the ACP SDK's `McpServerHttp` shape (packages/equipment-policy has no ACP SDK
 * dependency — this is a structural, hand-verified mirror, matching how packages/session-runtime-
 * control mirrors the OpenAPI contract without importing the OpenAPI tooling). */
export interface SafeMcpServerDescriptor {
  readonly type: 'http'
  readonly name: string
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}

const BROKER_MCP_BASE_URL = 'https://broker.internal/mcp'

/**
 * docs/specs/10 "MCP servers": descriptors "contain no provider secret", "contain no execution-
 * grant, relay or OneCLI token/header", "point to Broker-controlled endpoints or trusted
 * credential-free shims". No MCP server backend exists behind this URL anywhere in this program —
 * this is the descriptor/policy seam docs/specs/10 asks for, not a working Vault/GitHub
 * integration (there is no later plan that builds one either).
 */
export function buildMcpServerDescriptor(fact: CapabilityFact): SafeMcpServerDescriptor {
  return {
    type: 'http',
    name: `${fact.capabilityId}-${fact.accessLevel}`,
    url: `${BROKER_MCP_BASE_URL}/${fact.capabilityId}/${fact.accessLevel}`,
    headers: [],
  }
}

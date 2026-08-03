import { assertNoSecretPattern, SecretPatternError } from '@agora/store-pg'

/**
 * docs/specs/04-acp-integration.md "Host callbacks": "Client-provided mcpServers MUST contain no
 * execution-grant reference, OneCLI identifier, relay credential, upstream proxy bearer or
 * provider secret." Reuses store-pg's value-pattern guard (aoc_/provider-key shapes) and adds a
 * key-name denylist for the credential-carrying fields an MCP server descriptor would plausibly
 * use (auth headers, env vars) — these never legitimately belong in a Session-scoped `mcpServers`
 * descriptor sent over ACP, so any match is treated as a leak, not a false positive worth risking.
 */
const FORBIDDEN_MCP_KEYS: readonly RegExp[] = [
  /^authorization$/i,
  /^bearer$/i,
  /api[-_]?key$/i,
  /^token$/i,
  /_token$/i,
  /_key$/i,
  /_secret$/i,
  /execution[-_]?grant/i,
  /onecli/i,
]

function scanForbiddenKeys(field: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) scanForbiddenKeys(field, item)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_MCP_KEYS.some((pattern) => pattern.test(key))) {
        throw new SecretPatternError(`${field}.${key}`)
      }
      scanForbiddenKeys(field, item)
    }
  }
}

export function assertSafeMcpServers(mcpServers: readonly unknown[]): void {
  for (const [index, server] of mcpServers.entries()) {
    assertNoSecretPattern(`mcpServers[${index}]`, server)
    scanForbiddenKeys(`mcpServers[${index}]`, server)
  }
}

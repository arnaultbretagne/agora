/**
 * AGENTS.md: "Never persist bearer tokens, one-time ACP tunnel tokens or provider credentials in
 * product, projection, custody or ACP data." Canonical ACP `envelope` content is explicitly exempt
 * (spec 05: it has its own confidentiality rules — full ACP passthrough is the point of ADR 0003);
 * this guard applies only to store-pg-owned non-envelope fields: command `request` bodies and
 * journal indexing metadata (entity_kind/entity_id/transport_observation_id).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\baoc_[A-Za-z0-9_-]{8,}/, // OneCLI upstream/control bearer (ADR 0010/0014)
  /\bsk-[A-Za-z0-9_-]{8,}/, // common provider secret-key shape
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token shapes
]

export class SecretPatternError extends Error {
  readonly code = 'secret_pattern_rejected'

  constructor(field: string) {
    super(`refusing to persist ${field}: value matches a known credential/token shape`)
    this.name = 'SecretPatternError'
  }
}

function containsSecretPattern(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value))
}

/** Recursively scans a JSON-serializable value's string leaves for known secret shapes. */
export function assertNoSecretPattern(field: string, value: unknown): void {
  if (typeof value === 'string') {
    if (containsSecretPattern(value)) throw new SecretPatternError(field)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretPattern(field, item)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (containsSecretPattern(key)) throw new SecretPatternError(field)
      assertNoSecretPattern(field, item)
    }
  }
}

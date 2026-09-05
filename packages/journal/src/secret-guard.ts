// Carried over from archive/pre-design-cleanup-2026-09-05:packages/store-pg/src/secret-guard.ts
// (commit df00ca4 tree); changes: applies to the S3 non-envelope journal fields (fact payload and
// causation). The ACP envelope exemption described below arrives with S4's envelope kind, which
// this guard must never inspect.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\baoc_[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
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

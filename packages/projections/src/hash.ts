// Carried over from archive/pre-design-cleanup-2026-09-05:packages/store-pg/src/projector.ts
// (stableStringify, commit df00ca4 tree) and projections.ts (computeProjectionHash building
// block); changes: generalized to an order-independent line hash any projector can feed.
import { createHash } from 'node:crypto'

/** Deterministic across key insertion order — the same final state always hashes the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** SHA-256 over the lines, sorted first: physical row order cannot move the hash. */
export function orderIndependentHash(lines: readonly string[]): string {
  const hash = createHash('sha256')
  for (const line of [...lines].sort()) hash.update(`${line}\n`)
  return hash.digest('hex')
}

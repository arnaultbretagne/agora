// observation.grants.attached / observation.grants.effective (002 Observation; S7 Step 6). Both
// come from apps/broker's consistent-pair read (readConsistentInventory) — this package only
// wraps that outcome in the Acquired<T> shape every other observation field already uses. A read
// that never settled to a consistent pair is `unavailable`, never an empty/full guess.
import type { Acquired, Authorization } from '@agora/domain'

export function normalizeGrantsAttached(inventory: { readonly attached: ReadonlySet<Authorization> } | undefined): Acquired<ReadonlySet<Authorization>> {
  return inventory === undefined ? { ok: false, reason: 'unavailable' } : { ok: true, value: inventory.attached }
}

export function normalizeGrantsEffective(inventory: { readonly effective: ReadonlySet<Authorization> } | undefined): Acquired<ReadonlySet<Authorization>> {
  return inventory === undefined ? { ok: false, reason: 'unavailable' } : { ok: true, value: inventory.effective }
}

/**
 * Run equipment (agora ADR 0012) — the product-side half of the capability catalogue.
 *
 * The security authority is agent-runtime (`src/broker/profiles.ts`). What lives here is the
 * build-time PROJECTION it emits: labels, whether a profile takes a target, whether it is visible.
 * Never a capability list — agora must be able to NAME a profile, never to define what it can do.
 * Regenerate the projection from agent-runtime (its catalogue is the source):
 *
 *   npm run print-projection > ../agora/shared/equipment-catalogue.json
 *
 * The manager re-validates every choice and is the final authority (ADR 0012 §5), so a stale
 * projection is fail-closed: it can only ever offer a name the manager then refuses. That is also
 * why `visible` is projected but `enabled` is not — agora renders, the manager gates.
 */
import { readFileSync } from 'node:fs'

const projection = JSON.parse(readFileSync(new URL('./equipment-catalogue.json', import.meta.url), 'utf8'))

/** The floor: what a run is equipped with when nothing is named (bare API use, pre-equipment
 *  clients, historical runs read back from the migration). Always the least-privileged profile. */
export const DEFAULT_PROFILE = 'chat-v1'

export const EQUIPMENT_PROFILES = Object.freeze(projection.profiles)
export const EQUIPMENT_TARGETS = Object.freeze(projection.targets)

const byName = new Map(EQUIPMENT_PROFILES.map((p) => [p.name, p]))

/** What the browser may see and pick: visible profiles only, plus the allow-listed targets in the
 *  canonical form they must travel in. A gated profile is absent, not disabled — the UI cannot
 *  reveal what the projection does not carry. */
export function equipmentProjection() {
  return {
    profiles: EQUIPMENT_PROFILES.filter((p) => p.visible),
    targets: EQUIPMENT_TARGETS,
  }
}

/** Syntax only — the shape a GitHub target must have. Authority (allow-list, deny-list, the App's
 *  real installation) is the manager's call, deliberately not duplicated here (plan §P4.2). */
const TARGET_RE = /^github:[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/

/**
 * Validate an equipment pair before it can become a run fact. Mirrors the manager's own gate on the
 * two rules agora can honestly enforce — the profile is one the catalogue names and the browser may
 * pick, and the target's presence/syntax matches the profile — and leaves authority to the manager.
 *
 * @returns {{ok: true, equipment: {equipmentProfile: string, target: string|null}} | {ok: false, error: string}}
 */
export function checkEquipment(profileName, rawTarget) {
  const name = profileName ?? DEFAULT_PROFILE
  const profile = byName.get(name)
  if (!profile) return { ok: false, error: `unknown equipment profile: ${name}` }
  // An invisible profile is one this agora build must not let anyone select — including through a
  // hand-made API call, which is why the check lives here and not only in the UI.
  if (!profile.visible) return { ok: false, error: `equipment profile not available: ${name}` }

  const target = typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim().toLowerCase() : null
  if (profile.needsTarget && !target) return { ok: false, error: `equipment profile ${name} requires a target` }
  if (!profile.needsTarget && target) return { ok: false, error: `equipment profile ${name} takes no target` }
  if (target && !TARGET_RE.test(target)) return { ok: false, error: 'target must look like github:<owner>/<repo>' }

  return { ok: true, equipment: { equipmentProfile: name, target } }
}

/** The label pair the UI badges a run with. Falls back to the raw name for a profile this build no
 *  longer projects (a historical run of a retired profile still has to render honestly). */
export function labelOf(profileName) {
  return byName.get(profileName)?.label ?? profileName
}

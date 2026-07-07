/**
 * Execution substrate = pure platform policy, resolved per spawn (ADR 0011, superseded
 * 2026-07-06). It answers one question — "should this run be isolated (its own sandbox)
 * or shared?" — as a decision the PLATFORM makes, never one the running content can
 * influence (a sandbox whose occupant picks its own sandboxing is not a sandbox). So it
 * is deliberately NOT read from the request body: it is computed from platform config
 * alone. Today the policy is a single global default; a richer policy (per-user,
 * per-trust-level) would still be evaluated here, from platform inputs, never the caller's.
 */
export const SUBSTRATES = ['shared', 'isolated']

/** The platform default, validated once. Throws on a bad config value so a typo in
 *  AGORA_SUBSTRATE_DEFAULT fails loudly at boot, not silently at spawn. */
export function normalizeSubstrateDefault(value) {
  if (value === undefined || value === '') return 'shared'
  if (!SUBSTRATES.includes(value)) {
    throw new Error(`invalid AGORA_SUBSTRATE_DEFAULT: ${value} (must be one of: ${SUBSTRATES.join(', ')})`)
  }
  return value
}

/** Resolve the substrate for a spawn. Pure policy: today it ignores the conversation and
 *  returns the platform default. The signature takes the conversation so a future policy
 *  can key off platform-side facts about it (never off caller-supplied config). */
export function resolveSubstrate(_conv, platformDefault) {
  return platformDefault
}

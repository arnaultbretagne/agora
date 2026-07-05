/**
 * Execution substrate resolution (agora ADR 0011): platform policy at conversation birth,
 * overridable per-birth-request. Split out of server.js so it's testable without pulling in
 * its module-load side effects (DB connection, HTTP listen).
 */
export const SUBSTRATES = ['shared', 'isolated']

export class InvalidSubstrate extends Error {}

/** The request's override if valid, else the platform default. Throws InvalidSubstrate if the
 *  request named something outside SUBSTRATES. */
export function resolveSubstrate(requested, defaultSubstrate) {
  if (requested === undefined) return defaultSubstrate
  if (!SUBSTRATES.includes(requested)) {
    throw new InvalidSubstrate(`invalid substrate: ${requested} (must be one of: ${SUBSTRATES.join(', ')})`)
  }
  return requested
}

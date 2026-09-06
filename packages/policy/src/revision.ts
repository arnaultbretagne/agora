// The selected policy revision (001 Intent: "A revision is selected by trusted deployment policy,
// not by whichever worker happens to run"). Every worker in one deployment must resolve the same
// paths — env vars, not a path relative to this package's own install location, so a worker never
// silently drifts onto whatever catalogue happened to ship in its own container image.
import { loadCapabilityCatalogue, type CapabilityCatalogue } from './catalogue.js'

const DEFAULT_CAPABILITIES_PATH = '/etc/agora/capabilities.json'
const DEFAULT_GRANT_MAPPINGS_PATH = '/etc/agora/grant-mappings.json'

export function selectRevision(env: NodeJS.ProcessEnv = process.env): CapabilityCatalogue {
  return loadCapabilityCatalogue(
    env.POLICY_CAPABILITIES_PATH ?? DEFAULT_CAPABILITIES_PATH,
    env.POLICY_GRANT_MAPPINGS_PATH ?? DEFAULT_GRANT_MAPPINGS_PATH,
  )
}

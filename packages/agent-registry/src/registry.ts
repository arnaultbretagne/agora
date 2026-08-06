import type { LaunchableAgent, ListLaunchableAgentsResult, SessionRuntimeAvailability } from '@agora/session-runtime-control'
import type { AgentRuntimeDefinition, RolloutState } from './types.js'

export class AgentNotLaunchableError extends Error {
  readonly code = 'agent_not_launchable'

  constructor(agentId: string, reason: string) {
    super(`agent ${agentId} is not launchable: ${reason}`)
    this.name = 'AgentNotLaunchableError'
  }
}

function toAvailability(rollout: RolloutState): SessionRuntimeAvailability {
  if (rollout === 'deprecated') return 'deprecated'
  if (rollout === 'enabled' || rollout === 'internal') return 'enabled'
  return 'unavailable'
}

/**
 * docs/specs/09-agent-registry.md: "GET /v1/agents -> registry revision + (agent_id, exact
 * runtime-definition version, public metadata)". `disabled`/`retired` never appear — they are not
 * a rollout state a caller should be able to discover exists at all.
 */
export function selectLaunchableAgents(
  definitions: readonly AgentRuntimeDefinition[],
  registryRevision: string,
): ListLaunchableAgentsResult {
  const items: LaunchableAgent[] = definitions
    .filter((d) => d.rollout !== 'disabled' && d.rollout !== 'retired')
    .map((d) => ({
      agentId: d.agentId,
      runtimeDefinitionVersion: d.version,
      label: d.label,
      description: d.description,
      availability: toAvailability(d.rollout),
      // Reviewed personas, so the product surface can offer the same choice the OLD system did.
      // Always an array — an Agent with none yields [], which the UI reads as "hide the selector",
      // exactly the old behaviour when its own discovery came back empty.
      personas: d.personas ?? [],
    }))
  return { registryRevision, items }
}

/**
 * docs/specs/09: "Broker policy maintains a reviewed route-set mapping keyed by the exact
 * runtime-definition version" and the controller "resolves only enabled, exact registry
 * definitions" for a NEW materialization — `internal`/`deprecated` may be listed (resume, staff
 * testing) but never silently launch a new Session; a mismatch is a typed failure, never an
 * optimistic fallback to a different version.
 */
export function resolveLaunchableDefinition(
  definitions: readonly AgentRuntimeDefinition[],
  agentId: string,
  expectedRuntimeDefinitionVersion: string,
): AgentRuntimeDefinition {
  const definition = definitions.find((d) => d.agentId === agentId && d.version === expectedRuntimeDefinitionVersion)
  if (!definition) {
    throw new AgentNotLaunchableError(agentId, `no registry definition for version ${expectedRuntimeDefinitionVersion}`)
  }
  if (definition.rollout !== 'enabled') {
    throw new AgentNotLaunchableError(agentId, `rollout state '${definition.rollout}' does not allow new Sessions`)
  }
  return definition
}

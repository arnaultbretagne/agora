import { createHash } from 'node:crypto'

/**
 * docs/specs/08-session-runtime-control.md "Reconciliation": "Required labels include: Agora
 * Session ID; Agent ID; runtime-definition version; execution-grant ID, never bearer; controller
 * revision." No user-controlled label keys (docs/specs/11-security.md) — every key here is fixed.
 */
export const LABEL_SESSION_ID = 'agora.dev/session-id'
export const LABEL_AGENT_ID = 'agora.dev/agent-id'
export const LABEL_RUNTIME_DEFINITION_VERSION = 'agora.dev/runtime-definition-version'
export const LABEL_EXECUTION_GRANT_ID = 'agora.dev/execution-grant-id'
export const LABEL_CONTROLLER_REVISION = 'agora.dev/controller-revision'
export const LABEL_APP = 'agora.dev/app'
export const APP_SESSION_RUNTIME = 'session-runtime'

const NAME_SAFE = /[^a-z0-9-]/g

function sanitizeForName(id: string): string {
  return id.toLowerCase().replace(NAME_SAFE, '').slice(0, 40)
}

export function podName(sessionId: string): string {
  return `sr-${sanitizeForName(sessionId)}`
}

export function serviceAccountName(sessionId: string): string {
  return `sr-${sanitizeForName(sessionId)}`
}

/**
 * `executionGrantRef` is `writeOnly`/`x-sensitive` (contracts/openapi/session-runtime-control.yaml)
 * — the raw value MUST NOT be placed in a Pod, annotation, status object or log. This derives a
 * non-reversible, non-secret label from it so reconciliation/debugging can still correlate a Pod
 * to "which grant produced it" without the label ever being able to recover the grant itself.
 */
export function executionGrantLabel(executionGrantRef: string): string {
  return createHash('sha256').update(executionGrantRef).digest('hex').slice(0, 32)
}

export function requiredLabels(input: {
  readonly sessionId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly executionGrantRef: string
  readonly controllerRevision: string
}): Record<string, string> {
  return {
    [LABEL_APP]: APP_SESSION_RUNTIME,
    [LABEL_SESSION_ID]: input.sessionId,
    [LABEL_AGENT_ID]: input.agentId,
    [LABEL_RUNTIME_DEFINITION_VERSION]: input.runtimeDefinitionVersion,
    [LABEL_EXECUTION_GRANT_ID]: executionGrantLabel(input.executionGrantRef),
    [LABEL_CONTROLLER_REVISION]: input.controllerRevision,
  }
}

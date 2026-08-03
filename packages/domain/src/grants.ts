import type { Branded } from './ids.js'
import type { SessionId } from './ids.js'

/** One policy-resolved, auditable capability fact belonging to a Session (ADR 0010). */
export interface CapabilityGrant {
  readonly capabilityId: string
  readonly accessLevel: string
  readonly constraints: Readonly<Record<string, unknown>>
  readonly policyVersion: string
  readonly resolvedAt: Date
}

/**
 * Opaque short-lived Broker authorization reference. It is never a OneCLI control key, upstream
 * provider bearer or provider credential (ADR 0010/0014) — those stay Broker-private state and
 * never enter this package, product tables or ACP descriptors.
 */
export type ExecutionGrantReference = Branded<string, 'ExecutionGrantReference'>

export function executionGrantReference(value: string): ExecutionGrantReference {
  if (value.length === 0) throw new TypeError('ExecutionGrantReference must not be empty')
  return value as ExecutionGrantReference
}

/**
 * The transient activation a Session Runtime materialization consumes. It maps to one dedicated
 * OneCLI Agent behind the Broker boundary but never carries that identifier here.
 */
export interface ExecutionGrantActivation {
  readonly sessionId: SessionId
  readonly reference: ExecutionGrantReference
  readonly capabilityDigest: Uint8Array
  readonly expiresAt: Date
}

const REDACTED = '[redacted]'

/** For logging/serialization boundaries: never let the opaque reference reach a log line. */
export function redactExecutionGrantActivation(
  activation: ExecutionGrantActivation,
): Omit<ExecutionGrantActivation, 'reference'> & { readonly reference: typeof REDACTED } {
  return Object.freeze({ ...activation, reference: REDACTED })
}

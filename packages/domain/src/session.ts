import { DomainError } from './errors.js'
import type { SessionId, WorkstreamId } from './ids.js'

export type SessionPhase =
  | 'requested'
  | 'provisioning'
  | 'ready'
  | 'busy'
  | 'suspending'
  | 'suspended'
  | 'closing'
  | 'closed'
  | 'failed'

/**
 * Durable phase transition table (docs/specs/03-session-lifecycle.md). `failed` is reachable from
 * every non-terminal phase because an unrecoverable error can occur at any point of a Session's
 * life, not only during provisioning; `closing` only ever completes to `closed` (an explicit
 * force-close from a broken state re-enters this table as `failed`, it is not a `closing` outcome).
 */
const TRANSITIONS: Readonly<Record<SessionPhase, readonly SessionPhase[]>> = Object.freeze({
  requested: Object.freeze(['provisioning', 'failed'] as const),
  provisioning: Object.freeze(['ready', 'failed'] as const),
  ready: Object.freeze(['busy', 'suspending', 'closing', 'failed'] as const),
  busy: Object.freeze(['ready', 'suspending', 'closing', 'failed'] as const),
  suspending: Object.freeze(['suspended', 'failed'] as const),
  suspended: Object.freeze(['ready', 'closing', 'failed'] as const),
  closing: Object.freeze(['closed'] as const),
  closed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
})

export const TERMINAL_SESSION_PHASES: ReadonlySet<SessionPhase> = new Set(['closed', 'failed'])

export function canTransitionSessionPhase(from: SessionPhase, to: SessionPhase): boolean {
  return TRANSITIONS[from].includes(to)
}

export type AgentId = string

export interface EquipmentResourceRequest {
  readonly resource: string
  readonly access: string
  readonly scope?: Readonly<Record<string, unknown>>
}

/** Mirrors contracts/schemas/equipment-request.schema.json. */
export interface EquipmentRequest {
  readonly catalogueVersion: string
  readonly resources: readonly EquipmentResourceRequest[]
}

/**
 * Frozen once at Session creation (docs/specs/02 "one immutable workspace root specification").
 * Deliberately excludes any OneCLI Agent id, control key or provider credential (ADR 0010/0014).
 */
export interface SessionLaunchEnvelope {
  readonly agentId: AgentId
  readonly workspaceSpec: Readonly<Record<string, unknown>>
  readonly equipmentRequest: EquipmentRequest
  readonly runtimeDefinitionVersion: string
  /**
   * The harness persona this Session runs as (`--agent <name>` in the OLD channels-era system's
   * vocabulary). Frozen here with the rest of the envelope for the same reason `agentId` is: it is
   * a launch argument, so changing it means a different process, which means a different Session.
   * Absent = no persona, the default the old system expressed as an empty `--agent`.
   *
   * Only a name reviewed on the Agent's own registry definition (`AgentRuntimeDefinition.personas`)
   * is accepted — validated by the caller before this envelope is built, never by the Pod.
   */
  readonly persona?: string
}

export interface AcpBinding {
  readonly acpSessionId: string
  readonly boundAt: Date
}

export interface CapabilityBinding {
  readonly policyVersion: string
  readonly digest: Uint8Array
}

export interface Session {
  readonly id: SessionId
  readonly workstreamId: WorkstreamId
  readonly ordinal: number
  readonly agentId: AgentId
  readonly phase: SessionPhase
  readonly launchEnvelope: SessionLaunchEnvelope
  readonly acpBinding: AcpBinding | undefined
  readonly capabilityBinding: CapabilityBinding | undefined
}

export interface OpenSessionInput {
  readonly id: SessionId
  readonly workstreamId: WorkstreamId
  readonly ordinal: number
  readonly launchEnvelope: SessionLaunchEnvelope
}

function freezeLaunchEnvelope(envelope: SessionLaunchEnvelope): SessionLaunchEnvelope {
  return Object.freeze({
    ...envelope,
    workspaceSpec: Object.freeze({ ...envelope.workspaceSpec }),
    equipmentRequest: Object.freeze({
      ...envelope.equipmentRequest,
      resources: Object.freeze(envelope.equipmentRequest.resources.map((r) => Object.freeze({ ...r }))),
    }),
  })
}

/** A Session belongs to exactly one Workstream and one immutable Agent for its whole life. */
export function openSession(input: OpenSessionInput): Session {
  if (input.ordinal < 1) throw new DomainError('session_ordinal_invalid', 'Session ordinal must be positive')
  if (input.launchEnvelope.agentId.length === 0) {
    throw new DomainError('session_agent_id_required', 'agentId must not be empty')
  }
  return Object.freeze({
    id: input.id,
    workstreamId: input.workstreamId,
    ordinal: input.ordinal,
    agentId: input.launchEnvelope.agentId,
    phase: 'requested',
    launchEnvelope: freezeLaunchEnvelope(input.launchEnvelope),
    acpBinding: undefined,
    capabilityBinding: undefined,
  })
}

export function transitionSessionPhase(session: Session, to: SessionPhase): Session {
  if (!canTransitionSessionPhase(session.phase, to)) {
    throw new DomainError(
      TERMINAL_SESSION_PHASES.has(session.phase) ? 'terminal_session_transition' : 'illegal_session_transition',
      `Session cannot move from ${session.phase} to ${to}`,
    )
  }
  return Object.freeze({ ...session, phase: to })
}

/** `acp_session_id` is absent before binding and immutable after (docs/specs/02). */
export function bindAcpSession(session: Session, acpSessionId: string, boundAt: Date): Session {
  if (acpSessionId.length === 0) throw new DomainError('acp_binding_conflict', 'acpSessionId must not be empty')
  if (session.acpBinding) {
    throw new DomainError('acp_binding_already_bound', 'ACP Session binding is immutable once set')
  }
  return Object.freeze({ ...session, acpBinding: Object.freeze({ acpSessionId, boundAt }) })
}

/** The capability policy version and digest are bound once, before provisioning, and cannot change. */
export function bindCapabilities(session: Session, policyVersion: string, digest: Uint8Array): Session {
  if (digest.length !== 32) {
    throw new DomainError('capability_digest_invalid', 'Capability digest must be a 32-byte SHA-256 value')
  }
  if (session.capabilityBinding) {
    throw new DomainError('capability_binding_already_bound', 'Capability policy binding is immutable once set')
  }
  return Object.freeze({ ...session, capabilityBinding: Object.freeze({ policyVersion, digest }) })
}

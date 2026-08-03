import { DomainError } from './errors.js'
import { commandId, type CommandId, type PrincipalId, type SessionId, type WorkstreamId } from './ids.js'
import { nameBasedUuid } from './uuid.js'

/**
 * Fixed namespace for deriving a Command's identity from (Workstream, idempotency scope,
 * idempotency key) — see nameBasedUuid. Never reused for another purpose.
 */
const COMMAND_IDEMPOTENCY_NAMESPACE = '39c66992-d8de-4afc-921d-bb382188027f'

export type CommandActorKind = 'human' | 'service' | 'system'

export interface CommandActor {
  readonly kind: CommandActorKind
  readonly id: PrincipalId
}

export type CommandState = 'accepted' | 'dispatching' | 'acknowledged' | 'unknown' | 'completed' | 'failed'

/** docs/specs/13-failure-and-idempotency.md "Command states". */
const COMMAND_TRANSITIONS: Readonly<Record<CommandState, readonly CommandState[]>> = Object.freeze({
  accepted: Object.freeze(['dispatching', 'failed'] as const),
  dispatching: Object.freeze(['acknowledged', 'unknown', 'failed'] as const),
  acknowledged: Object.freeze(['completed', 'failed'] as const),
  unknown: Object.freeze(['completed', 'failed'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
})

export const TERMINAL_COMMAND_STATES: ReadonlySet<CommandState> = new Set(['completed', 'failed'])

export function canTransitionCommandState(from: CommandState, to: CommandState): boolean {
  return COMMAND_TRANSITIONS[from].includes(to)
}

export type DomainCommandType =
  | 'CreateWorkstream'
  | 'RenameWorkstream'
  | 'OpenSession'
  | 'ActivateSession'
  | 'PromptSession'
  | 'CancelSession'
  | 'SuspendSession'
  | 'CloseSession'
  | 'DeleteWorkstream'

export type CommandPurpose = 'user' | 'handoff'

export interface DurableCommand {
  readonly id: CommandId
  readonly type: DomainCommandType
  readonly workstreamId: WorkstreamId
  readonly sessionId: SessionId | undefined
  readonly actor: CommandActor
  readonly idempotencyScope: string
  readonly idempotencyKey: string
  readonly purpose: CommandPurpose | undefined
  readonly state: CommandState
  readonly acceptedAt: Date
}

export interface CreateCommandInput {
  readonly type: DomainCommandType
  readonly workstreamId: WorkstreamId
  readonly sessionId?: SessionId
  readonly actor: CommandActor
  readonly idempotencyScope: string
  readonly idempotencyKey: string
  readonly purpose?: CommandPurpose
  readonly acceptedAt: Date
}

/**
 * The Command's id is derived deterministically from (Workstream, idempotency scope, idempotency
 * key): an identical retry always produces the identical id, so "same key resolves to the same
 * command" holds by construction, before any store lookup (P02 additionally enforces this with a
 * UNIQUE constraint against concurrent first-writers).
 */
export function deriveCommandId(workstreamId: WorkstreamId, idempotencyScope: string, idempotencyKey: string): CommandId {
  return commandId(nameBasedUuid(COMMAND_IDEMPOTENCY_NAMESPACE, `${workstreamId}:${idempotencyScope}:${idempotencyKey}`))
}

export function createCommand(input: CreateCommandInput): DurableCommand {
  if (input.idempotencyScope.length === 0 || input.idempotencyKey.length === 0) {
    throw new DomainError('idempotency_key_required', 'Every durable command needs a non-empty idempotency scope and key')
  }
  if (input.purpose === 'handoff' && input.sessionId === undefined) {
    throw new DomainError('handoff_command_incomplete', 'A handoff command must target a Session')
  }
  return Object.freeze({
    id: deriveCommandId(input.workstreamId, input.idempotencyScope, input.idempotencyKey),
    type: input.type,
    workstreamId: input.workstreamId,
    sessionId: input.sessionId,
    actor: input.actor,
    idempotencyScope: input.idempotencyScope,
    idempotencyKey: input.idempotencyKey,
    purpose: input.purpose,
    state: 'accepted',
    acceptedAt: input.acceptedAt,
  })
}

export function transitionCommandState(command: DurableCommand, to: CommandState): DurableCommand {
  if (!canTransitionCommandState(command.state, to)) {
    throw new DomainError(
      TERMINAL_COMMAND_STATES.has(command.state) ? 'command_transition_terminal' : 'command_transition_illegal',
      `Command cannot move from ${command.state} to ${to}`,
    )
  }
  return Object.freeze({ ...command, state: to })
}

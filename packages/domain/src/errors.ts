export type DomainErrorCode =
  | 'workstream_title_invalid'
  | 'workstream_membership_duplicate'
  | 'workstream_membership_not_found'
  | 'workstream_last_owner_required'
  | 'workstream_membership_role_invalid'
  | 'current_session_workstream_mismatch'
  | 'invocation_cardinality_exceeded'
  | 'session_ordinal_invalid'
  | 'session_agent_id_required'
  | 'illegal_session_transition'
  | 'terminal_session_transition'
  | 'acp_binding_already_bound'
  | 'acp_binding_conflict'
  | 'capability_binding_already_bound'
  | 'capability_digest_invalid'
  | 'idempotency_key_required'
  | 'handoff_command_incomplete'
  | 'command_transition_illegal'
  | 'command_transition_terminal'

/** A guard failure with a stable public code, per AGENTS.md "every failure path has a typed code". */
export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

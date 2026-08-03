import { DomainError } from './errors.js'
import type { PrincipalId, SessionId, WorkstreamId } from './ids.js'

export type WorkstreamCategory = 'discussion' | 'invocation'
export type WorkstreamMembershipRole = 'owner' | 'editor' | 'viewer'
export type WorkstreamTitleSource = 'auto' | 'user'

export interface WorkstreamMembership {
  readonly principalId: PrincipalId
  readonly role: WorkstreamMembershipRole
  readonly addedAt: Date
}

export interface Workstream {
  readonly id: WorkstreamId
  readonly category: WorkstreamCategory
  readonly title: string
  readonly titleSource: WorkstreamTitleSource
  readonly pinned: boolean
  readonly currentSessionId: SessionId | undefined
  readonly memberships: readonly WorkstreamMembership[]
}

function assertTitle(title: string): void {
  if (title.length < 1 || title.length > 200) {
    throw new DomainError('workstream_title_invalid', 'Workstream title must be 1-200 characters')
  }
}

export interface CreateWorkstreamInput {
  readonly id: WorkstreamId
  readonly category: WorkstreamCategory
  readonly title: string
  readonly owner: PrincipalId
  readonly createdAt: Date
}

/** A Workstream is always created atomically with its owner membership (see docs/specs/02). */
export function createWorkstream(input: CreateWorkstreamInput): Workstream {
  assertTitle(input.title)
  const owner: WorkstreamMembership = Object.freeze({
    principalId: input.owner,
    role: 'owner',
    addedAt: input.createdAt,
  })
  return Object.freeze({
    id: input.id,
    category: input.category,
    title: input.title,
    titleSource: 'auto',
    pinned: false,
    currentSessionId: undefined,
    memberships: Object.freeze([owner]),
  })
}

/**
 * Metadata-only update: the return type only ever changes title/titleSource, so category,
 * memberships and id are provably untouched. Titles/pinning MUST NOT alter event ordering.
 */
export function renameWorkstream(workstream: Workstream, title: string, source: WorkstreamTitleSource): Workstream {
  assertTitle(title)
  return Object.freeze({ ...workstream, title, titleSource: source })
}

export function setWorkstreamPinned(workstream: Workstream, pinned: boolean): Workstream {
  return Object.freeze({ ...workstream, pinned })
}

function ownerCount(memberships: readonly WorkstreamMembership[], excluding?: PrincipalId): number {
  return memberships.filter((m) => m.role === 'owner' && m.principalId !== excluding).length
}

/**
 * Callers MUST lock the Workstream row before calling this (see docs/specs/02 "Membership
 * mutation locks the Workstream before counting owners") so concurrent demotions/removals cannot
 * both leave zero owners; this function only proves the guard itself, not the concurrency control.
 */
export function addMembership(
  workstream: Workstream,
  principalId: PrincipalId,
  role: WorkstreamMembershipRole,
  addedAt: Date,
): Workstream {
  if (workstream.memberships.some((m) => m.principalId === principalId)) {
    throw new DomainError('workstream_membership_duplicate', 'Principal is already a Workstream member')
  }
  const membership: WorkstreamMembership = Object.freeze({ principalId, role, addedAt })
  return Object.freeze({ ...workstream, memberships: Object.freeze([...workstream.memberships, membership]) })
}

export function changeMembershipRole(
  workstream: Workstream,
  principalId: PrincipalId,
  role: WorkstreamMembershipRole,
): Workstream {
  const current = workstream.memberships.find((m) => m.principalId === principalId)
  if (!current) throw new DomainError('workstream_membership_not_found', 'Principal is not a Workstream member')
  if (current.role === 'owner' && role !== 'owner' && ownerCount(workstream.memberships, principalId) === 0) {
    throw new DomainError('workstream_last_owner_required', 'At least one owner must remain')
  }
  const memberships = workstream.memberships.map((m) =>
    m.principalId === principalId ? Object.freeze({ ...m, role }) : m,
  )
  return Object.freeze({ ...workstream, memberships: Object.freeze(memberships) })
}

export function removeMembership(workstream: Workstream, principalId: PrincipalId): Workstream {
  const current = workstream.memberships.find((m) => m.principalId === principalId)
  if (!current) throw new DomainError('workstream_membership_not_found', 'Principal is not a Workstream member')
  if (current.role === 'owner' && ownerCount(workstream.memberships, principalId) === 0) {
    throw new DomainError('workstream_last_owner_required', 'At least one owner must remain')
  }
  return Object.freeze({
    ...workstream,
    memberships: Object.freeze(workstream.memberships.filter((m) => m.principalId !== principalId)),
  })
}

/**
 * An invocation Workstream accepts exactly one user-purpose prompt turn; a discussion accepts any
 * positive number. Handoff/protocol turns never count toward this limit (docs/specs/02).
 */
export function assertPromptCardinalityAllowed(
  category: WorkstreamCategory,
  purpose: 'user' | 'handoff',
  priorUserPromptCount: number,
): void {
  if (category === 'invocation' && purpose === 'user' && priorUserPromptCount >= 1) {
    throw new DomainError(
      'invocation_cardinality_exceeded',
      'An invocation Workstream accepts exactly one user-purpose prompt turn',
    )
  }
}

/**
 * Changing the current Session is transactional at the store layer (validate → clear → set →
 * commit); this function is the pure validation step 1: the target must belong to this Workstream.
 */
export function setCurrentSession(
  workstream: Workstream,
  session: { readonly id: SessionId; readonly workstreamId: WorkstreamId },
): Workstream {
  if (session.workstreamId !== workstream.id) {
    throw new DomainError('current_session_workstream_mismatch', 'Target Session does not belong to this Workstream')
  }
  return Object.freeze({ ...workstream, currentSessionId: session.id })
}

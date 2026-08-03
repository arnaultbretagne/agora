declare const brand: unique symbol

/** Nominal wrapper preventing one opaque identifier from being passed where another is expected. */
export type Branded<Value, Tag extends string> = Value & { readonly [brand]: Tag }

export type WorkstreamId = Branded<string, 'WorkstreamId'>

export function workstreamId(value: string): WorkstreamId {
  if (value.length === 0) throw new TypeError('WorkstreamId must not be empty')
  return value as WorkstreamId
}

export type PrincipalId = Branded<string, 'PrincipalId'>

export function principalId(value: string): PrincipalId {
  if (value.length === 0) throw new TypeError('PrincipalId must not be empty')
  return value as PrincipalId
}

export type SessionId = Branded<string, 'SessionId'>

export function sessionId(value: string): SessionId {
  if (value.length === 0) throw new TypeError('SessionId must not be empty')
  return value as SessionId
}

export type CommandId = Branded<string, 'CommandId'>

export function commandId(value: string): CommandId {
  if (value.length === 0) throw new TypeError('CommandId must not be empty')
  return value as CommandId
}

export type EventId = Branded<string, 'EventId'>

export function eventId(value: string): EventId {
  if (value.length === 0) throw new TypeError('EventId must not be empty')
  return value as EventId
}

export type SnapshotId = Branded<string, 'SnapshotId'>

export function snapshotId(value: string): SnapshotId {
  if (value.length === 0) throw new TypeError('SnapshotId must not be empty')
  return value as SnapshotId
}

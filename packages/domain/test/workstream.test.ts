import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, sessionId, workstreamId } from '../src/ids.js'
import {
  addMembership,
  assertPromptCardinalityAllowed,
  createWorkstream,
  removeMembership,
  renameWorkstream,
  setCurrentSession,
} from '../src/workstream.js'
import { DomainError } from '../src/errors.js'

function freshWorkstream(category: 'discussion' | 'invocation' = 'discussion') {
  return createWorkstream({
    id: workstreamId('ws-1'),
    category,
    title: 'A title',
    owner: principalId('alice'),
    createdAt: new Date('2026-08-03T00:00:00Z'),
  })
}

test('creating a Workstream atomically grants the creator owner membership', () => {
  const ws = freshWorkstream()
  assert.equal(ws.memberships.length, 1)
  assert.equal(ws.memberships[0]?.role, 'owner')
  assert.equal(ws.memberships[0]?.principalId, 'alice')
})

test('required: invocation rejects a second user-purpose prompt turn', () => {
  assertPromptCardinalityAllowed('invocation', 'user', 0)
  assert.throws(
    () => assertPromptCardinalityAllowed('invocation', 'user', 1),
    (error: unknown) => error instanceof DomainError && error.code === 'invocation_cardinality_exceeded',
  )
})

test('required: a discussion never hits the cardinality guard', () => {
  assertPromptCardinalityAllowed('discussion', 'user', 50)
})

test('required: a handoff prompt turn never consumes invocation user cardinality', () => {
  assertPromptCardinalityAllowed('invocation', 'handoff', 1)
  assertPromptCardinalityAllowed('invocation', 'handoff', 99)
})

test('the last owner cannot be removed', () => {
  const ws = freshWorkstream()
  assert.throws(
    () => removeMembership(ws, principalId('alice')),
    (error: unknown) => error instanceof DomainError && error.code === 'workstream_last_owner_required',
  )
})

test('an owner can be removed once another owner exists', () => {
  const ws = addMembership(freshWorkstream(), principalId('bob'), 'owner', new Date())
  const after = removeMembership(ws, principalId('alice'))
  assert.equal(after.memberships.length, 1)
  assert.equal(after.memberships[0]?.principalId, 'bob')
})

test('renaming/pinning never touches category or membership', () => {
  const ws = freshWorkstream('invocation')
  const renamed = renameWorkstream(ws, 'New title', 'user')
  assert.equal(renamed.category, 'invocation')
  assert.deepEqual(renamed.memberships, ws.memberships)
  assert.equal(renamed.title, 'New title')
  assert.equal(renamed.titleSource, 'user')
})

test('setCurrentSession rejects a Session from another Workstream', () => {
  const ws = freshWorkstream()
  assert.throws(
    () => setCurrentSession(ws, { id: sessionId('s-1'), workstreamId: workstreamId('some-other-ws') }),
    (error: unknown) => error instanceof DomainError && error.code === 'current_session_workstream_mismatch',
  )
})

test('setCurrentSession accepts a Session belonging to this Workstream', () => {
  const ws = freshWorkstream()
  const after = setCurrentSession(ws, { id: sessionId('s-1'), workstreamId: ws.id })
  assert.equal(after.currentSessionId, 's-1')
})

test('a frozen Workstream cannot be mutated directly', () => {
  const ws = freshWorkstream()
  assert.throws(() => {
    // @ts-expect-error intentional violation to prove immutability at runtime
    ws.title = 'mutated'
  }, TypeError)
})

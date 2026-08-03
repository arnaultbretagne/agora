import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principalId, sessionId, workstreamId } from '../src/ids.js'
import {
  canTransitionCommandState,
  createCommand,
  deriveCommandId,
  transitionCommandState,
  type CommandState,
} from '../src/commands.js'
import { DomainError } from '../src/errors.js'

function actor() {
  return { kind: 'human' as const, id: principalId('alice') }
}

test('required: the same idempotency scope/key always resolves to the same command id', () => {
  const ws = workstreamId('ws-1')
  const a = deriveCommandId(ws, 'prompt', 'key-1')
  const b = deriveCommandId(ws, 'prompt', 'key-1')
  assert.equal(a, b)
})

test('a different idempotency key derives a different command id', () => {
  const ws = workstreamId('ws-1')
  const a = deriveCommandId(ws, 'prompt', 'key-1')
  const b = deriveCommandId(ws, 'prompt', 'key-2')
  assert.notEqual(a, b)
})

test('a different Workstream derives a different command id for the same scope/key', () => {
  const a = deriveCommandId(workstreamId('ws-1'), 'prompt', 'key-1')
  const b = deriveCommandId(workstreamId('ws-2'), 'prompt', 'key-1')
  assert.notEqual(a, b)
})

test('createCommand is fully deterministic given identical input', () => {
  const input = {
    type: 'PromptSession' as const,
    workstreamId: workstreamId('ws-1'),
    sessionId: sessionId('s-1'),
    actor: actor(),
    idempotencyScope: 'prompt',
    idempotencyKey: 'key-1',
    purpose: 'user' as const,
    acceptedAt: new Date('2026-08-03T00:00:00Z'),
  }
  assert.deepEqual(createCommand(input), createCommand(input))
})

test('an empty idempotency key is rejected', () => {
  assert.throws(
    () =>
      createCommand({
        type: 'RenameWorkstream',
        workstreamId: workstreamId('ws-1'),
        actor: actor(),
        idempotencyScope: 'rename',
        idempotencyKey: '',
        acceptedAt: new Date(),
      }),
    (error: unknown) => error instanceof DomainError && error.code === 'idempotency_key_required',
  )
})

test('a handoff command must target a Session', () => {
  assert.throws(
    () =>
      createCommand({
        type: 'PromptSession',
        workstreamId: workstreamId('ws-1'),
        actor: actor(),
        idempotencyScope: 'prompt',
        idempotencyKey: 'key-1',
        purpose: 'handoff',
        acceptedAt: new Date(),
      }),
    (error: unknown) => error instanceof DomainError && error.code === 'handoff_command_incomplete',
  )
})

test('the command state machine matches docs/specs/13-failure-and-idempotency.md', () => {
  const legal: Array<[CommandState, CommandState]> = [
    ['accepted', 'dispatching'],
    ['accepted', 'failed'],
    ['dispatching', 'acknowledged'],
    ['dispatching', 'unknown'],
    ['dispatching', 'failed'],
    ['acknowledged', 'completed'],
    ['acknowledged', 'failed'],
    ['unknown', 'completed'],
    ['unknown', 'failed'],
  ]
  for (const [from, to] of legal) assert.equal(canTransitionCommandState(from, to), true, `${from} -> ${to}`)
  assert.equal(canTransitionCommandState('completed', 'failed'), false)
  assert.equal(canTransitionCommandState('failed', 'completed'), false)
})

test('an illegal command transition fails with a typed error', () => {
  const command = createCommand({
    type: 'RenameWorkstream',
    workstreamId: workstreamId('ws-1'),
    actor: actor(),
    idempotencyScope: 'rename',
    idempotencyKey: 'key-1',
    acceptedAt: new Date(),
  })
  const completed = transitionCommandState(transitionCommandState(command, 'dispatching'), 'acknowledged')
  const done = transitionCommandState(completed, 'completed')
  assert.throws(
    () => transitionCommandState(done, 'dispatching'),
    (error: unknown) => error instanceof DomainError && error.code === 'command_transition_terminal',
  )
})

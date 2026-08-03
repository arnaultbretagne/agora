import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionId, workstreamId } from '../src/ids.js'
import {
  bindAcpSession,
  bindCapabilities,
  canTransitionSessionPhase,
  openSession,
  transitionSessionPhase,
  type SessionPhase,
} from '../src/session.js'
import { DomainError } from '../src/errors.js'

function freshSession() {
  return openSession({
    id: sessionId('s-1'),
    workstreamId: workstreamId('ws-1'),
    ordinal: 1,
    launchEnvelope: {
      agentId: 'claude-code',
      workspaceSpec: { root: '/work' },
      equipmentRequest: { catalogueVersion: '2026-08-01', resources: [] },
      runtimeDefinitionVersion: 'v3',
    },
  })
}

test('a fresh Session starts requested with no binding', () => {
  const s = freshSession()
  assert.equal(s.phase, 'requested')
  assert.equal(s.acpBinding, undefined)
  assert.equal(s.capabilityBinding, undefined)
})

test('the legal transition table matches docs/specs/03-session-lifecycle.md', () => {
  const legal: Array<[SessionPhase, SessionPhase]> = [
    ['requested', 'provisioning'],
    ['requested', 'failed'],
    ['provisioning', 'ready'],
    ['provisioning', 'failed'],
    ['ready', 'busy'],
    ['ready', 'suspending'],
    ['ready', 'closing'],
    ['busy', 'ready'],
    ['busy', 'suspending'],
    ['suspending', 'suspended'],
    ['suspending', 'failed'],
    ['suspended', 'ready'],
    ['suspended', 'closing'],
    ['closing', 'closed'],
  ]
  for (const [from, to] of legal) assert.equal(canTransitionSessionPhase(from, to), true, `${from} -> ${to}`)
})

test('required: illegal phase transitions fail with a typed error', () => {
  const s = freshSession()
  assert.throws(
    () => transitionSessionPhase(s, 'ready'),
    (error: unknown) => error instanceof DomainError && error.code === 'illegal_session_transition',
  )
})

test('required: terminal phases reject every further transition with a typed error', () => {
  let s = freshSession()
  s = transitionSessionPhase(s, 'provisioning')
  s = transitionSessionPhase(s, 'failed')
  assert.throws(
    () => transitionSessionPhase(s, 'ready'),
    (error: unknown) => error instanceof DomainError && error.code === 'terminal_session_transition',
  )
})

test('required: the Agent (via the launch envelope) cannot mutate', () => {
  const s = freshSession()
  assert.throws(() => {
    // @ts-expect-error intentional violation to prove immutability at runtime
    s.launchEnvelope.agentId = 'codex'
  }, TypeError)
  assert.equal(s.agentId, 'claude-code')
})

test('required: the Workstream binding cannot mutate', () => {
  const s = freshSession()
  assert.throws(() => {
    // @ts-expect-error intentional violation to prove immutability at runtime
    s.workstreamId = workstreamId('ws-2')
  }, TypeError)
})

test('required: the ACP Session binding cannot mutate once bound', () => {
  const s = freshSession()
  const bound = bindAcpSession(s, 'acp-123', new Date('2026-08-03T00:00:00Z'))
  assert.equal(bound.acpBinding?.acpSessionId, 'acp-123')
  assert.throws(
    () => bindAcpSession(bound, 'acp-456', new Date()),
    (error: unknown) => error instanceof DomainError && error.code === 'acp_binding_already_bound',
  )
})

test('capability binding requires an exact 32-byte digest and is immutable once bound', () => {
  const s = freshSession()
  assert.throws(
    () => bindCapabilities(s, 'policy-v1', new Uint8Array(31)),
    (error: unknown) => error instanceof DomainError && error.code === 'capability_digest_invalid',
  )
  const bound = bindCapabilities(s, 'policy-v1', new Uint8Array(32))
  assert.throws(
    () => bindCapabilities(bound, 'policy-v2', new Uint8Array(32)),
    (error: unknown) => error instanceof DomainError && error.code === 'capability_binding_already_bound',
  )
})

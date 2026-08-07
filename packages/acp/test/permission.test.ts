import assert from 'node:assert/strict'
import test from 'node:test'
import type * as acp from '@agentclientprotocol/sdk'
import { autoApprove } from '../src/coordinator.js'

/**
 * Found live 2026-08-07: `claude-code` reported "Tool use aborted" for every tool it tried,
 * including a plain `bash` call. The Client-side handler replied `cancelled` whenever no
 * `onPermissionRequest` was supplied — and nothing ever supplied one, so every permission request
 * ever made was refused. A Session Runtime runs unattended; there is nobody to ask.
 */
function request(kinds: readonly string[]): acp.RequestPermissionRequest {
  return {
    sessionId: 'sess-1' as never,
    toolCall: { toolCallId: 'call-1' } as never,
    options: kinds.map((kind, index) => ({ optionId: `opt-${index}` as never, name: kind, kind: kind as never })),
  } as acp.RequestPermissionRequest
}

test('required: a tool-permission request is approved — an unattended Session has nobody to ask', () => {
  const outcome = autoApprove(request(['allow_once', 'reject_once']))
  assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'opt-0' } })
})

test('allow_always is preferred over allow_once, purely to save round trips', () => {
  const outcome = autoApprove(request(['allow_once', 'allow_always', 'reject_once']))
  assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'opt-1' } })
})

test('an Agent offering no way to allow gets `cancelled` — inventing one would answer a question it never asked', () => {
  assert.deepEqual(autoApprove(request(['reject_once', 'reject_always'])), { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(autoApprove(request([])), { outcome: { outcome: 'cancelled' } })
})

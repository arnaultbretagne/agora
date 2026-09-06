import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyMessage } from '../src/classify.js'
import { losslessParse } from '../src/lossless.js'
import { ACP_SCHEMA_VERSION, methodDescriptors, sessionUpdateVariants, validateAcpMessage, type ValidationInput } from '../src/validate.js'

function verdict(direction: 'client_to_agent' | 'agent_to_client', text: string, unsafeIds: readonly string[] = []): ReturnType<typeof validateAcpMessage> {
  const payload = JSON.parse(text)
  const classification = classifyMessage(payload)
  return validateAcpMessage({
    direction,
    payload,
    kind: classification.kind,
    method: classification.method,
    correlatedMethod: classification.kind === 'response' ? 'session/prompt' : null,
    unsafeIds,
  })
}

test('the pinned schema exposes the expected method and discriminator counts', () => {
  assert.equal(ACP_SCHEMA_VERSION, '1.4.0')
  assert.equal(methodDescriptors.length, 74)
  assert.equal(sessionUpdateVariants.length, 15)
  for (const variant of ['agent_message_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan']) {
    assert.ok(sessionUpdateVariants.includes(variant), `${variant} must be a registered discriminator`)
  }
})

test('a standard request in its direction is canonical', () => {
  const result = verdict('client_to_agent', '{"jsonrpc":"2.0","id":"req-1","method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}')
  assert.equal(result.canonical, true)
})

test('a known method in the wrong direction is a protocol error, not an extension', () => {
  const result = verdict('agent_to_client', '{"jsonrpc":"2.0","id":"req-2","method":"session/new","params":{}}')
  assert.equal(result.canonical, false)
  if (!result.canonical) assert.equal(result.errorClass, 'wrong_direction')
})

test('a JSON-RPC batch is rejected', () => {
  const result = verdict('client_to_agent', '[{"jsonrpc":"2.0","id":1,"method":"a"}]')
  assert.equal(result.canonical, false)
  if (!result.canonical) assert.equal(result.errorClass, 'batch')
})

test('an unknown method is a valid extension', () => {
  const result = verdict('agent_to_client', '{"jsonrpc":"2.0","method":"vendor/example","params":{"opaque":true}}')
  assert.equal(result.canonical, true)
})

test('a known method with a wrong body is a protocol error', () => {
  const result = verdict('client_to_agent', '{"jsonrpc":"2.0","id":"req-3","method":"session/prompt","params":{"totallyWrong":true}}')
  assert.equal(result.canonical, false)
  if (!result.canonical) assert.equal(result.errorClass, 'method_schema')
})

test('an unsafe numeric id is rejected with a diagnostic (9007199254740993)', () => {
  const text = '{"jsonrpc":"2.0","id":9007199254740993,"method":"session/prompt","params":{"sessionId":"s","prompt":[]}}'
  const lossless = losslessParse(text)
  assert.deepEqual(lossless.unsafeNumbers, ['$/id'])
  const result = verdict('client_to_agent', text, lossless.unsafeNumbers)
  assert.equal(result.canonical, false)
  if (!result.canonical) assert.equal(result.errorClass, 'unsafe_numeric_id')
})

test('a response carries its correlated request method; an error response has no method body', () => {
  const response: ValidationInput = {
    direction: 'agent_to_client',
    payload: { jsonrpc: '2.0', id: 'req-1', result: { stopReason: 'end_turn' } },
    kind: 'response',
    method: null,
    correlatedMethod: 'session/prompt',
    unsafeIds: [],
  }
  assert.equal(validateAcpMessage(response).canonical, true)
  const errorResponse: ValidationInput = {
    direction: 'agent_to_client',
    payload: { jsonrpc: '2.0', id: 'req-1', error: { code: -32600, message: 'nope' } },
    kind: 'response',
    method: null,
    correlatedMethod: 'session/prompt',
    unsafeIds: [],
  }
  assert.equal(validateAcpMessage(errorResponse).canonical, true)
})

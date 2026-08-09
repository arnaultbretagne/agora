import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchForSessionId } from '../src/session-id-tap.js'

function frame(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(obj)}\n`)
}

test('required: session/new is identified from the correlated RESPONSE (agent-generated id), not the request', () => {
  const seen: string[] = []
  const tap = watchForSessionId((id) => seen.push(id))
  tap.observeClientToAgent(frame({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/home/node/work' } }))
  assert.deepEqual(seen, [], 'must not fire before the response carries the real sessionId')
  tap.observeAgentToClient(frame({ jsonrpc: '2.0', id: 1, result: { sessionId: 'abc-123' } }))
  assert.deepEqual(seen, ['abc-123'])
})

test('required: session/resume is identified from the REQUEST (client-supplied id), immediately', () => {
  const seen: string[] = []
  const tap = watchForSessionId((id) => seen.push(id))
  tap.observeClientToAgent(frame({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'resumed-1', cwd: '/home/node/work' } }))
  assert.deepEqual(seen, ['resumed-1'])
})

test('session/load is treated the same as resume', () => {
  const seen: string[] = []
  const tap = watchForSessionId((id) => seen.push(id))
  tap.observeClientToAgent(frame({ jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: 'loaded-1', cwd: '/home/node/work' } }))
  assert.deepEqual(seen, ['loaded-1'])
})

test('a response to an unrelated request id never fires, even if it happens to carry a sessionId-shaped field', () => {
  const seen: string[] = []
  const tap = watchForSessionId((id) => seen.push(id))
  tap.observeAgentToClient(frame({ jsonrpc: '2.0', id: 999, result: { sessionId: 'unsolicited' } }))
  assert.deepEqual(seen, [])
})

test('required: split across multiple frame calls still correlates request -> response correctly (a second, unrelated session/new does not clobber the first)', () => {
  const seen: string[] = []
  const tap = watchForSessionId((id) => seen.push(id))
  tap.observeClientToAgent(frame({ jsonrpc: '2.0', id: 'a', method: 'session/new' }))
  tap.observeClientToAgent(frame({ jsonrpc: '2.0', id: 'b', method: 'session/new' }))
  tap.observeAgentToClient(frame({ jsonrpc: '2.0', id: 'b', result: { sessionId: 'second' } }))
  tap.observeAgentToClient(frame({ jsonrpc: '2.0', id: 'a', result: { sessionId: 'first' } }))
  assert.deepEqual(seen, ['second', 'first'])
})

test('malformed/non-JSON frames are ignored, never thrown', () => {
  const tap = watchForSessionId(() => {
    throw new Error('must never fire on garbage input')
  })
  assert.doesNotThrow(() => tap.observeClientToAgent(new TextEncoder().encode('not json at all\n')))
  assert.doesNotThrow(() => tap.observeAgentToClient(new TextEncoder().encode('{"broken": \n')))
})

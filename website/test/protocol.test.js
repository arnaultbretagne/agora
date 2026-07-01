import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION, helloMsg, helloOkMsg, pushMsg, replyMsg, errMsg,
  parseChannelFrame, parseHubFrame,
} from '../../shared/protocol.js'

test('hello round-trips through the channel-frame parser', () => {
  const raw = JSON.stringify(helloMsg({ conversationId: 'c-1', token: 't' }))
  const parsed = parseChannelFrame(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.msg.type, 'hello')
  assert.equal(parsed.msg.conversationId, 'c-1')
  assert.equal(parsed.msg.v, PROTOCOL_VERSION)
})

test('reply and err round-trip; push/hello_ok round-trip hub-side', () => {
  assert.equal(parseChannelFrame(JSON.stringify(replyMsg({ text: 'hi', replyTo: 'm1' }))).ok, true)
  assert.equal(parseChannelFrame(JSON.stringify(errMsg('x', 'boom'))).ok, true)
  assert.equal(parseHubFrame(JSON.stringify(helloOkMsg())).ok, true)
  assert.equal(parseHubFrame(JSON.stringify(pushMsg({ id: 'm1', content: 'yo' }))).ok, true)
})

test('malformed frames are rejected with a reason', () => {
  assert.match(parseChannelFrame('not json').error, /invalid JSON/)
  assert.match(parseChannelFrame('42').error, /not a protocol message/)
  assert.match(parseChannelFrame('{"type":"nope"}').error, /unknown type/)
  // hello without token
  assert.match(parseChannelFrame(JSON.stringify({ type: 'hello', v: 1, conversationId: 'c' })).error, /malformed/)
  // hello with wrong protocol version
  assert.match(parseChannelFrame(JSON.stringify({ type: 'hello', v: 99, conversationId: 'c', token: 't' })).error, /malformed/)
  // push without id
  assert.match(parseHubFrame(JSON.stringify({ type: 'push', content: 'x' })).error, /malformed/)
  // direction confusion: a push is not a valid channel→hub frame
  assert.match(parseChannelFrame(JSON.stringify(pushMsg({ id: 'm', content: 'x' }))).error, /unknown type/)
})

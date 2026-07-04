import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSeedContent, computeDelta, buildDeltaSeedContent } from '../lib/seed.js'

const conv = { title: 'Ma conversation' }

test('seed carries the role-tagged history and the new message', () => {
  const history = [
    { role: 'user', text: 'Quelle est la capitale de la Bavière ?' },
    { role: 'assistant', text: 'Munich.' },
  ]
  const seed = buildSeedContent(conv, history, [{ text: 'Et sa population ?' }])
  assert.match(seed, /^\[conversation resumed\]/)
  assert.match(seed, /<history>/)
  assert.match(seed, /\[user\] Quelle est la capitale/)
  assert.match(seed, /\[assistant\] Munich\./)
  assert.match(seed, /<\/history>/)
  assert.match(seed, /\[user\] Et sa population \?$/)
  // history stays inside the tags; the new turn stays outside
  const inside = seed.slice(seed.indexOf('<history>'), seed.indexOf('</history>'))
  assert.doesNotMatch(inside, /Et sa population/)
})

test('long histories are truncated with an omission marker', () => {
  const history = Array.from({ length: 120 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `tour ${i}`,
  }))
  const seed = buildSeedContent(conv, history, [{ text: 'suite' }])
  assert.match(seed, /40 earlier turns omitted/)
  assert.doesNotMatch(seed, /\[user\] tour 0\b/)
  assert.match(seed, /tour 119/)
})

test('multiple queued user turns are all delivered', () => {
  const seed = buildSeedContent(conv, [{ role: 'assistant', text: 'ok' }], [
    { text: 'premier' },
    { text: 'second' },
  ])
  assert.match(seed, /\[user\] premier\n\n\[user\] second$/)
})

test('computeDelta excludes everything up to and including syncedSeq, and anything queued', () => {
  const conv = {
    messages: [
      { id: 'm1', seq: 1, role: 'user', text: 'a' },
      { id: 'm2', seq: 2, role: 'assistant', text: 'b' },
      { id: 'm3', seq: 3, role: 'user', text: 'c' },
      { id: 'm4', seq: 4, role: 'assistant', text: 'd' },
      { id: 'm5', seq: 5, role: 'user', text: 'e' },
    ],
  }
  assert.deepEqual(computeDelta(conv, 2, ['m5']).map((m) => m.id), ['m3', 'm4'])
})

test('computeDelta is empty when nothing was missed — the common resume case', () => {
  const conv = {
    messages: [
      { id: 'm1', seq: 1, role: 'user', text: 'a' },
      { id: 'm2', seq: 2, role: 'assistant', text: 'b' },
    ],
  }
  assert.deepEqual(computeDelta(conv, 2, []), [])
})

test('buildDeltaSeedContent carries the missed turns and the new message, distinct from a full seed', () => {
  const delta = [
    { role: 'user', text: 'Et sinon ?' },
    { role: 'assistant', text: 'Rien de neuf.' },
  ]
  const seed = buildDeltaSeedContent(conv, delta, [{ text: 'Et maintenant ?' }])
  assert.match(seed, /^\[conversation resumed — native session restored\]/)
  assert.match(seed, /<missed-turns>/)
  assert.match(seed, /\[user\] Et sinon \?/)
  assert.match(seed, /\[assistant\] Rien de neuf\./)
  assert.match(seed, /<\/missed-turns>/)
  assert.match(seed, /\[user\] Et maintenant \?$/)
  assert.doesNotMatch(seed, /<history>/, 'distinct wrapper from the full re-seed (buildSeedContent)')
  // missed turns stay inside the tags; the new turn stays outside
  const inside = seed.slice(seed.indexOf('<missed-turns>'), seed.indexOf('</missed-turns>'))
  assert.doesNotMatch(inside, /Et maintenant/)
})

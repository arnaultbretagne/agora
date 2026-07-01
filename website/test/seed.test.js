import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSeedContent } from '../lib/seed.js'

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

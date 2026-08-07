import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FALLBACK_TITLE, placeholderTitleFromPrompt } from '../src/title.js'

/**
 * The floor a Workstream carries until its Agent names it. It exists because `'Untitled'` was
 * written here and never replaced — every Workstream in production carried it.
 */

test('a short first message is the title, verbatim', () => {
  assert.equal(placeholderTitleFromPrompt([{ type: 'text', text: 'Bolée ou bol ?' }]), 'Bolée ou bol ?')
})

test('whitespace and line breaks collapse: a pasted prompt must not put its layout in the sidebar', () => {
  assert.equal(placeholderTitleFromPrompt([{ type: 'text', text: '  Bonjour \n\n  tout   le monde  ' }]), 'Bonjour tout le monde')
})

test('a long message is cut on a word boundary, not mid-word', () => {
  const title = placeholderTitleFromPrompt([
    { type: 'text', text: 'Explique-moi la différence entre une bolée de cidre et un bol de cidre en détail' },
  ])
  assert.ok(title.length <= 61, `too long: ${title}`)
  assert.ok(title.endsWith('…'))
  assert.ok(!title.slice(0, -1).endsWith(' '))
  assert.ok('Explique-moi la différence entre une bolée de cidre et un bol de cidre en détail'.startsWith(title.slice(0, -1)))
})

test('one very long word still names the conversation rather than falling back', () => {
  const title = placeholderTitleFromPrompt([{ type: 'text', text: 'a'.repeat(120) }])
  assert.equal(title, `${'a'.repeat(60)}…`)
})

test('non-text blocks are skipped, and a prompt with no text at all still yields a legal title', () => {
  assert.equal(
    placeholderTitleFromPrompt([{ type: 'image' }, { type: 'text', text: 'regarde ça' }]),
    'regarde ça',
  )
  assert.equal(placeholderTitleFromPrompt([{ type: 'image' }]), FALLBACK_TITLE)
  assert.equal(placeholderTitleFromPrompt([]), FALLBACK_TITLE)
  assert.equal(placeholderTitleFromPrompt([{ type: 'text', text: '   ' }]), FALLBACK_TITLE)
  // product.workstreams CHECKs length BETWEEN 1 AND 200 — a title that fails it would make the
  // whole create fail, which is a far worse outcome than a generic name.
  for (const title of [placeholderTitleFromPrompt([]), placeholderTitleFromPrompt([{ type: 'text', text: 'x'.repeat(500) }])]) {
    assert.ok(title.length >= 1 && title.length <= 200)
  }
})

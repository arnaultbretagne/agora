/**
 * The markdown-lite renderer writes straight into `innerHTML`, so its escaping is the only thing
 * standing between agent output and script execution in the operator's browser. The OLD UI had no
 * test for it at all — its single client test (`/srv/agora/website/test/app-loads.test.js`) proved
 * the module *loaded*, which is a different property entirely, and was written after a
 * temporal-dead-zone bug blanked the site for hours.
 *
 * These assert behaviour, not implementation: escaping happens before any wrapping, code fences are
 * literal, and only http(s) links are produced.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, renderMarkdown } from '../src/client/markdown.js'

test('escapes markup before any transform runs', () => {
  const rendered = renderMarkdown('<img src=x onerror="alert(1)">')
  assert.ok(!rendered.includes('<img'), `raw tag survived: ${rendered}`)
  assert.match(rendered, /&lt;img/)
  assert.match(rendered, /&quot;alert\(1\)&quot;/)
})

test('escapes markup that is only reachable through a transform', () => {
  // Each of these puts a tag inside a construct that gets wrapped, so a renderer that escaped
  // per-transform instead of once up front would leak through at least one of them.
  for (const source of ['**<b>bold</b>**', '- <b>item</b>', '> <b>quoted</b>', '# <b>heading</b>', '`<b>code</b>`', '1. <b>first</b>']) {
    const rendered = renderMarkdown(source)
    assert.ok(!rendered.includes('<b>'), `unescaped tag leaked from ${JSON.stringify(source)}: ${rendered}`)
  }
})

test('fenced code is literal, never re-parsed as markdown', () => {
  const rendered = renderMarkdown('```js\nconst a = **not bold** && "<x>"\n```')
  assert.match(rendered, /<pre><code>/)
  assert.ok(!rendered.includes('<strong>'), `markdown ran inside a code fence: ${rendered}`)
  assert.match(rendered, /&lt;x&gt;/)
  assert.match(rendered, /\*\*not bold\*\*/)
})

test('a standalone fence is emitted bare, not wrapped in a paragraph', () => {
  // The OLD UI's `/^ F\d+ $/` test ran against `block.trim()`, which strips the spaces the pattern
  // needs, so this branch never fired and every code block came out inside a `<p>`.
  const rendered = renderMarkdown('```\nplain\n```')
  assert.equal(rendered, '<pre><code>plain</code></pre>')
})

test('a fence keeps its blank lines instead of being split into paragraphs', () => {
  const rendered = renderMarkdown('```\nfirst\n\nsecond\n```')
  assert.equal(rendered, '<pre><code>first\n\nsecond</code></pre>')
})

test('prose around a fence still renders as prose', () => {
  const rendered = renderMarkdown('Voici :\n\n```\ncode\n```\n\nEt après.')
  assert.match(rendered, /^<p>Voici :<\/p>/)
  assert.match(rendered, /<pre><code>code<\/code><\/pre>/)
  assert.match(rendered, /<p>Et après\.<\/p>$/)
})

test('inline constructs', () => {
  assert.match(renderMarkdown('**gras**'), /<strong>gras<\/strong>/)
  assert.match(renderMarkdown('un *mot* ici'), /<em>mot<\/em>/)
  assert.match(renderMarkdown('`code`'), /<code>code<\/code>/)
})

test('unordered and ordered lists', () => {
  assert.equal(renderMarkdown('- un\n- deux'), '<ul><li>un</li><li>deux</li></ul>')
  assert.equal(renderMarkdown('1. un\n2. deux'), '<ol><li>un</li><li>deux</li></ol>')
  // A block where only SOME lines are list items is prose, not a malformed list.
  assert.match(renderMarkdown('- un\npas un item'), /^<p>/)
})

test('headings are demoted so they never compete with the page h1', () => {
  assert.match(renderMarkdown('# Titre'), /<h2>Titre<\/h2>/)
  assert.match(renderMarkdown('## Titre'), /<h3>Titre<\/h3>/)
  assert.match(renderMarkdown('### Titre'), /<h4>Titre<\/h4>/)
})

test('blockquotes survive the escaping that rewrites their marker', () => {
  // By the time blocks are classified, `>` is already `&gt;` — a renderer matching on the raw
  // character here would silently render every quote as a paragraph.
  assert.equal(renderMarkdown('> cité'), '<blockquote>cité</blockquote>')
})

test('links are limited to http(s) targets', () => {
  assert.match(renderMarkdown('[ok](https://example.test/x)'), /<a href="https:\/\/example\.test\/x" target="_blank" rel="noopener noreferrer">ok<\/a>/)
  for (const hostile of ['[x](javascript:alert(1))', '[x](data:text/html,<script>)', '[x](vbscript:msgbox)']) {
    const rendered = renderMarkdown(hostile)
    assert.ok(!rendered.includes('<a '), `a non-http scheme produced a link: ${rendered}`)
  }
})

test('escapeHtml covers every character that can break out of markup or an attribute', () => {
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;')
  // Ampersand first, or every other replacement gets double-escaped.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
})

test('empty input renders an empty paragraph rather than throwing', () => {
  assert.equal(renderMarkdown(''), '<p></p>')
})

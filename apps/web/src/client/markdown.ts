/**
 * Markdown-lite for agent replies, ported unchanged in behaviour from the OLD UI
 * (`/srv/agora/website/public/app.js`). No library: the browser bundle takes no runtime
 * dependency (../../DECISION.md), and the subset an agent actually emits in chat is small.
 *
 * The whole safety argument is the ORDER: fenced blocks are lifted out first, then the entire
 * remaining source is escaped ONCE, and every transform after that only ever wraps text that is
 * already escaped. No transform re-introduces raw input, so no unescaped agent output can reach
 * `innerHTML` — that invariant is why the escape call sits where it does and must not be moved
 * into the individual transforms.
 */

export function escapeHtml(source: string): string {
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Fenced code is extracted before escaping because its body must be escaped as a LITERAL (no inline
 * markdown inside a code block), and re-inserted after block splitting so a fence containing blank
 * lines is not torn into separate paragraphs. The placeholder is a space-delimited ` F<n> ` token:
 * text that happens to contain that exact sequence would be swallowed, which the OLD UI accepted
 * and this port keeps rather than silently changing rendering behaviour mid-migration.
 */
export function renderMarkdown(text: string): string {
  const fences: string[] = []
  let source = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return ` F${fences.length - 1} `
  })
  source = escapeHtml(source)

  const inline = (value: string): string =>
    value
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // Only http(s) targets become links: the href comes from agent output, so `javascript:` and
      // `data:` must never be reachable here, and an allow-list is the only form of that check
      // which cannot be talked around.
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  const blocks = source.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n')
    if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
      return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`
    }
    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`
    }
    if (/^#{1,3}\s+/.test(block)) {
      // Demoted by one level: the page's own `<h1>` is the empty-state greeting, so an agent's `#`
      // must not compete with it in the document outline.
      const hashes = /^(#{1,3})/.exec(block)?.[1] ?? '#'
      const level = Math.min(hashes.length + 1, 4)
      return `<h${level}>${inline(block.replace(/^#{1,3}\s+/, ''))}</h${level}>`
    }
    // `&gt;` and not `>`: by this point the source has already been escaped, so the quote marker no
    // longer looks the way it did in the input.
    if (lines.every((line) => /^\s*&gt;\s?/.test(line))) {
      return `<blockquote>${inline(lines.map((line) => line.replace(/^\s*&gt;\s?/, '')).join('\n'))}</blockquote>`
    }
    // A block that is nothing but a fence placeholder is emitted bare. The OLD UI tested
    // `/^ F\d+ $/` against `block.trim()`, which strips the very spaces the pattern requires, so the
    // branch could never fire and every standalone code block came out as `<p><pre>…</pre></p>` —
    // the parser then hoisted the `<pre>` out and left an empty paragraph behind. Same visual
    // result, so this is a correctness tidy-up rather than a rendering change.
    const placeholder = /^F(\d+)$/.exec(block.trim())
    if (placeholder?.[1]) return fences[Number(placeholder[1])] ?? ''
    return `<p>${inline(block)}</p>`
  })

  return blocks.join('').replace(/ F(\d+) /g, (_match, index: string) => fences[Number(index)] ?? '')
}

/**
 * Markdown-lite for agent replies, ported from the OLD UI (`/srv/agora/website/public/app.js`). No
 * library: the browser bundle takes no runtime dependency (../../DECISION.md), and the subset an
 * agent actually emits in chat is small.
 *
 * Behaviour is the OLD UI's, with one deliberate addition: pipe tables (see `tableBlock`), which
 * neither renderer ever supported and which agents on this engine emit constantly.
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
    const table = tableBlock(lines, inline)
    if (table !== undefined) return table
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

/* ------------------------------------------------------------------ *
 *  Pipe tables                                                        *
 * ------------------------------------------------------------------ */

/**
 * GitHub-style pipe tables, added 2026-08-08 after the operator reported agent tables arriving as
 * literal `|---|---|` text.
 *
 * Not a regression of the port: the OLD UI had no table branch either, so a table has always fallen
 * through to the paragraph fallback. It only became worth fixing now, because the harnesses on this
 * engine answer with tables constantly and the OLD channels-era one rarely did.
 *
 * A table is recognised by its SEPARATOR line and never by the mere presence of pipes — prose
 * containing a `|` stays prose. The separator must itself contain a pipe, which is what stops a
 * paragraph followed by `---` (setext heading syntax this renderer does not support) from being read
 * as a one-column table.
 *
 * Everything here runs on already-escaped text, like every other transform in this file: escaping
 * leaves `|` alone, so the shape survives it intact, and each cell is passed through `inline` rather
 * than re-inserted raw — the escape-once-then-only-wrap invariant is unchanged.
 */

/** One row's cells. Leading and trailing pipes are optional (GFM), and `\|` is a literal pipe inside a cell rather than a separator. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/** Only non-default alignments are emitted; left is what the stylesheet already does. */
function alignmentOf(cell: string): string {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return ' style="text-align:center"'
  if (right) return ' style="text-align:right"'
  return ''
}

function tableBlock(lines: readonly string[], inline: (value: string) => string): string | undefined {
  const separatorAt = lines.findIndex((line, index) => index >= 1 && isTableSeparator(line) && (lines[index - 1] ?? '').includes('|'))
  if (separatorAt < 1) return undefined

  const header = tableCells(lines[separatorAt - 1] ?? '')
  const alignments = tableCells(lines[separatorAt] ?? '').map(alignmentOf)
  // The table ends at the first line that is not a row, so an agent that writes its next sentence
  // directly under the last row does not have it swallowed as a ragged one-cell row.
  let end = separatorAt + 1
  while (end < lines.length && (lines[end] ?? '').includes('|')) end += 1

  const row = (tag: 'th' | 'td', cells: readonly string[]): string =>
    `<tr>${cells.map((value, column) => `<${tag}${alignments[column] ?? ''}>${inline(value)}</${tag}>`).join('')}</tr>`

  const body = lines
    .slice(separatorAt + 1, end)
    .map((line) => {
      const cells = tableCells(line)
      // A short row is padded, never dropped: one missing cell must not cost the row its other
      // columns, and an agent streaming a table emits exactly that while the last row is half-written.
      while (cells.length < header.length) cells.push('')
      return row('td', cells)
    })
    .join('')

  // What surrounds the table is still prose. GFM says a table cannot interrupt a paragraph, but
  // agents put one directly under its introduction line with no blank line all the time, and
  // rendering that introduction as a stray table row is worse than accepting it here.
  const before = lines.slice(0, separatorAt - 1)
  const after = lines.slice(end)
  return [
    before.length > 0 ? `<p>${inline(before.join('\n'))}</p>` : '',
    `<div class="md-table"><table><thead>${row('th', header)}</thead><tbody>${body}</tbody></table></div>`,
    after.length > 0 ? `<p>${inline(after.join('\n'))}</p>` : '',
  ].join('')
}

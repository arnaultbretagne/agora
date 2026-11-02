// docs/specs/search.md: a person's Workstreams searched as grep -n searches files, and one of them read as
// an agent's Read reads a file, over their transcripts — which PostgreSQL computes (`transcript`), nothing
// being stored for either.
import type { Pool } from 'pg'

export type OutputMode = 'workstreams_with_matches' | 'content' | 'count'
export const OUTPUT_MODES: readonly OutputMode[] = ['workstreams_with_matches', 'content', 'count']

export interface SearchQuery {
  readonly pattern: string
  readonly ignoreCase: boolean
  readonly output: OutputMode
  /** Lines of context before and after each match, in `content`. */
  readonly before: number
  readonly after: number
  readonly tools: boolean
  readonly workstream: string | null
  readonly headLimit: number
  readonly offset: number
}

export const HEAD_LIMIT = { default: 20, max: 100 } as const
export const READ_LIMIT = { lines: 2000, bytes: 50 * 1024, line: 2000 } as const
const AROUND = 300

/** ripgrep's word edges in PostgreSQL's dialect: `\b` and `\B` become `\y` and `\Y`; any other escape stays. */
export function postgresPattern(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]!
      out += next === 'b' ? '\\y' : next === 'B' ? '\\Y' : `\\${next}`
      i++
    } else out += c
  }
  return out
}

/**
 * A pattern for `~`, the operator the index of texts serves, which takes no flags: line by line (`n`) asked inside
 * it, before the options it opens with — theirs win, as over flags — and after its director. A literal (`***=`)
 * has no lines to mind and takes no options.
 */
export function inLines(pattern: string): string {
  if (pattern.startsWith('***=')) return pattern
  const director = pattern.startsWith('***:') ? '***:' : ''
  const rest = pattern.slice(director.length)
  const options = /^\(\?([a-z]+)\)/.exec(rest)
  return options ? `${director}(?n${options[1]!})${rest.slice(options[0].length)}` : `${director}(?n)${rest}`
}

/** A line cut to 300 characters around a match starting at `at` (1-based; 0 for none), the cuts marked. */
function around(text: string, at: number): string {
  if (text.length <= AROUND) return text
  const start = Math.max(0, Math.min(text.length - AROUND, (at > 0 ? at - 1 : 0) - AROUND / 3))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + AROUND)}${start + AROUND < text.length ? '…' : ''}`
}

const typesOf = (tools: boolean) => (tools ? ['user', 'agent_message_chunk', 'tool'] : ['user', 'agent_message_chunk'])
const kindsOf = (tools: boolean) => (tools ? ['user', 'agent', 'tool'] : ['user', 'agent'])

/** Refuses a pattern PostgreSQL cannot compile, as lines read it and as the index's operator does, before anything is read. */
async function compiled(pool: Pool, pattern: string, flags: string): Promise<void> {
  try {
    await pool.query('SELECT regexp_like($1, $2, $3), $1 ~ $4', ['', pattern, flags, inLines(pattern)])
  } catch (error) {
    if ((error as { code?: string }).code === '2201B') throw new Error('invalid_pattern')
    throw error
  }
}

export interface SearchAnswer {
  readonly results: readonly Record<string, unknown>[]
  readonly next: number | null
}

/**
 * docs/specs/search.md, "Search": the Workstreams of `owners` — or the one asked — whose transcript holds a
 * matching line, the most recently changed first, then what `output` asks of them.
 */
export async function search(pool: Pool, owners: readonly string[], q: SearchQuery): Promise<SearchAnswer> {
  const pattern = postgresPattern(q.pattern)
  // Line by line: `.` and anchors never cross a line break.
  const flags = q.ignoreCase ? 'ni' : 'n'
  await compiled(pool, pattern, flags)
  // The Workstreams with an element that may hold a matching line, through the index of their texts' trigrams
  // (objects_text), which serves `~` and `~*`; their lines decide below.
  const params: unknown[] = [typesOf(q.tools), owners, inLines(pattern)]
  if (q.workstream !== null) params.push(q.workstream)
  const found = (
    await pool.query(
      `SELECT e.workstream FROM objects e JOIN workstreams w ON w.id = e.workstream LEFT JOIN listings l ON l.workstream = e.workstream
       WHERE e.kind = 'element' AND e.type = ANY($1) AND e.object ? 'turn' AND w.owner = ANY($2)${q.workstream !== null ? ' AND e.workstream = $4' : ''}
         AND transcript_text(e.type, e.object) ${q.ignoreCase ? '~*' : '~'} $3
       GROUP BY e.workstream, l.changed_at ORDER BY l.changed_at DESC NULLS LAST, e.workstream DESC`,
      params,
    )
  ).rows.map((r) => r.workstream as string)
  const kinds = kindsOf(q.tools)
  if (q.output !== 'content') {
    const page = found.slice(q.offset, q.offset + q.headLimit)
    const lines = await pool.query(
      `SELECT t.workstream, t.line, t.text, regexp_instr(t.text, $3, 1, 1, 0, $4) AS at FROM transcript($1) t
       WHERE t.kind = ANY($2) AND regexp_like(t.text, $3, $4) ORDER BY t.workstream, t.line`,
      [page, kinds, pattern, flags],
    )
    const rows = new Map(
      (await pool.query('SELECT workstream, row::text FROM listings WHERE workstream = ANY($1)', [page])).rows.map((r) => [r.workstream as string, r.row as string]),
    )
    const byWorkstream = new Map<string, { count: number; line: number; text: string; at: number }>()
    for (const r of lines.rows as { workstream: string; line: string; text: string; at: number }[]) {
      const prior = byWorkstream.get(r.workstream)
      byWorkstream.set(r.workstream, { count: (prior?.count ?? 0) + 1, line: Number(r.line), text: r.text, at: r.at })
    }
    const results = page
      .filter((ws) => byWorkstream.has(ws))
      .map((ws) => {
        const hit = byWorkstream.get(ws)!
        const row = rows.has(ws) ? (JSON.parse(rows.get(ws)!) as Record<string, unknown>) : null
        return q.output === 'count'
          ? { workstream: ws, title: row?.title ?? null, count: hit.count }
          : { workstream: ws, row, count: hit.count, line: hit.line, text: around(hit.text, hit.at) }
      })
    return { results, next: found.length > q.offset + q.headLimit ? q.offset + q.headLimit : null }
  }
  // `content`: each matching line, its context around it, Workstream after Workstream, until the page is full.
  const results: Record<string, unknown>[] = []
  let skipped = 0,
    matches = 0,
    more = false
  for (let i = 0; i < found.length && !more; i += 10) {
    const batch = found.slice(i, i + 10)
    const lines = await pool.query(
      `WITH t AS MATERIALIZED (SELECT * FROM transcript($1)),
         hits AS (SELECT workstream, line FROM t WHERE kind = ANY($2) AND regexp_like(text, $3, $4))
       SELECT t.workstream, t.line, t.text, EXISTS (SELECT 1 FROM hits h WHERE h.workstream = t.workstream AND h.line = t.line) AS match,
         regexp_instr(t.text, $3, 1, 1, 0, $4) AS at
       FROM t WHERE EXISTS (SELECT 1 FROM hits h WHERE h.workstream = t.workstream AND t.line BETWEEN h.line - $5 AND h.line + $6)
       ORDER BY t.workstream, t.line`,
      [batch, kinds, pattern, flags, q.before, q.after],
    )
    const byWorkstream = new Map<string, { line: number; text: string; match: boolean; at: number }[]>()
    for (const r of lines.rows as { workstream: string; line: string; text: string; match: boolean; at: number }[]) {
      const list = byWorkstream.get(r.workstream) ?? []
      list.push({ line: Number(r.line), text: r.text, match: r.match, at: r.at })
      byWorkstream.set(r.workstream, list)
    }
    for (const ws of batch) {
      const list = byWorkstream.get(ws) ?? []
      // The last line given for this Workstream: a line two matches share is given once.
      let given = 0
      for (const l of list) {
        if (!l.match) continue
        if (skipped < q.offset) {
          skipped++
          continue
        }
        if (matches === q.headLimit) {
          more = true
          break
        }
        matches++
        for (const c of list) {
          if (c.line < l.line - q.before || c.line > l.line + q.after || c.line <= given) continue
          results.push({ workstream: ws, line: c.line, match: c.match, text: around(c.text, c.match ? c.at : 0) })
          given = c.line
        }
      }
      if (more) break
    }
  }
  return { results, next: more ? q.offset + q.headLimit : null }
}

export interface ReadAnswer {
  readonly lines: readonly { number: number; kind: string; text: string }[]
  readonly total: number
  readonly next: number | null
}

/** docs/specs/search.md, "Read": a window of a Workstream's transcript, at most `limit` lines and 50 KB. */
export async function read(pool: Pool, workstream: string, offset: number, limit: number): Promise<ReadAnswer> {
  const rows = (
    await pool.query(
      `WITH t AS MATERIALIZED (SELECT line, kind, text FROM transcript(ARRAY[$1::uuid]))
       SELECT NULL::bigint AS line, NULL AS kind, NULL AS text, (SELECT count(*) FROM t) AS total
       UNION ALL (SELECT line, kind, text, NULL FROM t WHERE line >= $2 ORDER BY line LIMIT $3)`,
      [workstream, offset, limit + 1],
    )
  ).rows as { line: string | null; kind: string | null; text: string | null; total: string | null }[]
  const total = Number(rows[0]!.total)
  const lines: { number: number; kind: string; text: string }[] = []
  let bytes = 0,
    next: number | null = null
  for (const r of rows.slice(1)) {
    const number = Number(r.line)
    if (lines.length === limit) {
      next = number
      break
    }
    const text = r.text!.length > READ_LIMIT.line ? `${r.text!.slice(0, READ_LIMIT.line)}… (line cut to ${String(READ_LIMIT.line)} characters)` : r.text!
    const size = Buffer.byteLength(text, 'utf8') + 1
    if (lines.length > 0 && bytes + size > READ_LIMIT.bytes) {
      next = number
      break
    }
    bytes += size
    lines.push({ number, kind: r.kind!, text })
  }
  return { lines, total, next }
}

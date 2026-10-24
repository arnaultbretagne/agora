// Checks that every acceptance case cited in docs/reliability is defined in docs/specs (docs/README.md):
// a case ID — C, E, F, L or U and digits — is defined by a row of a spec's case table, `| C1 | … |`.
// Every citation in every .md file of docs/reliability counts, a range such as `C1–C4` for each case
// in it; run IDs (R1, R0g…) are not case IDs. No dependency: Node 24.
//
//   node scripts/case-ids.ts   prints each citation no spec defines, and exits 1 if there is one
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The case IDs a spec's case tables define: the first cell of their rows. */
export function defined(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\|\s*([CEFLU]\d+)\s*\|/.exec(line)
    if (m) out.add(m[1]!)
  }
  return out
}

/** The case IDs a text cites, with their line: `C1`, and each case of a range `C1–C4` or `C1-C4`. */
export function cited(text: string): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = []
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(/(?<![A-Za-z0-9_])([CEFLU])(\d+)(?:[–-]\1(\d+))?(?![A-Za-z0-9_])/g)) {
      const from = Number(m[2])
      const to = m[3] === undefined ? from : Number(m[3])
      if (to < from) for (const n of [from, to]) out.push({ id: `${m[1]}${n}`, line: i + 1 })
      else for (let n = from; n <= to; n++) out.push({ id: `${m[1]}${n}`, line: i + 1 })
    }
  }
  return out
}

/** Every .md file under a folder. */
function markdown(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f))
}

/** The citations in docs/reliability that no case table of docs/specs defines. */
export function undefinedCases(root: string): { file: string; line: number; id: string }[] {
  const known = new Set<string>()
  for (const file of markdown(join(root, 'docs/specs'))) for (const id of defined(readFileSync(file, 'utf8'))) known.add(id)
  const out: { file: string; line: number; id: string }[] = []
  for (const file of markdown(join(root, 'docs/reliability')))
    for (const { id, line } of cited(readFileSync(file, 'utf8'))) if (!known.has(id)) out.push({ file: relative(root, file), line, id })
  return out
}

if (import.meta.main) {
  const found = undefinedCases(join(import.meta.dirname, '..'))
  for (const { file, line, id } of found) console.error(`${file}:${line}: ${id} is cited, but no case table of docs/specs defines it`)
  if (found.length > 0) {
    console.error(`${found.length} citation(s) of undefined cases`)
    process.exit(1)
  }
  console.log('every case cited in docs/reliability is defined in docs/specs')
}

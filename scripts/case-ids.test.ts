import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dirname, 'case-ids.ts')

/** Runs the check on a repository holding these specs and reliability files. */
function check(specs: Record<string, string>, reliability: Record<string, string>): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'case-ids-'))
  mkdirSync(join(root, 'docs/specs'), { recursive: true })
  mkdirSync(join(root, 'docs/reliability'), { recursive: true })
  for (const [name, text] of Object.entries(specs)) writeFileSync(join(root, 'docs/specs', name), text)
  for (const [name, text] of Object.entries(reliability)) writeFileSync(join(root, 'docs/reliability', name), text)
  const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
  return { status: run.status, out: run.stdout + run.stderr }
}

/** A case table defining these IDs, and a table of another kind. */
function spec(...ids: string[]): string {
  return ['| ID | Case | Expected |', '| --- | --- | --- |', ...ids.map((id) => `| ${id} | A case | Held. |`), '', '| Step | What |', '| 1 | C4 is no row of a case table. |'].join('\n')
}

/** The IDs the check names as undefined. */
function named(out: string): string[] {
  return [...out.matchAll(/^\S+:\d+: (\S+) is cited/gm)].map((m) => m[1]!)
}

test('every case cited in every .md file of docs/reliability is defined: exit 0, and the counts said', () => {
  const { status, out } = check({ 'credentials.md': spec('C1', 'C2'), 'log.md': spec('L3', 'U1') }, { 'credentials.md': '| C1 | — | local | R1 | proven | C2 too. |\n', 'README.md': 'R1 shows U1 and L3.\n' })
  assert.equal(status, 0, out)
  assert.match(out, /4 citations in 2 files, 4 cases defined/)
})

test('an undefined case is named with its file and line, README.md included; run IDs never', () => {
  const { status, out } = check({ 'credentials.md': spec('C1') }, { 'credentials.md': '| C1 | — | local | R1 | proven | R0g, R12. |\n', 'README.md': 'R1 shows C1.\nAnd U999.\n', 'client.md': 'C999 is cited.\n' })
  assert.equal(status, 1)
  assert.deepEqual(named(out), ['U999', 'C999'])
  assert.match(out, /^docs\/reliability\/README\.md:2: U999 is cited/m)
  assert.match(out, /^docs\/reliability\/client\.md:1: C999 is cited/m)
})

test('a defining row removed from its case table: the cited case is named', () => {
  const { status, out } = check({ 'credentials.md': spec('C2') }, { 'credentials.md': '| C1 | — | local | R1 | proven | C2 too. |\n' })
  assert.equal(status, 1)
  assert.deepEqual(named(out), ['C1'])
})

test('a range cites every case in it, whatever its form', () => {
  for (const range of ['C998 to C1000', 'C998–C1000', 'C998-C1000', 'C998–1000', 'C998 through C1000']) {
    const { status, out } = check({ 'credentials.md': spec('C998', 'C1000') }, { 'credentials.md': `Shown: ${range}.\n` })
    assert.equal(status, 1, range)
    assert.deepEqual(named(out), ['C999'], range)
  }
  const { status, out } = check({ 'executions.md': spec('E5', 'E7') }, { 'executions.md': 'E5 to E7 are the log\'s.\n' })
  assert.equal(status, 1)
  assert.deepEqual(named(out), ['E6'])
})

test('what only looks like a case ID is not one', () => {
  const { status, out } = check({ 'executions.md': spec('E5') }, { 'executions.md': 'E5, not E2E, `0c75f9b`, CL3, L3a, E*n*, R7 or cases 23–26.\n' })
  assert.equal(status, 0, out)
  assert.match(out, /1 citations in 1 files/)
})

test('no case table at all is a failure, not a pass', () => {
  const { status, out } = check({ 'README.md': '# specs\n' }, { 'README.md': 'C1.\n' })
  assert.equal(status, 1)
  assert.match(out, /no case table found/)
})

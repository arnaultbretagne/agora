import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cited, defined, undefinedCases } from './case-ids.ts'

const SPEC = ['| ID | Case | Expected |', '| --- | --- | --- |', '| C1 | A case | Held. |', '| C2 | Another | Held. |', '| L3 | A third | Held. |', '', '| Step | What |', '| 1 | C4 is no row of a case table. |'].join('\n')

test('the case tables define the first cell of their rows, nothing else', () => {
  assert.deepEqual([...defined(SPEC)].sort(), ['C1', 'C2', 'L3'])
})

test('a citation is a case ID, each case of a range, never a run ID or part of a word', () => {
  const text = ['| C1 | — | local | R1 | proven | Every assertion held. |', 'R0g and R12 ran C1–C3, then E5 to E7 and U10-U11.', 'Not E2E, `0c75f9b`, CL3, L3a or E*n*.'].join('\n')
  assert.deepEqual(cited(text), [
    { id: 'C1', line: 1 },
    { id: 'C1', line: 2 },
    { id: 'C2', line: 2 },
    { id: 'C3', line: 2 },
    { id: 'E5', line: 2 },
    { id: 'E7', line: 2 },
    { id: 'U10', line: 2 },
    { id: 'U11', line: 2 },
  ])
})

test('every .md file of docs/reliability is checked against every spec, README.md included', () => {
  const root = mkdtempSync(join(tmpdir(), 'case-ids-'))
  mkdirSync(join(root, 'docs/specs'), { recursive: true })
  mkdirSync(join(root, 'docs/reliability'), { recursive: true })
  writeFileSync(join(root, 'docs/specs/credentials.md'), SPEC)
  writeFileSync(join(root, 'docs/specs/log.md'), '| U1 | A case | Held. |\n')
  writeFileSync(join(root, 'docs/reliability/credentials.md'), '| C1 | — | local | R1 | proven | C2 too. |\n')
  writeFileSync(join(root, 'docs/reliability/README.md'), 'R1 shows U1 and L3.\n')
  assert.deepEqual(undefinedCases(root), [])

  writeFileSync(join(root, 'docs/reliability/README.md'), 'R1 shows U1 and L3.\nAnd U999.\n')
  writeFileSync(join(root, 'docs/specs/credentials.md'), SPEC.replace('| C1 | A case | Held. |\n', ''))
  assert.deepEqual(undefinedCases(root), [
    { file: 'docs/reliability/README.md', line: 2, id: 'U999' },
    { file: 'docs/reliability/credentials.md', line: 1, id: 'C1' },
  ])
})

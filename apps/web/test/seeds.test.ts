// The server's seeds for a preview (apps/server/src/seeds.ts, docs/specs/preview.md, "The conversations"), read
// from these fixtures: a harness not captured yet is left out until its fixture is there, nothing standing in for it.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FIXTURES, HARNESSES, NOT_CAPTURED, seeds } from '../../server/src/seeds.ts'

test('V10 the fixtures without antigravity.json: 15 conversations, none of antigravity; with it: 16, its own; another harness’s fixture missing: refused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seeds-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(FIXTURES, dir, { recursive: true })
  rmSync(join(dir, 'antigravity.json'), { force: true })
  assert.deepEqual([...NOT_CAPTURED], ['antigravity'])
  assert.ok(HARNESSES.includes('antigravity'))

  const without = await seeds(dir)
  assert.equal(without.length, 15)
  assert.equal(without.filter((s) => s.parent === undefined).length, 14, 'fourteen listed: the delegate is a sub-stream')
  assert.deepEqual(without.map((s) => s.name).filter((n) => (HARNESSES as readonly string[]).includes(n)), ['claude-code', 'codex', 'opencode'])

  // A stand-in for the capture, in this test's folder alone: codex's history under antigravity's name.
  const captured = JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8')) as { harness: string }
  writeFileSync(join(dir, 'antigravity.json'), JSON.stringify({ ...captured, harness: 'antigravity' }))
  const withIt = await seeds(dir)
  assert.equal(withIt.length, 16)
  const antigravity = withIt.filter((s) => s.name === 'antigravity')
  assert.equal(antigravity.length, 1)
  const codex = withIt.find((s) => s.name === 'codex')!
  assert.equal(antigravity[0]!.entries.length, codex.entries.length)
  assert.notEqual(antigravity[0]!.id, codex.id, 'a Workstream of its own')
  assert.ok(antigravity[0]!.entries.every((e) => e.workstream === antigravity[0]!.id))

  rmSync(join(dir, 'opencode.json'))
  await assert.rejects(seeds(dir), /ENOENT.*opencode\.json/, 'a captured harness’s fixture is never skipped')
})

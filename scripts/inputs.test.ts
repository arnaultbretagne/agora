import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromToolbelt, images, sources, TOOLBELT } from './inputs.ts'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(import.meta.dirname, 'inputs.ts')
const REAL = ['agora-harness-claude-code', 'agora-harness-codex', 'agora-harness-opencode', 'agora-harness-antigravity']
process.chdir(ROOT)

/** A repository holding the Dockerfiles and what they copy, as this one does, committed. */
function copy(): string {
  const repo = mkdtempSync(join(tmpdir(), 'inputs-'))
  for (const dockerfile of [TOOLBELT.dockerfile, ...[...images().values()].map((i) => i.dockerfile)])
    for (const source of sources(dockerfile)) cpSync(source, join(repo, source), { recursive: true })
  git(repo, 'init', '-q')
  commit(repo)
  return repo
}
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' })
}
function commit(repo: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'inputs')
}
/** Each image's fingerprint, the toolbelt's too, as the CI computes it. */
function fingerprints(repo: string): Map<string, string> {
  const names = [TOOLBELT.name, ...JSON.parse(execFileSync(process.execPath, [SCRIPT, '--matrix'], { cwd: repo, encoding: 'utf8' })).map((i: { name: string }) => i.name)]
  return new Map(names.map((name) => [name, execFileSync(process.execPath, [SCRIPT, name], { cwd: repo, encoding: 'utf8' }).trim()]))
}

test('the four real harnesses are built on the toolbelt; the mock and the server are not', () => {
  const all = images()
  for (const name of REAL) assert.equal(all.get(name)?.toolbelt, true, name)
  assert.equal(all.get('agora-harness-mock')?.toolbelt, false)
  assert.equal(all.get('agora-server')?.toolbelt, false)
  assert.match(readFileSync('harnesses/mock/Dockerfile', 'utf8'), /^FROM node:24-bookworm-slim$/m)
  assert.equal(fromToolbelt(TOOLBELT.dockerfile), false)
})

test('the toolbelt is no image infra-k8s deploys: propose-infra.ts, which reads images(), never proposes it', () => {
  assert.equal(images().has(TOOLBELT.name), false)
  assert.match(readFileSync('scripts/propose-infra.ts', 'utf8'), /for \(const \[image, \{ dockerfile, harness \}\] of images\(\)\)/)
})

test('a harness built on the toolbelt counts its inputs as its own', () => {
  for (const name of REAL) {
    const own = sources(images().get(name)!.dockerfile)
    for (const source of sources(TOOLBELT.dockerfile)) assert.ok(own.includes(source), `${name}: ${source}`)
  }
  assert.equal(sources('harnesses/mock/Dockerfile').includes(TOOLBELT.dockerfile), false)
  assert.equal(sources('apps/server/Dockerfile').includes(TOOLBELT.dockerfile), false)
})

test('the fingerprints are deterministic; a change to the toolbelt changes those of the four real harnesses alone', () => {
  const repo = copy()
  const before = fingerprints(repo)
  assert.deepEqual(fingerprints(repo), before)
  for (const value of before.values()) assert.match(value, /^[0-9a-f]{16}$/)

  appendFileSync(join(repo, TOOLBELT.dockerfile), 'RUN true\n')
  commit(repo)
  const after = fingerprints(repo)
  assert.notEqual(after.get(TOOLBELT.name), before.get(TOOLBELT.name))
  for (const name of REAL) assert.notEqual(after.get(name), before.get(name), name)
  for (const name of ['agora-harness-mock', 'agora-server']) assert.equal(after.get(name), before.get(name), name)

  // At the first commit, the fingerprints are those of the first commit.
  const first = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim()
  assert.equal(execFileSync(process.execPath, [SCRIPT, TOOLBELT.name, first], { cwd: repo, encoding: 'utf8' }).trim(), before.get(TOOLBELT.name))
})

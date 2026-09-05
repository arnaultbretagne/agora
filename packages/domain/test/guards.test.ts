import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const packageRoot = new URL('../..', import.meta.url).pathname
const srcRoot = join(packageRoot, 'src')

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

const assembled = (...fragments: string[]) => fragments.join('')

const FORBIDDEN_IDENTIFIERS = [
  assembled('run', '_id'),
  assembled('run', 'Id'),
  assembled('Run', 'Id'),
  assembled('loge', '_id'),
  assembled('loge', 'Id'),
  assembled('Lo', 'ge', 'Id'),
  assembled('Lo', 'ge'),
  assembled('runtime', '_id'),
  assembled('runtime', 'Id'),
  assembled('Runtime', 'Id'),
  assembled('native', '_session_id'),
  assembled('native', 'Session', 'Id'),
  assembled('Session', 'Runtime'),
  assembled('session', '_runtime'),
  assembled('Execution', 'Backend'),
  assembled('execution', '_backend'),
  assembled('agent', '_id'),
]

test('domain sources never reintroduce the retired product vocabulary', () => {
  const violations: string[] = []
  for (const file of sourceFiles(srcRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const identifier of FORBIDDEN_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(line)) {
          violations.push(`${file}:${index + 1} contains "${identifier}"`)
        }
      }
    })
  }
  assert.deepEqual(violations, [])
})

test('the domain package declares no runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
})

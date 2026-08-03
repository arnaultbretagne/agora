import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

test('required: generated bindings expose no runtimeId — every operation is keyed by Session id only', async () => {
  // Read the original hand-written source, not dist/ (tsc's emitted .d.ts also matches *.ts).
  const srcDir = new URL('../../src', import.meta.url).pathname
  for (const file of await readdir(srcDir)) {
    if (!file.endsWith('.ts')) continue
    const text = await readFile(join(srcDir, file), 'utf8')
    assert.equal(/runtimeId/i.test(text), false, `${file} must not reference a runtimeId`)
  }
})

test('required: every Session Runtime operation is nested under a Session id parameter', async () => {
  const client = await import('../src/client.js')
  const sessionScoped = [
    client.materializeSessionRuntime,
    client.getSessionRuntime,
    client.dematerializeSessionRuntime,
    client.openACPConnection,
    client.captureCustody,
  ]
  for (const fn of sessionScoped) {
    // (transport, sessionId, ...) — the Session id is always the second positional parameter.
    assert.ok(fn.length >= 2, `${fn.name} must take a Session id parameter`)
  }
})

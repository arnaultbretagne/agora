import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCredentialStubs, writeCredentialStubs } from '../src/credential-stubs.js'

test('stubs are written under HOME, creating the directories the adapter expects', () => {
  const home = mkdtempSync(join(tmpdir(), 'agora-stub-'))
  const written = writeCredentialStubs([{ path: '.codex/auth.json', content: '{"auth_mode":"chatgpt"}' }], home)

  assert.deepEqual(written, [join(home, '.codex/auth.json')])
  assert.equal(readFileSync(written[0]!, 'utf8'), '{"auth_mode":"chatgpt"}')
  // It looks like a credential; nothing should learn from its mode that it is safe to leave open.
  assert.equal(statSync(written[0]!).mode & 0o777, 0o600)
})

test('a stub may not name a path outside HOME — not absolute, not by traversal', () => {
  const home = mkdtempSync(join(tmpdir(), 'agora-stub-'))
  assert.throws(() => writeCredentialStubs([{ path: '/etc/passwd', content: 'x' }], home), /relative to HOME/)
  assert.throws(() => writeCredentialStubs([{ path: '../escaped', content: 'x' }], home), /escapes HOME/)
  assert.throws(() => writeCredentialStubs([{ path: '.codex/../../out', content: 'x' }], home), /escapes HOME/)
})

test('no stubs configured is not an error: a harness that needs none gets none', () => {
  assert.deepEqual(parseCredentialStubs(undefined), [])
  assert.deepEqual(parseCredentialStubs('  '), [])
  assert.deepEqual(parseCredentialStubs('[{"path":".codex/auth.json","content":"{}"}]'), [{ path: '.codex/auth.json', content: '{}' }])
})

test('a malformed stub is refused loudly rather than written as something else', () => {
  assert.throws(() => parseCredentialStubs('{"path":"x"}'), /must be a JSON array/)
  assert.throws(() => parseCredentialStubs('[{"content":"x"}]'), /needs a path/)
  assert.throws(() => parseCredentialStubs('[{"path":"x","content":{"not":"a string"}}]'), /needs string content/)
})

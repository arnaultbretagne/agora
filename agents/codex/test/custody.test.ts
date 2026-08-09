import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  captureNativeState,
  CustodyCaptureError,
  CustodyRestoreError,
  restoreNativeState,
  sessionIdFromEnvelopeBytes,
  sessionIdFromTranscriptBytes,
} from '../src/custody.js'

async function scratchHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-custody-test-'))
}

function rolloutLine(sessionId: string, type = 'session_meta', extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload: { session_id: sessionId, ...extra } })}\n`
}

async function seedRollout(home: string, relativePath: string, content: string): Promise<void> {
  const path = join(home, relativePath)
  await mkdir(join(home, relativePath.split('/').slice(0, -1).join('/')), { recursive: true })
  await writeFile(path, content)
}

function envelopeBytes(relativePath: string, content: Buffer): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ relativePath, contentBase64: content.toString('base64') }))
}

test('required: sessionIdFromTranscriptBytes reads the nested payload.session_id real Codex rollout lines carry', () => {
  const bytes = new TextEncoder().encode(rolloutLine('session-xyz') + rolloutLine('session-xyz', 'event_msg'))
  assert.equal(sessionIdFromTranscriptBytes(bytes), 'session-xyz')
})

test('sessionIdFromTranscriptBytes skips blank/non-JSON lines before finding the first real one', () => {
  const bytes = new TextEncoder().encode(`\nnot json\n${rolloutLine('session-after-junk')}`)
  assert.equal(sessionIdFromTranscriptBytes(bytes), 'session-after-junk')
})

test('sessionIdFromTranscriptBytes throws a typed error when no line carries payload.session_id', () => {
  const bytes = new TextEncoder().encode('{"type":"session_meta","payload":{}}\n')
  assert.throws(() => sessionIdFromTranscriptBytes(bytes), (error: unknown) => error instanceof CustodyRestoreError)
})

test('required: capture locates the rollout file by sessionId under a date-partitioned path and wraps it in an envelope', async () => {
  const home = await scratchHome()
  const content = rolloutLine('session-1') + rolloutLine('session-1', 'event_msg')
  const relativePath = '.codex/sessions/2026/08/05/rollout-2026-08-05T17-00-00-session-1.jsonl'
  await seedRollout(home, relativePath, content)

  const captured = await captureNativeState(home, 'session-1')
  const envelope = JSON.parse(new TextDecoder().decode(captured.bytes)) as { relativePath: string; contentBase64: string }
  assert.equal(envelope.relativePath, relativePath)
  assert.equal(Buffer.from(envelope.contentBase64, 'base64').toString('utf8'), content)
  assert.equal(captured.sha256.length, 64)
})

test('required: capture with no rollout file on disk fails with a typed error, not a crash', async () => {
  const home = await scratchHome()
  await assert.rejects(() => captureNativeState(home, 'never-existed'), (error: unknown) => error instanceof CustodyCaptureError)
})

test('required: restore writes the rollout file back at its EXACT original relative path', async () => {
  const home = await scratchHome()
  const content = Buffer.from(rolloutLine('session-2'))
  const relativePath = '.codex/sessions/2026/08/05/rollout-2026-08-05T18-00-00-session-2.jsonl'

  const { sessionId } = await restoreNativeState(home, envelopeBytes(relativePath, content))
  assert.equal(sessionId, 'session-2')
  const onDisk = await readFile(join(home, relativePath))
  assert.deepEqual(Buffer.from(onDisk), content)
})

test('required: restore refuses to overwrite existing native state (fail-if-present)', async () => {
  const home = await scratchHome()
  const relativePath = '.codex/sessions/2026/08/05/rollout-2026-08-05T19-00-00-session-3.jsonl'
  const first = Buffer.from(rolloutLine('session-3', 'session_meta', { note: 'first' }))
  const second = Buffer.from(rolloutLine('session-3', 'session_meta', { note: 'second' }))

  await restoreNativeState(home, envelopeBytes(relativePath, first))
  await assert.rejects(() => restoreNativeState(home, envelopeBytes(relativePath, second)), (error: unknown) => error instanceof CustodyRestoreError)

  const onDisk = await readFile(join(home, relativePath))
  assert.deepEqual(Buffer.from(onDisk), first)
})

test('restore creates the date-partitioned directory tree if absent', async () => {
  const home = await scratchHome()
  const relativePath = '.codex/sessions/2026/08/05/rollout-2026-08-05T20-00-00-session-4.jsonl'
  const content = Buffer.from(rolloutLine('session-4'))
  const { sessionId } = await restoreNativeState(home, envelopeBytes(relativePath, content))
  assert.equal(sessionId, 'session-4')
})

test('required: restore rejects a malformed envelope (missing relativePath/contentBase64)', async () => {
  const home = await scratchHome()
  const bytes = new TextEncoder().encode(JSON.stringify({ notAnEnvelope: true }))
  await assert.rejects(() => restoreNativeState(home, bytes), (error: unknown) => error instanceof CustodyRestoreError)
})

test('required: restore rejects a relative path escaping .codex/sessions/ (path traversal)', async () => {
  const home = await scratchHome()
  const content = Buffer.from(rolloutLine('session-5'))
  const traversal = envelopeBytes('.codex/sessions/../../etc/passwd', content)
  await assert.rejects(() => restoreNativeState(home, traversal), (error: unknown) => error instanceof CustodyRestoreError)
})

test('required: restore rejects an absolute relative path', async () => {
  const home = await scratchHome()
  const content = Buffer.from(rolloutLine('session-6'))
  const absolute = envelopeBytes('/etc/passwd', content)
  await assert.rejects(() => restoreNativeState(home, absolute), (error: unknown) => error instanceof CustodyRestoreError)
})

test('sessionIdFromEnvelopeBytes reads through the envelope wrapper to the wrapped payload.session_id', () => {
  const content = Buffer.from(rolloutLine('session-7'))
  const bytes = envelopeBytes('.codex/sessions/2026/08/05/rollout-x-session-7.jsonl', content)
  assert.equal(sessionIdFromEnvelopeBytes(bytes), 'session-7')
})

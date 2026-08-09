import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureNativeState, CustodyCaptureError, CustodyRestoreError, nativeTranscriptPath, restoreNativeState, sessionIdFromTranscriptBytes } from '../src/custody.js'

async function scratchHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'claude-custody-test-'))
}

function transcriptLine(sessionId: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'summary', operation: 'created', timestamp: new Date().toISOString(), sessionId, ...extra })}\n`
}

test('nativeTranscriptPath is deterministic from homeDir + sessionId, keyed to the fixed workspace slug', async () => {
  const home = await scratchHome()
  const path = nativeTranscriptPath(home, 'abc-123')
  assert.equal(path, `${home}/.claude/projects/-home-node-work/abc-123.jsonl`)
})

test('required: sessionIdFromTranscriptBytes reads the sessionId real Claude Code transcript lines carry', () => {
  const bytes = new TextEncoder().encode(transcriptLine('session-xyz') + transcriptLine('session-xyz', { type: 'message' }))
  assert.equal(sessionIdFromTranscriptBytes(bytes), 'session-xyz')
})

test('sessionIdFromTranscriptBytes skips blank/non-JSON lines before finding the first real one', () => {
  const bytes = new TextEncoder().encode(`\nnot json\n${transcriptLine('session-after-junk')}`)
  assert.equal(sessionIdFromTranscriptBytes(bytes), 'session-after-junk')
})

test('sessionIdFromTranscriptBytes throws a typed error when no line carries a sessionId', () => {
  const bytes = new TextEncoder().encode('{"type":"summary"}\n')
  assert.throws(() => sessionIdFromTranscriptBytes(bytes), (error: unknown) => error instanceof CustodyRestoreError)
})

test('required: capture reads exactly the bytes at the transcript path and returns a matching sha256', async () => {
  const home = await scratchHome()
  const content = new TextEncoder().encode(transcriptLine('session-1') + transcriptLine('session-1', { type: 'message' }))
  const { sessionId } = await restoreNativeState(home, content)

  const captured = await captureNativeState(home, sessionId)
  assert.deepEqual(Buffer.from(captured.bytes), Buffer.from(content))
  assert.equal(captured.sha256.length, 64)
})

test('required: capture with no transcript on disk fails with a typed error, not a crash', async () => {
  const home = await scratchHome()
  await assert.rejects(() => captureNativeState(home, 'never-existed'), (error: unknown) => error instanceof CustodyCaptureError)
})

test('required: restore refuses to overwrite existing native state (fail-if-present)', async () => {
  const home = await scratchHome()
  const first = new TextEncoder().encode(transcriptLine('session-2', { note: 'first' }))
  const second = new TextEncoder().encode(transcriptLine('session-2', { note: 'second' }))
  await restoreNativeState(home, first)
  await assert.rejects(() => restoreNativeState(home, second), (error: unknown) => error instanceof CustodyRestoreError)

  // The original content must survive the rejected overwrite attempt untouched.
  const onDisk = await readFile(nativeTranscriptPath(home, 'session-2'))
  assert.deepEqual(Buffer.from(onDisk), Buffer.from(first))
})

test('restore creates the project directory tree if absent', async () => {
  const home = await scratchHome()
  const content = new TextEncoder().encode(transcriptLine('session-3'))
  const { sessionId } = await restoreNativeState(home, content)
  assert.equal(sessionId, 'session-3')
  const captured = await captureNativeState(home, sessionId)
  assert.deepEqual(Buffer.from(captured.bytes), Buffer.from(content))
})

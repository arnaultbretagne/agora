import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeCodeCustodyDriver, CustodyRefusedError, DRIVER_REVISION, FORMAT_ID, FORMAT_VERSION, contextIdFromPayload, transcriptPath, workspaceSlug } from '../src/driver.js'

const WORKSPACE_ROOT = '/home/agent/work'

/** A transcript shaped like the measured one: every line carries the sessionId (findings §2.2). */
function transcript(contextId: string, messages: readonly { role: 'user' | 'assistant'; content: string }[]): Uint8Array {
  const lines = messages.map((message) =>
    JSON.stringify({
      type: message.role,
      sessionId: contextId,
      uuid: randomUUID(),
      cwd: WORKSPACE_ROOT,
      message: { role: message.role, content: message.content },
    }),
  )
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

async function fixture(): Promise<{ home: string; contextId: string; driver: ClaudeCodeCustodyDriver; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'agora-custody-'))
  const contextId = randomUUID()
  const driver = new ClaudeCodeCustodyDriver({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, stabilityWindowMs: 1 })
  return { home, contextId, driver, path: transcriptPath({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, contextId }) }
}

async function writeTranscript(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
}

const cut = (contextId: string) => ({ podUid: 'pod-uid-1', processGeneration: 0, contextId })

test('the captured path is the adapter\'s own, with the workspace root slugified as measured', () => {
  assert.equal(
    transcriptPath({ harnessHome: '/home/agent', workspaceRoot: '/home/agent/work', contextId: 'ctx-1' }),
    '/home/agent/.claude/projects/-home-agent-work/ctx-1.jsonl',
  )
  // Every character outside [A-Za-z0-9-] becomes a dash, case survives — measured, not assumed.
  assert.equal(workspaceSlug('/home/dev/.claude/jobs/x/A_b.c-d 1'), '-home-dev--claude-jobs-x-A-b-c-d-1')
})

test('capture takes exactly the one transcript, byte-exact, and nothing else in the home', async () => {
  const { home, contextId, driver, path } = await fixture()
  const bytes = transcript(contextId, [{ role: 'user', content: 'hello' }])
  await writeTranscript(path, bytes)
  // The excluded global state, present and untouched: capturing any of it would carry one
  // execution's harness identity into another's restore.
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude', '.credentials.json'), '{"oauth":"secret"}')
  await writeFile(join(home, '.claude.json'), '{"installation":"state"}')

  const captured = await driver.capture(cut(contextId))

  assert.deepEqual(captured.bytes, bytes)
  assert.equal(captured.formatId, FORMAT_ID)
  assert.equal(captured.formatVersion, FORMAT_VERSION)
  assert.equal(driver.driverRevision, DRIVER_REVISION)
  assert.equal(captured.checksum, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  assert.deepEqual(captured.nativeOrigin, { podUid: 'pod-uid-1', processGeneration: 0, contextId })
  // The conversation, not the workspace: no dependency is declared rather than one implied.
  assert.deepEqual(captured.workspaceDeps, {})
  assert.ok(!new TextDecoder().decode(captured.bytes).includes('secret'))
  await rm(home, { recursive: true, force: true })
})

test('CONT-009: the captured frontier is what the driver proved, never a journal head handed back', async () => {
  const { home, contextId, driver, path } = await fixture()
  await writeTranscript(path, transcript(contextId, [{ role: 'user', content: 'work' }]))

  const captured = await driver.capture(cut(contextId))

  // The transcript alone proves no Handoff delivery, so the frontier is the conservative floor —
  // whatever the caller's journal head happened to be is not evidence and does not appear here.
  assert.equal(captured.frontierW, 0)
  await rm(home, { recursive: true, force: true })
})

test('a transcript that keeps changing past the budget is refused: no quiescent cut was reached', async () => {
  const { home, contextId, path } = await fixture()
  await writeTranscript(path, transcript(contextId, [{ role: 'user', content: 'first' }]))
  // Deterministic rather than racing: the change lands 40ms into a 100ms stability window — well
  // after the first read has certainly finished and well before the second begins — and the clock
  // has already spent the budget when the driver checks it. The first version of this test raced a
  // writer against real reads: it passed locally and failed on a loaded CI runner, which is the
  // same as not testing anything.
  let reads = 0
  const driver = new ClaudeCodeCustodyDriver({
    harnessHome: home,
    workspaceRoot: WORKSPACE_ROOT,
    stabilityWindowMs: 100,
    captureTimeoutMs: 50,
    now: () => (reads++ === 0 ? 0 : 1_000),
  })
  const late = setTimeout(() => void writeTranscript(path, transcript(contextId, [{ role: 'assistant', content: 'still writing' }])), 40)

  await assert.rejects(driver.capture(cut(contextId)), (error: unknown) => {
    assert.ok(error instanceof CustodyRefusedError)
    assert.equal(error.code, 'capture_refused')
    assert.match(error.reason, /still changing after 50ms/)
    return true
  })

  clearTimeout(late)
  await rm(home, { recursive: true, force: true })
})

test('a transcript still settling after the process died is waited out, not refused', async () => {
  const { home, contextId, path } = await fixture()
  await writeTranscript(path, transcript(contextId, [{ role: 'user', content: 'first' }]))
  const driver = new ClaudeCodeCustodyDriver({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, stabilityWindowMs: 30, captureTimeoutMs: 2000 })
  const settled = transcript(contextId, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'the last flush' }])

  // Measured behaviour: the adapter's writes land for ~100-200ms after the process is gone. One
  // disagreeing read means "not yet", and refusing there would lose a Save that was about to be fine.
  const late = setTimeout(() => void writeTranscript(path, settled), 15)

  const captured = await driver.capture(cut(contextId))

  clearTimeout(late)
  assert.deepEqual(captured.bytes, settled)
  await rm(home, { recursive: true, force: true })
})

test('capture refuses a context with no transcript rather than inventing an empty one', async () => {
  const { home, contextId, driver } = await fixture()
  await assert.rejects(driver.capture(cut(contextId)), /no transcript for context/)
  await rm(home, { recursive: true, force: true })
})

test('restore places the bytes under the context id the payload itself claims', async () => {
  const { home, contextId, driver, path } = await fixture()
  const bytes = transcript(contextId, [{ role: 'user', content: 'codeword: mirabelle' }])

  const placement = await driver.restore(bytes)

  assert.equal(placement.path, path)
  assert.equal(placement.byteLength, bytes.byteLength)
  assert.deepEqual(new Uint8Array(await readFile(path)), bytes)
  await rm(home, { recursive: true, force: true })
})

test('a payload with no sessionId, or with two, is not a claude-code transcript and is refused', async () => {
  const { home, driver } = await fixture()
  await assert.rejects(driver.restore(new TextEncoder().encode('{"type":"user"}\n')), /carries no sessionId/)
  const mixed = new TextEncoder().encode(
    `${JSON.stringify({ type: 'user', sessionId: 'a' })}\n${JSON.stringify({ type: 'user', sessionId: 'b' })}\n`,
  )
  await assert.rejects(driver.restore(mixed), /mixes 2 context ids/)
  assert.throws(() => contextIdFromPayload(mixed), /mixes 2 context ids/)
  await rm(home, { recursive: true, force: true })
})

test('a partial placement is never visible as a transcript, and the next attempt cleans it', async () => {
  const { home, contextId, driver, path } = await fixture()
  const bytes = transcript(contextId, [{ role: 'user', content: 'complete' }])
  // A previous attempt died mid-write, leaving only its staging file. The transcript itself was
  // never created, so the adapter would have found nothing rather than half a conversation.
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(`${path}.partial`, bytes.slice(0, 12))
  await assert.rejects(stat(path))

  const placement = await driver.restore(bytes)

  assert.equal(placement.checksum, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  assert.deepEqual(new Uint8Array(await readFile(path)), bytes)
  await assert.rejects(stat(`${path}.partial`), 'the staging file is gone once the placement lands')
  await rm(home, { recursive: true, force: true })
})

test('an oversized payload is refused on both sides of the round trip', async () => {
  const { home, contextId, driver, path } = await fixture()
  const oversized = new Uint8Array(33 * 1024 * 1024)
  await assert.rejects(driver.restore(oversized), /over the 33554432 byte limit/)

  await writeTranscript(path, oversized)
  await assert.rejects(driver.capture(cut(contextId)), /over the 33554432 byte limit/)
  await rm(home, { recursive: true, force: true })
})

test('an empty opening range is vacuously incorporated', async () => {
  const { home, contextId, driver } = await fixture()
  const proof = await driver.proveOpening({ w: 7, h: 7, contextId })
  assert.equal(proof.kind, 'incorporated')
  await rm(home, { recursive: true, force: true })
})

test('a non-empty range is proven by its Handoff digest appearing as a received user message', async () => {
  const { home, contextId, driver, path } = await fixture()
  const digest = createHash('sha256').update('handoff bytes').digest('hex')
  await writeTranscript(path, transcript(contextId, [
    { role: 'user', content: `agora handoff ${digest}` },
    { role: 'assistant', content: 'acknowledged' },
  ]))

  const proof = await driver.proveOpening({ w: 4, h: 9, contextId, handoffDigest: digest })

  assert.equal(proof.kind, 'incorporated')
  await rm(home, { recursive: true, force: true })
})

test('CONT-006: an absent digest is unprovable, never "not incorporated" — compaction removes exactly this record', async () => {
  const { home, contextId, driver, path } = await fixture()
  // The same content, delivered — but the transcript no longer carries the digest, which is what
  // native compaction does. Reading that as "never delivered" would authorise a resend.
  await writeTranscript(path, transcript(contextId, [{ role: 'user', content: 'the same words, no digest' }]))

  const proof = await driver.proveOpening({ w: 4, h: 9, contextId, handoffDigest: 'a'.repeat(64) })

  assert.equal(proof.kind, 'unprovable')
  await rm(home, { recursive: true, force: true })
})

test('a non-empty range with no digest to look for is unprovable, not matched on something weaker', async () => {
  const { home, contextId, driver, path } = await fixture()
  await writeTranscript(path, transcript(contextId, [{ role: 'user', content: 'anything' }]))

  const proof = await driver.proveOpening({ w: 4, h: 9, contextId })

  assert.equal(proof.kind, 'unprovable')
  assert.match(proof.kind === 'unprovable' ? proof.reason : '', /descriptor carries none/)
  await rm(home, { recursive: true, force: true })
})

test('an unreadable transcript is unprovable, not a thrown outage', async () => {
  const { home, contextId, driver } = await fixture()
  const proof = await driver.proveOpening({ w: 1, h: 2, contextId, handoffDigest: 'b'.repeat(64) })
  assert.equal(proof.kind, 'unprovable')
  await rm(home, { recursive: true, force: true })
})

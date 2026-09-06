import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { CodexCustodyDriver, CustodyRefusedError, DRIVER_REVISION, FORMAT_ID, contextIdFromPayload, rolloutFor } from '../src/driver.js'

const WORKSPACE_ROOT = '/home/agent/work'

/** A rollout shaped like the measured one: a `session_meta` line, then conversation lines. */
function rollout(contextId: string, lines: readonly Record<string, unknown>[] = []): Uint8Array {
  const meta = {
    timestamp: '2026-09-06T20:02:38.306Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: contextId, id: contextId, timestamp: '2026-09-06T20:02:38.256Z', cwd: WORKSPACE_ROOT, originator: '@agentclientprotocol/codex-acp' },
  }
  return new TextEncoder().encode([meta, ...lines].map((line) => JSON.stringify(line)).join('\n') + '\n')
}

function rolloutPath(home: string, contextId: string, day = '06'): string {
  return join(home, '.codex', 'sessions', '2026', '09', day, `rollout-2026-09-${day}T20-02-38-${contextId}.jsonl`)
}

async function fixture(): Promise<{ home: string; contextId: string; driver: CodexCustodyDriver }> {
  const home = await mkdtemp(join(tmpdir(), 'agora-codex-'))
  return { home, contextId: randomUUID(), driver: new CodexCustodyDriver({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, stabilityWindowMs: 1 }) }
}

async function write(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

const cut = (contextId: string) => ({ podUid: 'pod-uid-1', processGeneration: 0, contextId })

test('the rollout is found by the context id in its FILENAME, across the date partitions', async () => {
  const { home, contextId } = await fixture()
  await write(rolloutPath(home, randomUUID(), '05'), rollout(randomUUID()))
  await write(rolloutPath(home, contextId, '06'), rollout(contextId))

  const found = await rolloutFor(home, contextId)

  assert.ok(found?.path.includes(contextId))
  assert.match(found!.relative, /^sessions\/2026\/09\/06\/rollout-/)
  await rm(home, { recursive: true, force: true })
})

test('capture takes the one rollout, byte-exact, and nothing else in the home', async () => {
  const { home, contextId, driver } = await fixture()
  const bytes = rollout(contextId, [{ type: 'response_item', payload: { role: 'user', content: 'hello' } }])
  await write(rolloutPath(home, contextId), bytes)
  // The installation-wide state a codex home is full of — every one of these belongs to the whole
  // installation, not this context, and capturing any would move somebody else's data.
  await write(join(home, '.codex', 'auth.json'), new TextEncoder().encode('{"token":"secret"}'))
  await write(join(home, '.codex', 'state_5.sqlite'), new TextEncoder().encode('sqlite state'))
  await write(join(home, '.codex', 'session_index.jsonl'), new TextEncoder().encode('{"id":"someone-else"}'))
  await write(join(home, '.codex', 'memories_1.sqlite'), new TextEncoder().encode('memories'))

  const captured = await driver.capture(cut(contextId))

  assert.deepEqual(captured.bytes, bytes)
  assert.equal(captured.formatId, FORMAT_ID)
  assert.equal(driver.driverRevision, DRIVER_REVISION)
  assert.equal(captured.checksum, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  assert.equal(captured.frontierW, 0, 'the conservative floor, never a journal head (CONT-009)')
  const text = new TextDecoder().decode(captured.bytes)
  assert.ok(!text.includes('secret'))
  assert.ok(!text.includes('someone-else'))
  await rm(home, { recursive: true, force: true })
})

test('capture refuses a context with no rollout rather than inventing one', async () => {
  const { home, contextId, driver } = await fixture()
  await assert.rejects(driver.capture(cut(contextId)), /no rollout file for context/)
  await rm(home, { recursive: true, force: true })
})

test('a rollout still settling after the process died is waited out, not refused', async () => {
  const { home, contextId } = await fixture()
  const path = rolloutPath(home, contextId)
  await write(path, rollout(contextId))
  const driver = new CodexCustodyDriver({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, stabilityWindowMs: 30, captureTimeoutMs: 2000 })
  const settled = rollout(contextId, [{ type: 'response_item', payload: { role: 'assistant', content: 'the last flush' } }])
  const late = setTimeout(() => void write(path, settled), 15)

  const captured = await driver.capture(cut(contextId))

  clearTimeout(late)
  assert.deepEqual(captured.bytes, settled)
  await rm(home, { recursive: true, force: true })
})

test('a rollout that keeps changing past the budget is refused', async () => {
  const { home, contextId } = await fixture()
  const path = rolloutPath(home, contextId)
  await write(path, rollout(contextId))
  const driver = new CodexCustodyDriver({ harnessHome: home, workspaceRoot: WORKSPACE_ROOT, stabilityWindowMs: 5, captureTimeoutMs: 60 })
  let n = 0
  const growing = setInterval(() => {
    n += 1
    void write(path, rollout(contextId, Array.from({ length: n }, (_, i) => ({ type: 'response_item', payload: { content: `chunk ${String(i)}` } }))))
  }, 4)
  try {
    await assert.rejects(driver.capture(cut(contextId)), (error: unknown) => {
      assert.ok(error instanceof CustodyRefusedError)
      assert.equal(error.code, 'capture_refused')
      assert.match(error.reason, /still changing after 60ms/)
      return true
    })
  } finally {
    clearInterval(growing)
  }
  await rm(home, { recursive: true, force: true })
})

test('restore places the bytes under the context id the payload claims, in a home that never saw it', async () => {
  const { home, contextId, driver } = await fixture()
  const bytes = rollout(contextId, [{ type: 'response_item', payload: { role: 'user', content: 'codeword: girolle' } }])

  const placement = await driver.restore(bytes)

  assert.ok(placement.path.startsWith(join(home, '.codex', 'sessions')))
  assert.ok(placement.path.includes(contextId), 'the filename carries the context id, which is how codex finds it')
  assert.deepEqual(new Uint8Array(await readFile(placement.path)), bytes)
  await rm(home, { recursive: true, force: true })
})

test('a payload with no session_meta line is not a codex rollout and is refused', async () => {
  const { home, driver } = await fixture()
  const notARollout = new TextEncoder().encode(`${JSON.stringify({ type: 'response_item', payload: {} })}\n`)
  await assert.rejects(driver.restore(notARollout), /no session_meta line/)
  assert.throws(() => contextIdFromPayload(notARollout), /no session_meta line/)
  await rm(home, { recursive: true, force: true })
})

test('a partial placement is never visible as a rollout, and the next attempt cleans it', async () => {
  const { home, contextId, driver } = await fixture()
  const bytes = rollout(contextId)
  const path = rolloutPath(home, contextId)
  await write(`${path}.partial`, bytes.slice(0, 10))

  const placement = await driver.restore(bytes)

  assert.deepEqual(new Uint8Array(await readFile(placement.path)), bytes)
  await assert.rejects(stat(`${placement.path}.partial`))
  await rm(home, { recursive: true, force: true })
})

test('an empty opening range is vacuously incorporated; an absent digest is unprovable (CONT-006)', async () => {
  const { home, contextId, driver } = await fixture()
  const digest = 'a'.repeat(64)
  await write(rolloutPath(home, contextId), rollout(contextId, [{ type: 'response_item', payload: { role: 'user', content: `agora handoff ${digest}` } }]))

  assert.equal((await driver.proveOpening({ w: 3, h: 3, contextId })).kind, 'incorporated')
  assert.equal((await driver.proveOpening({ w: 0, h: 9, contextId, handoffDigest: digest })).kind, 'incorporated')
  assert.equal((await driver.proveOpening({ w: 0, h: 9, contextId, handoffDigest: 'b'.repeat(64) })).kind, 'unprovable')
  assert.equal((await driver.proveOpening({ w: 0, h: 9, contextId })).kind, 'unprovable', 'no digest to look for is not proof of anything')
  await rm(home, { recursive: true, force: true })
})

test('an oversized payload is refused on both sides of the round trip', async () => {
  const { home, contextId, driver } = await fixture()
  const oversized = new Uint8Array(33 * 1024 * 1024)
  await assert.rejects(driver.restore(oversized), /over the 33554432 byte limit/)
  await write(rolloutPath(home, contextId), oversized)
  await assert.rejects(driver.capture(cut(contextId)), /over the 33554432 byte limit/)
  await rm(home, { recursive: true, force: true })
})

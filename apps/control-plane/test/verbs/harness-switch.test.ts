import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase, type TestDatabase } from '@agora/testkit'
import { openSession } from '@agora/journal'
import { getAnchor, publishAnchor, recordSave } from '@agora/custody'
import { normalizeAnchor } from '@agora/observation'
import type { RestoreHarness } from '../../src/verbs/restore.js'

const CLAUDE: RestoreHarness = {
  harnessId: 'claude-code',
  supportedFormats: [{ formatId: 'claude-code-transcript', formatVersion: 1 }],
  acceptedDriverRevisions: ['claude-code-transcript-1'],
  workspaceDeps: {},
}

const CODEX: RestoreHarness = {
  harnessId: 'codex',
  supportedFormats: [{ formatId: 'codex-rollout', formatVersion: 1 }],
  acceptedDriverRevisions: ['codex-rollout-1'],
  workspaceDeps: {},
}

interface Seeded {
  readonly workstreamId: string
  readonly sessionId: string
}

async function seed(db: TestDatabase): Promise<Seeded> {
  const workstreamId = randomUUID()
  const client = await db.pool.connect()
  try {
    return await db.asRole(client, 'agora_product', async () => {
      await client.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1,$2,$3,$4)', [workstreamId, 'p', 't', randomUUID()])
      await client.query('BEGIN')
      const opened = await openSession(client, workstreamId, { podUid: `pod-${randomUUID()}`, provenance: {} })
      await client.query('COMMIT')
      return { workstreamId, sessionId: opened.sessionId }
    })
  } finally {
    client.release()
  }
}

/** Captures a Save for one harness and advances that harness's Anchor, as TURN_OFF's own steps do. */
async function captureAndAnchor(db: TestDatabase, seeded: Seeded, harness: RestoreHarness, frontierW: number): Promise<string> {
  const client = await db.pool.connect()
  try {
    return await db.asRole(client, 'agora_product', async () => {
      await client.query('BEGIN')
      const previous = await getAnchor(client, seeded.workstreamId, harness.harnessId)
      const recorded = await recordSave(
        client,
        { podUid: `pod-${harness.harnessId}-${String(frontierW)}`, processGeneration: 0, contextId: `ctx-${harness.harnessId}`, frontierW, driverRevision: harness.acceptedDriverRevisions[0]! },
        {
          workstreamId: seeded.workstreamId,
          sessionId: seeded.sessionId,
          harnessId: harness.harnessId,
          formatId: harness.supportedFormats[0]!.formatId,
          formatVersion: harness.supportedFormats[0]!.formatVersion,
          imageDigest: `sha256:${'a'.repeat(64)}`,
          byteLength: 100,
          checksum: `sha256:${String(frontierW).padStart(64, 'b')}`,
          seedPolicyRevision: 'handoff-seed-v1',
          nativeOrigin: {},
          workspaceDeps: {},
        },
      )
      const published = await publishAnchor(client, {
        workstreamId: seeded.workstreamId,
        harnessId: harness.harnessId,
        saveId: recorded.save.id,
        frontierW,
        expectedPrevious: previous?.saveId ?? null,
      })
      await client.query('COMMIT')
      assert.equal(published.kind, 'published')
      return recorded.save.id
    })
  } finally {
    client.release()
  }
}

test('CONT-007: A → B → A resumes A\'s own Anchor, and B never sees it', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)

    // --- on A (claude-code): work, then a shutdown that captures and anchors -------------------
    const savedOnA = await captureAndAnchor(db, seeded, CLAUDE, 4)

    // --- switched to B (codex): B has no Anchor of its own, so a fresh context is what SESSION
    //     selects — and A's Anchor is untouched, because Anchors are per (Workstream, harness).
    const anchorForB = await getAnchor(db.pool, seeded.workstreamId, CODEX.harnessId)
    assert.equal(anchorForB, null, 'a different harness does not inherit A\'s Anchor')
    assert.equal(normalizeAnchor({ save: null, harness: CODEX, invalidated: false }), 'none', 'so SESSION-003 selects START, not RESTORE')
    assert.equal((await getAnchor(db.pool, seeded.workstreamId, CLAUDE.harnessId))?.saveId, savedOnA, 'and A\'s Anchor is exactly where it was')

    // --- B works and is itself shut down: now both harnesses have Anchors, independently -------
    const savedOnB = await captureAndAnchor(db, seeded, CODEX, 9)
    assert.equal((await getAnchor(db.pool, seeded.workstreamId, CODEX.harnessId))?.saveId, savedOnB)
    assert.equal((await getAnchor(db.pool, seeded.workstreamId, CLAUDE.harnessId))?.saveId, savedOnA, 'B\'s capture did not publish over A')

    // --- switched back to A: A's own Anchor is found, still at its own frontier ----------------
    const backOnA = await getAnchor(db.pool, seeded.workstreamId, CLAUDE.harnessId)
    assert.equal(backOnA?.saveId, savedOnA)
    assert.equal(backOnA?.frontierW, 4, 'A resumes from what A proved, not from B\'s higher watermark')

    const save = (await db.pool.query('SELECT * FROM saves WHERE id = $1', [savedOnA])).rows[0]!
    assert.equal(
      normalizeAnchor({
        save: {
          id: save['id'] as string,
          harnessId: save['harness_id'] as string,
          formatId: save['format_id'] as string,
          formatVersion: save['format_version'] as number,
          driverRevision: save['driver_revision'] as string,
          imageDigest: save['image_digest'] as string,
          workspaceDeps: save['workspace_deps'],
        },
        harness: CLAUDE,
        invalidated: false,
      }),
      'compatible',
      'SESSION-002 selects RESTORE for A, and the range it refills starts at W = 4',
    )
  })
})

test('a Save from one harness is never compatible with another, whatever its Anchor says', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    const savedOnA = await captureAndAnchor(db, seeded, CLAUDE, 2)
    const save = (await db.pool.query('SELECT * FROM saves WHERE id = $1', [savedOnA])).rows[0]!
    const asSave = {
      id: save['id'] as string,
      harnessId: save['harness_id'] as string,
      formatId: save['format_id'] as string,
      formatVersion: save['format_version'] as number,
      driverRevision: save['driver_revision'] as string,
      imageDigest: save['image_digest'] as string,
      workspaceDeps: save['workspace_deps'],
    }

    // Even if something handed codex claude-code's Save, the format and driver decide.
    assert.equal(normalizeAnchor({ save: asSave, harness: CODEX, invalidated: false }), 'none')
    assert.equal(normalizeAnchor({ save: asSave, harness: CLAUDE, invalidated: false }), 'compatible')
  })
})

test('each harness advances its own Anchor independently, with its own frontier', async () => {
  await withTestDatabase(async (db) => {
    const seeded = await seed(db)
    await captureAndAnchor(db, seeded, CLAUDE, 1)
    await captureAndAnchor(db, seeded, CODEX, 1)
    const secondOnA = await captureAndAnchor(db, seeded, CLAUDE, 5)

    assert.equal((await getAnchor(db.pool, seeded.workstreamId, CLAUDE.harnessId))?.frontierW, 5)
    assert.equal((await getAnchor(db.pool, seeded.workstreamId, CODEX.harnessId))?.frontierW, 1, 'B\'s Anchor is not dragged forward by A\'s progress')
    assert.equal((await getAnchor(db.pool, seeded.workstreamId, CLAUDE.harnessId))?.saveId, secondOnA)
  })
})

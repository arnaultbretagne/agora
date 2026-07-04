#!/usr/bin/env node
/**
 * One-shot migration: the old per-conversation JSON files (agora ADR 0005) →
 * agora-pg (agora ADR 0009). Idempotent (ON CONFLICT DO NOTHING) — safe to re-run.
 *
 * Env: DATA_DIR (default /data), DATABASE_URL (required).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const DATA_DIR = process.env.DATA_DIR ?? '/data'
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[migrate] FATAL: DATABASE_URL is required')
  process.exit(1)
}

const CONV_DIR = join(DATA_DIR, 'conversations')
const pool = new pg.Pool({ connectionString: DATABASE_URL })

const UPSERT_CONV = `
  INSERT INTO conversations
    (id, title, pinned, kind, model, effort, agent, created_at, updated_at, spawn_count, seq, error, pipe, resolved_model)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  ON CONFLICT (id) DO NOTHING
  RETURNING id
`
const INSERT_MESSAGE = `
  INSERT INTO messages (conv_id, seq, id, role, text, ts, reply_to)
  VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (conv_id, seq) DO NOTHING
  RETURNING conv_id
`

async function migrateFile(file) {
  const conv = JSON.parse(readFileSync(join(CONV_DIR, file), 'utf8'))
  const convResult = await pool.query(UPSERT_CONV, [
    conv.id, conv.title, conv.pinned, conv.kind, conv.model,
    conv.effort ?? null, conv.agent ?? null, conv.createdAt, conv.updatedAt,
    conv.spawnCount, conv.seq, conv.error ?? null, conv.pipe ?? null, conv.resolvedModel ?? null,
  ])

  let messagesMigrated = 0
  for (const m of conv.messages ?? []) {
    const seq = Number(m.id.slice(1))
    const msgResult = await pool.query(INSERT_MESSAGE, [
      conv.id, seq, m.id, m.role, m.text, m.ts, m.replyTo ?? null,
    ])
    if (msgResult.rowCount > 0) messagesMigrated += 1
  }
  return { convMigrated: convResult.rowCount > 0, messagesMigrated }
}

async function main() {
  const files = readdirSync(CONV_DIR).filter((f) => f.endsWith('.json'))
  let migratedConvs = 0
  let skippedConvs = 0
  let migratedMessages = 0
  let hadError = false

  for (const file of files) {
    try {
      const { convMigrated, messagesMigrated } = await migrateFile(file)
      if (convMigrated) migratedConvs += 1
      else skippedConvs += 1
      migratedMessages += messagesMigrated
    } catch (err) {
      hadError = true
      console.error(`[migrate] FAILED on ${file}: ${err.message}`)
    }
  }

  console.log(`[migrate] migrated ${migratedConvs} conversations (${migratedMessages} messages), skipped ${skippedConvs} already-present`)
  await pool.end()
  if (hadError) process.exitCode = 1
}

main().catch((err) => {
  console.error('[migrate] FATAL:', err)
  process.exit(1)
})

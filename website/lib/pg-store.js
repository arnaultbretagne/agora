/**
 * Postgres-backed conversation store (agora ADR 0009, CNPG `agora-pg`). Same
 * in-memory Map and synchronous reads as the base class; mutations write
 * through to Postgres, serialised so commits land in call order. A failed
 * commit throws to the caller — the base class never catches, so DB-down is
 * loud (user-visible on send, logged on reply), never silent divergence.
 */
import pg from 'pg'
import { ConversationStore } from './store.js'

const DDL = `
CREATE TABLE IF NOT EXISTS conversations (
  id             text PRIMARY KEY,
  title          text NOT NULL,
  pinned         boolean NOT NULL DEFAULT false,
  kind           text NOT NULL,
  model          text NOT NULL,
  effort         text,
  agent          text,
  created_at     text NOT NULL,
  updated_at     text NOT NULL,
  spawn_count    integer NOT NULL DEFAULT 0,
  seq            integer NOT NULL DEFAULT 0,
  error          jsonb,
  pipe           jsonb,
  resolved_model text,
  natives        jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS messages (
  conv_id        text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  id             text NOT NULL,
  role           text NOT NULL,
  text           text NOT NULL,
  ts             text NOT NULL,
  reply_to       text,
  resolved_model text,
  PRIMARY KEY (conv_id, seq)
);
-- additive migration for tables created before per-message resolved_model (2026-07-04):
-- the exact model id that produced an assistant turn; NULL = unknown (pre-feature rows, or
-- the transcript was unreadable at reply time). Conversation-level resolved_model = "current".
ALTER TABLE messages ADD COLUMN IF NOT EXISTS resolved_model text;
`

const UPSERT_CONV = `
  INSERT INTO conversations
    (id, title, pinned, kind, model, effort, agent, created_at, updated_at, spawn_count, seq, error, pipe, resolved_model, natives)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  ON CONFLICT (id) DO UPDATE SET
    title = $2, pinned = $3, kind = $4, model = $5, effort = $6, agent = $7,
    created_at = $8, updated_at = $9, spawn_count = $10, seq = $11,
    error = $12, pipe = $13, resolved_model = $14, natives = $15
`

const INSERT_MESSAGE = `
  INSERT INTO messages (conv_id, seq, id, role, text, ts, reply_to, resolved_model)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (conv_id, seq) DO UPDATE SET resolved_model = EXCLUDED.resolved_model
`
// ^ resolved_model is the ONE mutable message field: it may be backfilled after insert when the
// supervisor's model report lands later than the reply (store.setMessageResolvedModel).

function convParams(conv) {
  return [
    conv.id, conv.title, conv.pinned, conv.kind, conv.model,
    conv.effort ?? null, conv.agent ?? null, conv.createdAt, conv.updatedAt,
    conv.spawnCount, conv.seq,
    conv.error ? JSON.stringify(conv.error) : null,
    conv.pipe ? JSON.stringify(conv.pipe) : null,
    conv.resolvedModel ?? null,
    JSON.stringify(conv.natives ?? {}),
  ]
}

function rowToConv(row, messages) {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    kind: row.kind,
    model: row.model,
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    spawnCount: row.spawn_count,
    seq: row.seq,
    ...(row.error ? { error: row.error } : {}),
    ...(row.pipe ? { pipe: row.pipe } : {}),
    ...(row.resolved_model ? { resolvedModel: row.resolved_model } : {}),
    natives: row.natives ?? {},
    messages,
  }
}

function rowToMessage(row) {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    ts: row.ts,
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    ...(row.resolved_model ? { resolvedModel: row.resolved_model } : {}),
  }
}

export class PgConversationStore extends ConversationStore {
  #chain = Promise.resolve()

  constructor(pool) {
    super()
    this.pool = pool
  }

  static async open(databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl })
    await pool.query(DDL)
    const store = new PgConversationStore(pool)
    await store.#load()
    return store
  }

  async #load() {
    const { rows: convRows } = await this.pool.query('SELECT * FROM conversations')
    const { rows: msgRows } = await this.pool.query('SELECT * FROM messages ORDER BY conv_id, seq')
    const messagesByConv = new Map()
    for (const row of msgRows) {
      if (!messagesByConv.has(row.conv_id)) messagesByConv.set(row.conv_id, [])
      messagesByConv.get(row.conv_id).push(rowToMessage(row))
    }
    for (const row of convRows) {
      this.convs.set(row.id, rowToConv(row, messagesByConv.get(row.id) ?? []))
    }
  }

  async close() {
    await this.pool.end()
  }

  /** Serialised write queue: commits land in call order; a failure rejects only its own caller. */
  #enqueue(op) {
    const run = this.#chain.then(() => op())
    this.#chain = run.catch(() => {})
    return run
  }

  async _persistConv(conv) {
    return this.#enqueue(() => this.pool.query(UPSERT_CONV, convParams(conv)))
  }

  async _persistMessage(conv, message) {
    return this.#enqueue(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(UPSERT_CONV, convParams(conv))
        await client.query(INSERT_MESSAGE, [
          conv.id, message.seq, message.id, message.role, message.text, message.ts,
          message.replyTo ?? null, message.resolvedModel ?? null,
        ])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    })
  }

  async _persistDelete(id) {
    return this.#enqueue(() => this.pool.query('DELETE FROM conversations WHERE id = $1', [id]))
  }
}

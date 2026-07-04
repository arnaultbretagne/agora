/**
 * Postgres-backed conversation store (agora ADR 0009, CNPG `agora-pg`; schema per
 * ADR 0010 "runs as facts"). Same in-memory Map and synchronous reads as the base
 * class; mutations write through to Postgres, serialised so commits land in call
 * order. A failed commit throws to the caller — the base class never catches, so
 * DB-down is loud (user-visible on send, logged on reply), never silent divergence.
 *
 * jsonb is used only where structure is open and never queried (`error`); anything
 * relational is columns/tables (ADR 0010): `runs` is the immutable journal,
 * `anchors` the mutable resume pointers into it, `live_run_id`/`live_token` the
 * ephemeral runtime lease (no FK — state managed by the hub, not a reference).
 */
import pg from 'pg'
import { ConversationStore } from './store.js'

const DDL = `
CREATE TABLE IF NOT EXISTS conversations (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  pinned      boolean NOT NULL DEFAULT false,
  created_at  text NOT NULL,
  updated_at  text NOT NULL,
  seq         integer NOT NULL DEFAULT 0,
  spawn_count integer NOT NULL DEFAULT 0,
  error       jsonb,
  live_run_id text,
  live_token  text
);
CREATE TABLE IF NOT EXISTS runs (
  id                text PRIMARY KEY,
  conv_id           text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  model             text NOT NULL,
  effort            text,
  agent             text,
  resolved_model    text,
  native_session_id text NOT NULL,
  resume            boolean NOT NULL DEFAULT false,
  spawned_at        text NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  conv_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq      integer NOT NULL,
  id       text NOT NULL,
  role     text NOT NULL,
  text     text NOT NULL,
  ts       text NOT NULL,
  reply_to text,
  run_id   text REFERENCES runs(id),
  PRIMARY KEY (conv_id, seq)
);
CREATE TABLE IF NOT EXISTS anchors (
  conv_id    text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  run_id     text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  synced_seq integer NOT NULL,
  PRIMARY KEY (conv_id, kind)
);
`

const UPSERT_CONV = `
  INSERT INTO conversations
    (id, title, pinned, created_at, updated_at, seq, spawn_count, error, live_run_id, live_token)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  ON CONFLICT (id) DO UPDATE SET
    title = $2, pinned = $3, created_at = $4, updated_at = $5,
    seq = $6, spawn_count = $7, error = $8, live_run_id = $9, live_token = $10
`

// A run is immutable except resolved_model — the one backfill (ADR 0010).
const UPSERT_RUN = `
  INSERT INTO runs
    (id, conv_id, kind, model, effort, agent, resolved_model, native_session_id, resume, spawned_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  ON CONFLICT (id) DO UPDATE SET resolved_model = $7
`

const INSERT_MESSAGE = `
  INSERT INTO messages (conv_id, seq, id, role, text, ts, reply_to, run_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (conv_id, seq) DO NOTHING
`

const UPSERT_ANCHOR = `
  INSERT INTO anchors (conv_id, kind, run_id, synced_seq)
  VALUES ($1,$2,$3,$4)
  ON CONFLICT (conv_id, kind) DO UPDATE SET run_id = $3, synced_seq = $4
`

function convParams(conv) {
  return [
    conv.id, conv.title, conv.pinned, conv.createdAt, conv.updatedAt,
    conv.seq, conv.spawnCount,
    conv.error ? JSON.stringify(conv.error) : null,
    conv.live?.runId ?? null,
    conv.live?.token ?? null,
  ]
}

function rowToConv(row, { messages, runs, anchors }) {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seq: row.seq,
    spawnCount: row.spawn_count,
    ...(row.error ? { error: row.error } : {}),
    ...(row.live_run_id ? { live: { runId: row.live_run_id, token: row.live_token } } : {}),
    runs,
    anchors,
    messages,
  }
}

function rowToRun(row) {
  return {
    id: row.id,
    kind: row.kind,
    model: row.model,
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.resolved_model ? { resolvedModel: row.resolved_model } : {}),
    nativeSessionId: row.native_session_id,
    resume: row.resume,
    spawnedAt: row.spawned_at,
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
    ...(row.run_id ? { runId: row.run_id } : {}),
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
    const { rows: runRows } = await this.pool.query('SELECT * FROM runs ORDER BY conv_id, spawned_at, id')
    const { rows: msgRows } = await this.pool.query('SELECT * FROM messages ORDER BY conv_id, seq')
    const { rows: anchorRows } = await this.pool.query('SELECT * FROM anchors')
    const runsByConv = new Map()
    for (const row of runRows) {
      if (!runsByConv.has(row.conv_id)) runsByConv.set(row.conv_id, [])
      runsByConv.get(row.conv_id).push(rowToRun(row))
    }
    const messagesByConv = new Map()
    for (const row of msgRows) {
      if (!messagesByConv.has(row.conv_id)) messagesByConv.set(row.conv_id, [])
      messagesByConv.get(row.conv_id).push(rowToMessage(row))
    }
    const anchorsByConv = new Map()
    for (const row of anchorRows) {
      if (!anchorsByConv.has(row.conv_id)) anchorsByConv.set(row.conv_id, {})
      anchorsByConv.get(row.conv_id)[row.kind] = { runId: row.run_id, syncedSeq: row.synced_seq }
    }
    for (const row of convRows) {
      this.convs.set(row.id, rowToConv(row, {
        messages: messagesByConv.get(row.id) ?? [],
        runs: runsByConv.get(row.id) ?? [],
        anchors: anchorsByConv.get(row.id) ?? {},
      }))
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

  async _persistRun(conv, run) {
    return this.#enqueue(() => this.pool.query(UPSERT_RUN, [
      run.id, conv.id, run.kind, run.model, run.effort ?? null, run.agent ?? null,
      run.resolvedModel ?? null, run.nativeSessionId, run.resume, run.spawnedAt,
    ]))
  }

  async _persistMessage(conv, message) {
    return this.#enqueue(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(UPSERT_CONV, convParams(conv))
        await client.query(INSERT_MESSAGE, [
          conv.id, message.seq, message.id, message.role, message.text, message.ts,
          message.replyTo ?? null, message.runId ?? null,
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

  async _persistAnchor(conv, kind, anchor) {
    return this.#enqueue(() => (anchor
      ? this.pool.query(UPSERT_ANCHOR, [conv.id, kind, anchor.runId, anchor.syncedSeq])
      : this.pool.query('DELETE FROM anchors WHERE conv_id = $1 AND kind = $2', [conv.id, kind])))
  }

  async _persistDelete(id) {
    return this.#enqueue(() => this.pool.query('DELETE FROM conversations WHERE id = $1', [id]))
  }
}

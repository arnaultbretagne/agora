/**
 * Conversation store — the hub-owned history, sole source of truth (ADR 0005).
 *
 * Neutral format: a conversation is `{id, title, pinned, kind, model, createdAt,
 * updatedAt, spawnCount, seq, messages: [{id, role, text, ts, replyTo?}]}` —
 * nothing harness-specific ever enters here. One JSON file per conversation,
 * written atomically (tmp + rename) on every mutation; loaded whole at boot.
 *
 * Runtime state (`live` / `starting` / `dormant`) is NOT persisted: it describes
 * the pipe, not the conversation. After a hub restart every conversation is
 * `dormant` until its channel (which reconnects on its own) claims it again.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TITLE_MAX = 44

export class ConversationStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dir = join(dataDir, 'conversations')
    mkdirSync(this.dir, { recursive: true })
    /** @type {Map<string, object>} */
    this.convs = new Map()
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const conv = JSON.parse(readFileSync(join(this.dir, f), 'utf8'))
        this.convs.set(conv.id, conv)
      } catch (err) {
        console.error(`[store] skipping unreadable ${f}: ${err.message}`)
      }
    }
  }

  #write(conv) {
    const path = join(this.dir, `${conv.id}.json`)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(conv, null, 2))
    renameSync(tmp, path)
  }

  list() {
    return [...this.convs.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  get(id) {
    return this.convs.get(id)
  }

  create({ kind, model }) {
    const now = new Date().toISOString()
    const conv = {
      id: `c-${randomUUID()}`,
      title: 'Nouvelle conversation',
      pinned: false,
      kind: kind ?? 'claude',
      model: model ?? 'default',
      createdAt: now,
      updatedAt: now,
      spawnCount: 0,
      seq: 0,
      messages: [],
    }
    this.convs.set(conv.id, conv)
    this.#write(conv)
    return conv
  }

  /** Append a message; auto-titles the conversation from its first user turn. */
  addMessage(id, { role, text, replyTo }) {
    const conv = this.#must(id)
    conv.seq += 1
    const message = {
      id: `m${conv.seq}`,
      role,
      text,
      ts: new Date().toISOString(),
      ...(replyTo ? { replyTo } : {}),
    }
    conv.messages.push(message)
    conv.updatedAt = message.ts
    if (role === 'user' && conv.messages.filter((m) => m.role === 'user').length === 1) {
      const flat = text.replace(/\s+/g, ' ').trim()
      conv.title = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat || conv.title
    }
    this.#write(conv)
    return message
  }

  patch(id, { title, pinned }) {
    const conv = this.#must(id)
    if (typeof title === 'string' && title.trim()) conv.title = title.trim().slice(0, 120)
    if (typeof pinned === 'boolean') conv.pinned = pinned
    conv.updatedAt = new Date().toISOString()
    this.#write(conv)
    return conv
  }

  /** A new runtime is being spawned for this conversation; returns the attempt #. */
  bumpSpawn(id) {
    const conv = this.#must(id)
    conv.spawnCount += 1
    this.#write(conv)
    return conv.spawnCount
  }

  /**
   * Persist the current pipe lease {token, sessionId} so a hub restart can
   * still authenticate the channel of an already-running runtime (the channel
   * reconnects on its own and re-presents this token).
   */
  setPipe(id, pipe) {
    const conv = this.#must(id)
    conv.pipe = pipe ?? undefined
    this.#write(conv)
  }

  /**
   * Mark the conversation as errored. Unlike the runtime state (live/starting/
   * dormant, derived from the pipe and never persisted), an error is an OUTCOME
   * that must survive a hub restart and stay visible until the user retries.
   */
  setError(id, reason) {
    const conv = this.#must(id)
    conv.error = { reason, ts: new Date().toISOString() }
    this.#write(conv)
  }

  /** Clear the error flag (on a new attempt or a healthy reply). Returns true if one was set. */
  clearError(id) {
    const conv = this.convs.get(id)
    if (!conv || !conv.error) return false
    delete conv.error
    this.#write(conv)
    return true
  }

  delete(id) {
    if (!this.convs.delete(id)) return false
    try {
      unlinkSync(join(this.dir, `${id}.json`))
    } catch { /* already gone */ }
    return true
  }

  #must(id) {
    const conv = this.convs.get(id)
    if (!conv) throw new Error(`unknown conversation: ${id}`)
    return conv
  }
}

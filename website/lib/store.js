/**
 * Conversation store — the hub-owned history, sole source of truth (ADR 0005).
 *
 * Neutral format: a conversation is `{id, title, pinned, kind, model, createdAt,
 * updatedAt, spawnCount, seq, natives, messages: [{id, seq, role, text, ts, replyTo?}]}`
 * — nothing harness-specific ever enters here except the opaque `natives` handle map
 * (ADR 0007: per-harness-kind last-proven native session handle).
 *
 * This base class is pure in-memory (dev / unit tests / no DATABASE_URL). Every
 * mutation is `async` and ends by calling a `_persist*` hook — a no-op here,
 * overridden by `PgConversationStore` (ADR 0009) for real durability. Reads
 * (`list`, `get`) stay synchronous — the hub's hot path is untouched.
 */
import { randomUUID } from 'node:crypto'

const TITLE_MAX = 44

export class ConversationStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.convs = new Map()
  }

  list() {
    return [...this.convs.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  get(id) {
    return this.convs.get(id)
  }

  async create({ kind, model, effort, agent }) {
    const now = new Date().toISOString()
    const conv = {
      id: `c-${randomUUID()}`,
      title: 'Nouvelle conversation',
      pinned: false,
      kind: kind ?? 'claude',
      model: model ?? 'default',
      ...(effort ? { effort } : {}),
      ...(agent ? { agent } : {}),
      createdAt: now,
      updatedAt: now,
      spawnCount: 0,
      seq: 0,
      natives: {},
      messages: [],
    }
    this.convs.set(conv.id, conv)
    await this._persistConv(conv)
    return conv
  }

  /** Append a message; auto-titles the conversation from its first user turn. */
  async addMessage(id, { role, text, replyTo }) {
    const conv = this.#must(id)
    conv.seq += 1
    const message = {
      id: `m${conv.seq}`,
      seq: conv.seq,
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
    await this._persistMessage(conv, message)
    return message
  }

  async patch(id, { title, pinned, model, effort, agent }) {
    const conv = this.#must(id)
    if (typeof title === 'string' && title.trim()) conv.title = title.trim().slice(0, 120)
    if (typeof pinned === 'boolean') conv.pinned = pinned
    // model/effort/agent are editable post-launch (topbar selectors); they take effect on
    // the NEXT spawn/turn. `effort`/`agent` clear when set to '' (back to harness default).
    if (typeof model === 'string' && model) conv.model = model
    if (typeof effort === 'string') { if (effort) conv.effort = effort; else delete conv.effort }
    if (typeof agent === 'string') { if (agent) conv.agent = agent; else delete conv.agent }
    // updatedAt reflects message activity ONLY (bumped by addMessage) — a metadata edit
    // (pin/title/model/effort/agent) must never move the conversation's sidebar sort/date-group.
    await this._persistConv(conv)
    return conv
  }

  /** A new runtime is being spawned for this conversation; returns the attempt #. */
  async bumpSpawn(id) {
    const conv = this.#must(id)
    conv.spawnCount += 1
    await this._persistConv(conv)
    return conv.spawnCount
  }

  /**
   * Persist the current pipe lease {token, sessionId} so a hub restart can
   * still authenticate the channel of an already-running runtime (the channel
   * reconnects on its own and re-presents this token).
   */
  async setPipe(id, pipe) {
    const conv = this.#must(id)
    conv.pipe = pipe ?? undefined
    await this._persistConv(conv)
  }

  /**
   * Mark the conversation as errored. Unlike the runtime state (live/starting/
   * dormant, derived from the pipe and never persisted), an error is an OUTCOME
   * that must survive a hub restart and stay visible until the user retries.
   */
  async setError(id, reason) {
    const conv = this.#must(id)
    conv.error = { reason, ts: new Date().toISOString() }
    await this._persistConv(conv)
  }

  /** Clear the error flag (on a new attempt or a healthy reply). Returns true if one was set. */
  async clearError(id) {
    const conv = this.convs.get(id)
    if (!conv || !conv.error) return false
    delete conv.error
    await this._persistConv(conv)
    return true
  }

  /**
   * Record the CONCRETE model the runtime resolved its `--model <alias>` to (e.g. the `sonnet`
   * family → `claude-sonnet-5`), read from the runtime's native transcript by the supervisor. We
   * keep BOTH: `model` (the family alias we spawn with, user-editable) and `resolvedModel` (the
   * exact id that answered — the audit truth). Returns true only when it changes, so the caller
   * broadcasts once rather than on every liveness tick.
   */
  async setResolvedModel(id, resolvedModel) {
    const conv = this.convs.get(id)
    if (!conv || !resolvedModel || conv.resolvedModel === resolvedModel) return false
    conv.resolvedModel = resolvedModel
    await this._persistConv(conv)
    return true
  }

  async delete(id) {
    if (!this.convs.delete(id)) return false
    await this._persistDelete(id)
    return true
  }

  /* Persistence hooks — no-ops here; overridden by PgConversationStore (ADR 0009). */
  async _persistConv(_conv) {}
  async _persistMessage(_conv, _message) {}
  async _persistDelete(_id) {}

  #must(id) {
    const conv = this.convs.get(id)
    if (!conv) throw new Error(`unknown conversation: ${id}`)
    return conv
  }
}

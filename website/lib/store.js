/**
 * Conversation store — the hub-owned history, sole source of truth (ADR 0005),
 * modelled per ADR 0010 ("runs as facts"):
 *
 *   conversation — identity + state: `{id, title, titleSource: 'auto'|'user', pinned,
 *     createdAt, updatedAt, seq, spawnCount, error?, live?: {runId, token},
 *     runs: [], anchors: {}, messages: []}`
 *   run — an execution FACT, immutable except `resolvedModel` (one backfill) and
 *     `nativeTitle` (the runtime's self-given topic, re-written as it drifts):
 *     `{id: '<convId>-rN', kind, model, effort?, agent?, equipmentProfile, target?,
 *       resolvedModel?, nativeTitle?, nativeSessionId, resume, spawnedAt}`
 *   message — content, pointing at its producer: `{id, seq, role, text, ts,
 *     replyTo?, runId?}` (`runId` on assistant turns only)
 *   anchor — the resume pointer (ADR 0007), one per kind: `{runId, syncedSeq}` —
 *     mutable state (advanced on reply, deleted by the fallback), like a git ref
 *     into the immutable `runs` log.
 *
 * No execution config lives on the conversation: the config travels with each
 * message (ADR 0010) and is frozen into a run at spawn.
 *
 * This base class is pure in-memory (dev / unit tests / no DATABASE_URL). Every
 * mutation is `async` and ends by calling a `_persist*` hook — a no-op here,
 * overridden by `PgConversationStore` (ADR 0009) for real durability. Reads
 * (`list`, `get`, `getRun`) stay synchronous — the hub's hot path is untouched.
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_PROFILE } from '../../shared/equipment.js'

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

  /** A run of a conversation, by id (`<convId>-rN`). */
  getRun(id, runId) {
    return this.convs.get(id)?.runs.find((r) => r.id === runId)
  }

  /** The most recent run — the fact the UI derives its selectors from (ADR 0010). */
  lastRun(id) {
    const conv = this.convs.get(id)
    return conv?.runs[conv.runs.length - 1]
  }

  /**
   * Create the conversation shell. A conversation is only ever born WITH its first
   * message (ADR 0010) — the caller (hub.startConversation) adds it in the same
   * breath; the title derives from it in addMessage.
   *
   * Where a conversation runs (its isolation) is NOT stored here: the manager owns
   * placement entirely (ADR 0011 superseded 2026-07-06), never a birth attribute of
   * the conversation.
   */
  async create() {
    const now = new Date().toISOString()
    const conv = {
      id: `c-${randomUUID()}`,
      title: 'Nouvelle conversation',
      titleSource: 'auto', // 'user' once renamed by hand — a user title outranks any derived one
      pinned: false,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      spawnCount: 0, // run-id allocator (monotonic, never reused)
      runs: [],
      anchors: {},
      messages: [],
    }
    this.convs.set(conv.id, conv)
    await this._persistConv(conv)
    return conv
  }

  /** Append a message; auto-titles the conversation from its first user turn.
   *  `runId` (assistant turns): the run that produced this message — everything
   *  per-message (model, harness, agent) derives from that run, never duplicated. */
  async addMessage(id, { role, text, replyTo, runId }) {
    const conv = this.#must(id)
    conv.seq += 1
    const message = {
      id: `m${conv.seq}`,
      seq: conv.seq,
      role,
      text,
      ts: new Date().toISOString(),
      ...(replyTo ? { replyTo } : {}),
      ...(runId ? { runId } : {}),
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

  /** Metadata only — execution config is per-message (ADR 0010), never patched. */
  async patch(id, { title, pinned }) {
    const conv = this.#must(id)
    if (typeof title === 'string' && title.trim()) {
      conv.title = title.trim().slice(0, 120)
      conv.titleSource = 'user' // an explicit rename outranks derived titles for good
    }
    if (typeof pinned === 'boolean') conv.pinned = pinned
    // updatedAt reflects message activity ONLY (bumped by addMessage) — a metadata edit
    // must never move the conversation's sidebar sort/date-group.
    await this._persistConv(conv)
    return conv
  }

  /**
   * Journal a new run (ADR 0010): allocates its id (`<convId>-rN`), freezes the spawn
   * config into it. Immutable afterwards except `resolvedModel`. The run does NOT record
   * where it executed: placement is the manager's live-state concern (ADR 0011
   * superseded 2026-07-06), read by nothing here, so not a fact worth persisting.
   *
   * Equipment (ADR 0012) freezes here like the rest: `equipmentProfile` always (the floor
   * when nothing was asked), `target` only for the profiles that take one. What the run
   * says it was equipped with is what the manager was asked for — never a live value read
   * back from a loge, which is precisely why it can be trusted as history.
   */
  async addRun(id, { kind, model, effort, agent, equipmentProfile, target, nativeSessionId, resume }) {
    const conv = this.#must(id)
    conv.spawnCount += 1
    const run = {
      id: `${id}-r${conv.spawnCount}`,
      kind,
      model,
      ...(effort ? { effort } : {}),
      ...(agent ? { agent } : {}),
      equipmentProfile: equipmentProfile ?? DEFAULT_PROFILE,
      ...(target ? { target } : {}),
      nativeSessionId,
      resume: Boolean(resume),
      spawnedAt: new Date().toISOString(),
    }
    conv.runs.push(run)
    await this._persistConv(conv) // spawnCount moved
    await this._persistRun(conv, run)
    return run
  }

  /**
   * Record the CONCRETE model a run resolved its `--model <alias>` to (e.g. `sonnet` →
   * `claude-sonnet-5`), read by the supervisor from the run's own transcript lines. One
   * write per run; every message pointing at the run derives it — retroactively correct,
   * no per-message backfill. Returns true only on change, so the caller broadcasts once.
   */
  async setRunResolvedModel(id, runId, resolvedModel) {
    const conv = this.#must(id)
    const run = conv.runs.find((r) => r.id === runId)
    if (!run || !resolvedModel || run.resolvedModel === resolvedModel) return false
    run.resolvedModel = resolvedModel
    await this._persistRun(conv, run)
    return true
  }

  /**
   * Record the topic title the runtime gave itself (claude re-titles its terminal tab
   * each turn; the supervisor reads the OSC escapes off the PTY). Unlike resolvedModel
   * this is RE-writable — the topic follows the conversation as it drifts, last write
   * wins. Returns true only on change, so the caller broadcasts once.
   */
  async setRunNativeTitle(id, runId, nativeTitle) {
    const conv = this.#must(id)
    const run = conv.runs.find((r) => r.id === runId)
    if (!run || !nativeTitle || run.nativeTitle === nativeTitle) return false
    run.nativeTitle = nativeTitle
    await this._persistRun(conv, run)
    return true
  }

  /**
   * Persist the runtime lease `{runId, token}` so a hub restart can still authenticate
   * the channel of an already-running runtime (it reconnects and re-presents the token).
   * Ephemeral state — kind/native uuid deref through the run.
   */
  async setLive(id, live) {
    const conv = this.#must(id)
    conv.live = live ?? undefined
    await this._persistConv(conv)
  }

  /**
   * Move the resume anchor for a kind (ADR 0007 / 0010): `{runId, syncedSeq}` — "resume
   * that run's native session; it faithfully holds hub history up to syncedSeq". Written
   * only on a PROVEN reply, never at spawn.
   */
  async setAnchor(id, kind, anchor) {
    const conv = this.#must(id)
    conv.anchors[kind] = anchor
    await this._persistAnchor(conv, kind, anchor)
  }

  /** Drop a kind's anchor (the transcript is dead — next reopen re-seeds, ADR 0005 floor). */
  async clearAnchor(id, kind) {
    const conv = this.#must(id)
    if (!(kind in conv.anchors)) return
    delete conv.anchors[kind]
    await this._persistAnchor(conv, kind, null)
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

  async delete(id) {
    if (!this.convs.delete(id)) return false
    await this._persistDelete(id)
    return true
  }

  /* Persistence hooks — no-ops here; overridden by PgConversationStore (ADR 0009). */
  async _persistConv(_conv) {}
  async _persistMessage(_conv, _message) {}
  async _persistRun(_conv, _run) {}
  async _persistAnchor(_conv, _kind, _anchor) {}
  async _persistDelete(_id) {}

  #must(id) {
    const conv = this.convs.get(id)
    if (!conv) throw new Error(`unknown conversation: ${id}`)
    return conv
  }
}

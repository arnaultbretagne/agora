// Delegation (docs/specs/delegation.md): an agent hands work to another through Agora's MCP server, by the gestures the
// harnesses give their own sub-agents. Two Workstreams, one gesture: a message written in the other's, by the primitive
// the person uses, Agora then deciding as for any message whether it goes into the running turn or as the next
// (docs/specs/log.md, "Messages during a turn"). A call giving more rights than the caller holds waits for the person.
// Everything is read back from the log.
import { randomUUID } from 'node:crypto'
import { offers } from '@agora/credentials'
import { isCatchUp } from './catch-up.ts'
import { canonical, identity, object, UUID } from './json.ts'
import { FROM_META } from './marks.ts'
import type { Role } from './roles.ts'
import { delegationOf, STEERING, type Execution, type State, type Turn } from './state.ts'
import type { Answer, Entry } from './store.ts'
import type { Workstreams } from './workstreams.ts'

/** An approval lives this long on Agora's clock; the call it holds hears progress this often. */
export const APPROVAL_MS = 270_000
export const PROGRESS_MS = 30_000
/** How long an approval waits for the tool line it gates to reach Agora: ten looks, 200 ms apart. */
const MATCH_TRIES = 10,
  MATCH_EVERY_MS = 200
const MAX_DEPTH = 3
const AT_ONCE = 3
/** How many `send_message` one delegate may be given since the person last wrote: every loop between two agents goes through it. */
const MAX_EXCHANGES = 10
/** What says an execution can take no prompt any more, the first of them. */
const OVER = ['execution.failed', 'execution.lost', 'execution.ended']
/** The right that opens a caller's own delegates to it; a delegate's own right reaches its delegator alone. */
const DELEGATE_RIGHT = 'agora:delegate'
/** The ids a harness gives its effort setting: Codex's is `reasoning_effort`. */
const EFFORT_IDS = ['effort', 'reasoning_effort']

/** What a tool answers instead of its result: the reason (docs/specs/delegation.md). */
export class Refused extends Error {}

export interface Caller {
  readonly workstream: string
  readonly execution: string
  readonly profiles: readonly string[]
}

type Settled = { outcome: 'approved' } | { outcome: 'refused'; words: string } | { outcome: 'expired' }

/** Who a message says wrote it (docs/specs/delegation.md, "Messages"). */
interface Mark {
  readonly workstream: string
  readonly as: 'delegator' | 'delegate' | 'agora'
  /**
   * On a delegate's last message: the turn it closes. A `submit` of the earlier contract carried the turn it was called
   * in, which then sent nothing more; a `send_message` to `parent` carries none.
   */
  readonly turn?: string
}

const line = (text: string): string => text.split('\n').map((l) => l.trim()).find((l) => l !== '')?.slice(0, 80) ?? 'Delegate'

/** A prompt's mark, on its first block, a catch-up aside: who wrote it. */
const markOf = (prompt: unknown): Record<string, unknown> | null =>
  object(object(object(Array.isArray(prompt) ? (prompt as unknown[]).find((b) => !isCatchUp(b)) : null)?._meta)?.[FROM_META])

/** What a turn says last: its text since its last tool or its reasoning, whole (docs/specs/delegation.md, "Messages"). */
export function lastMessageOf(entries: readonly Entry[], turn: Turn, next: Turn | undefined, children: ReadonlySet<string>): string {
  const from = BigInt(turn.requestPosition)
  const to = next === undefined ? null : BigInt(next.requestPosition)
  let words = ''
  let speaker: unknown
  let cut = true
  for (const e of entries) {
    // What a native sub-agent of the delegate's says is not the delegate's last message (docs/specs/log.md, "Native sub-agents").
    if (e.kind !== 'acp' || e.direction !== 'in' || e.method !== 'session/update' || children.has(String(object(e.content.params)?.sessionId))) continue
    const at = BigInt(e.position)
    if (at <= from || (to !== null && at >= to)) continue
    const update = object(object(e.content.params)?.update)
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const content = object(update.content)
      if (cut || update.messageId !== speaker) words = ''
      cut = false
      speaker = update.messageId
      if (content?.type === 'text') words += String(content.text)
    } else if (['tool_call', 'agent_thought_chunk'].includes(String(update?.sessionUpdate))) cut = true
  }
  return words.trim()
}

/** What the end of an execution says to its delegate's delegator, when it says something. */
const endOf = (e: Execution): string | null =>
  e.stopped ? 'The person stopped it.' : e.lost ? 'Its execution was lost.' : e.failed || (e.ended && !e.session) ? 'Its execution could not start.' : null

/** A message that needs no writing again: written, by now or a run before — its title may have changed since (`command_conflict`) — or nothing to write. */
const written = (answer: Answer | null): boolean => answer === null || answer.accepted || answer.reason === 'command_conflict'

export class Delegations {
  private readonly workstreams: Workstreams
  /** The delegates with an execution not ended, each with its delegator and the turns already seen to their end. */
  private readonly followed = new Map<string, { readonly delegator: string; readonly seen: Set<string> }>()
  /** The Workstreams a message of Agora's may need to continue: the attempt comes back at each beat, `quota` lifting. */
  private readonly continuing = new Set<string>()
  /** The approvals a call holds, by the caller's Workstream. */
  private readonly held = new Map<string, { position: string; settle: (s: Settled) => void }>()
  private ticking = false

  private readonly approvalMs: number
  private readonly progressMs: number
  private readonly manual: boolean
  /** The roles `spawn_agent` offers as `agent_type` (docs/specs/delegation.md, "A delegation"). */
  readonly roles: ReadonlyMap<string, Role>

  /**
   * `approvalMs` and `progressMs` are the spec's 4 min 30 s and 30 s, shorter in tests; `manual` leaves the clock to
   * whoever calls `tick(true)`: the point a test holds to order what happens. `roles`: the cards a delegate may be given.
   */
  constructor(workstreams: Workstreams, options: { approvalMs?: number; progressMs?: number; manual?: boolean; roles?: ReadonlyMap<string, Role> } = {}) {
    this.workstreams = workstreams
    this.approvalMs = options.approvalMs ?? APPROVAL_MS
    this.progressMs = options.progressMs ?? PROGRESS_MS
    this.manual = options.manual ?? false
    this.roles = options.roles ?? new Map()
    workstreams.delegations = this
  }

  private get store() {
    return this.workstreams.options.store
  }

  // ---------------------------------------------------------------- start and the clock

  /**
   * At start, before the mechanics say what ended while Agora was down: the delegates still running, what was seen of them
   * kept from the log by each message's id. One of an earlier delegation has been reported on already: nothing of its past is said.
   */
  async recover(): Promise<void> {
    const running = await this.store.writer.query(
      `SELECT DISTINCT d.workstream, w.parent, d.content ? 'caller' AS earlier FROM entries d JOIN workstreams w ON w.id = d.workstream WHERE d.kind = 'delegation.started' AND EXISTS (
         SELECT 1 FROM commands c WHERE c.workstream = d.workstream AND c.kind = 'Create' AND NOT EXISTS (
           SELECT 1 FROM entries e WHERE e.workstream = c.workstream AND e.execution = c.execution AND e.kind = 'execution.ended'))`,
    )
    for (const row of running.rows as { workstream: string; parent: string | null; earlier: boolean }[]) {
      if (row.parent !== null) this.followed.set(row.workstream, { delegator: row.parent, seen: row.earlier ? await this.past(row.workstream) : new Set() })
    }
  }

  /** At start: the messages of Agora's still waiting; the approvals no call holds any more expire. */
  async start(): Promise<void> {
    const waiting = await this.store.writer.query(
      `SELECT DISTINCT e.workstream FROM entries e WHERE e.kind = 'command' AND e.content->>'kind' = 'Write' AND e.content->>'waits' = 'true'
         AND e.content->'body'->'prompt'->0->'_meta' ? '${FROM_META}'
         AND NOT EXISTS (SELECT 1 FROM entries l WHERE l.workstream = e.workstream AND l.kind = 'acp' AND l.direction = 'out' AND l.command = e.command AND l.method = 'session/prompt')`,
    )
    for (const row of waiting.rows as { workstream: string }[]) this.continuing.add(row.workstream)
    // Every caller's, as its view shows them pending: the call that held each ended with the process before.
    const pending = await this.store.projector.query(
      "SELECT workstream, object->>'position' AS position FROM objects WHERE kind='element' AND type='question' AND object->>'kind'='approval' AND object->>'status'='pending'",
    )
    for (const row of pending.rows as { workstream: string; position: string }[]) await this.expire(row.workstream, row.position)
  }

  /** Each second: the delegates' turns ended, what to tell their delegators, the Workstreams to continue. */
  async tick(force = false): Promise<void> {
    if (this.ticking || (this.manual && !force)) return
    this.ticking = true
    try {
      for (const [delegate, known] of this.followed) await this.follow(delegate, known)
      for (const workstream of this.continuing) await this.continueIt(workstream)
    } finally {
      this.ticking = false
    }
  }

  // ---------------------------------------------------------------- a message

  /** A message of Agora's: its line, then the words, by the primitive the person uses; its Workstream continued if it must be. */
  async write(to: string, id: string, mark: Mark, agoraLine: string, words: string): Promise<Answer> {
    const answer = await this.workstreams.command(
      to,
      { id, kind: 'Write', target: {}, body: { prompt: [{ type: 'text', text: agoraLine, _meta: { [FROM_META]: mark } }, { type: 'text', text: words }], mayWait: true } },
      'agora',
    )
    // Whatever a continuation does, the message stands; `continuing` comes back to it.
    if (answer.accepted) await this.continueIt(to).catch(() => this.continuing.add(to))
    return answer
  }

  /** docs/specs/delegation.md: a new execution of a delegate, whoever asked for it, is followed from here on. */
  async created(workstream: string): Promise<void> {
    if (this.followed.has(workstream)) return
    const parent = (await this.store.writer.query('SELECT parent FROM workstreams WHERE id=$1', [workstream])).rows[0]?.parent as string | null | undefined
    if (!parent || !(await this.store.entries(workstream)).some((e) => e.kind === 'delegation.started')) return
    this.followed.set(workstream, { delegator: parent, seen: await this.past(workstream) })
  }

  /** What is already over in a delegate: nothing more to say of it. */
  private async past(delegate: string): Promise<Set<string>> {
    const state = await this.store.state(delegate)
    return new Set([
      ...[...state.turns.values()].filter((t) => !['saved', 'in_progress', 'uncertain'].includes(t.status)).map((t) => t.id),
      ...[...state.executions.values()].filter((e) => endOf(e) !== null).map((e) => identity(delegate, e.id, 'its end')),
    ])
  }

  /**
   * docs/specs/log.md, "Messages during a turn": a message of Agora's waiting, the last execution ended and not stopped: a
   * Create of Agora's own. One that took no prompt could not take this one either: only a message coming once it was over tries again.
   */
  private async continueIt(workstream: string): Promise<void> {
    const state = await this.store.state(workstream)
    const last = [...state.executions.values()].at(-1)
    const ours = state.waiting.filter((w) => markOf(object(w.content.body)?.prompt) !== null)
    // Nothing of ours waits: nothing to do. A Stop leaves it for the person's next Create, a Cancel for the next message.
    if (!last || last.stopped || state.held || ours.length === 0) {
      this.continuing.delete(workstream)
      return
    }
    // Kept until it has gone: the execution running now may end first; a question holds it back as long as it waits.
    this.continuing.add(workstream)
    if (!last.ended || state.question) return
    if (![...state.turns.values()].some((t) => t.execution === last.id)) {
      const over = (await this.store.entries(workstream)).find((e) => e.execution === last.id && OVER.includes(e.kind))!
      if (!ours.some((w) => BigInt(w.position) > BigInt(over.position))) {
        this.continuing.delete(workstream)
        return
      }
    }
    const pools = await this.workstreams.pools()
    // Its pool, or, gone with an older image, one of its harness.
    const pool = pools.find((p) => p.name === last.body.pool) ?? pools.find((p) => p.harness === last.body.harness)
    if (!pool) return
    const settings = Array.isArray(last.body.settings) ? Object.fromEntries(last.body.settings.map((s) => [String(object(s)?.id), String(object(s)?.value)])) : {}
    await this.workstreams.command(
      workstream,
      {
        id: randomUUID(),
        kind: 'Create',
        target: {},
        body: { pool: pool.name, ...(Object.keys(settings).length > 0 ? { settings } : {}), profiles: last.profiles, limits: last.body.limits },
      },
      'agora',
    )
  }

  /** A title as a line says it: as the list gives it, or from what started it. */
  private async titleOf(workstream: string, fallback = 'Delegate'): Promise<string> {
    const row = await this.store.projector.query('SELECT title FROM listings WHERE workstream=$1', [workstream])
    return String(row.rows[0]?.title ?? fallback)
  }

  // ---------------------------------------------------------------- spawn_agent

  /**
   * docs/specs/delegation.md: starts a delegate, at once or once the person approves. `progress` keeps a held call open;
   * `toolUseId` is the caller's tool line when its harness names it.
   */
  async spawn(caller: Caller, args: Readonly<Record<string, unknown>>, hold: { progress: () => void; aborted: AbortSignal; toolUseId: string | null }): Promise<string> {
    const instructions = args.instructions
    if (typeof instructions !== 'string' || instructions.trim() === '') throw new Refused('invalid_query: instructions')
    // Its role, when one is named: a card Agora holds, or nothing starts.
    const role = args.agent_type === undefined ? null : typeof args.agent_type === 'string' ? (this.roles.get(args.agent_type) ?? undefined) : undefined
    if (role === undefined) throw new Refused('unknown_agent_type')
    const found = await this.store.writer.query('SELECT depth, owner FROM workstreams WHERE id=$1', [caller.workstream])
    const depth = Number(found.rows[0]?.depth ?? 0)
    if (depth >= MAX_DEPTH) throw new Refused('depth_exceeded')
    if ((await this.working(caller.workstream)) >= AT_ONCE) throw new Refused('too_many_delegates')
    // Its place among the three, taken at once: a harness may make several calls together. An approval holds it too.
    const delegate = randomUUID()
    this.followed.set(delegate, { delegator: caller.workstream, seen: new Set() })
    try {
      return await this.started(delegate, caller, args, instructions, role, hold)
    } catch (error) {
      this.followed.delete(delegate)
      throw error
    }
  }

  private async started(
    delegate: string,
    caller: Caller,
    args: Readonly<Record<string, unknown>>,
    instructions: string,
    role: Role | null,
    hold: { progress: () => void; aborted: AbortSignal; toolUseId: string | null },
  ): Promise<string> {
    const pools = await this.workstreams.catalogue()
    const callerState = await this.store.state(caller.workstream)
    const callerExecution = callerState.executions.get(caller.execution)
    const harness = typeof args.harness === 'string' ? args.harness : (role?.harness ?? String(callerExecution?.body.harness ?? ''))
    const pool = pools.find((p) => p.harness === harness || p.name === harness)
    if (!pool) throw new Refused('unknown_harness')
    const rights = Array.isArray(args.rights) ? args.rights.map(String) : []
    const offered = this.workstreams.options.credentials?.offered ?? []
    if (offered.length > 0 && rights.some((r) => !offers(offered, r))) throw new Refused('profile_not_offered')
    const settings: Record<string, string> = {}
    // A role's model and effort are its own harness's: on another, the pool's defaults stand.
    const own = role !== null && pool.harness === role.harness ? role : null
    const wanted = { model: typeof args.model === 'string' ? args.model : (own?.model ?? null), effort: typeof args.effort === 'string' ? args.effort : (own?.effort ?? null) }
    // The effort under the name the pool gives it — `reasoning_effort` on Codex —, as the flows send it (docs/specs/flows.md, "Role cards").
    const known = Array.isArray(pool.settings) ? (pool.settings as unknown[]).map((setting) => object(setting)?.id) : []
    if (wanted.model !== null) settings.model = wanted.model
    if (wanted.effort !== null) settings[EFFORT_IDS.find((id) => known.includes(id)) ?? 'effort'] = wanted.effort
    const beyond = rights.filter((r) => !offers(caller.profiles, r))
    let approval: string | null = null
    if (beyond.length > 0) {
      const { settled, position } = await this.approve(caller, { role: role?.name ?? null, harness: String(pool.harness), ...wanted, beyond, instructions }, args, hold)
      if (settled.outcome === 'refused') throw new Refused(`refused: ${settled.words}`)
      if (settled.outcome === 'expired') throw new Refused('expired')
      approval = position
    }
    await this.store.create(delegate, null, caller.workstream)
    const limits = object(callerExecution?.body.limits) ?? {}
    const created = await this.workstreams.command(
      delegate,
      {
        id: randomUUID(),
        kind: 'Create',
        target: {},
        body: {
          pool: pool.name,
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          profiles: [...rights, 'agora:submit'],
          limits: { leaseSeconds: limits.leaseSeconds, turnCapSeconds: limits.turnCapSeconds },
        },
      },
      'agora',
    )
    if (!created.accepted) throw new Refused(String(created.reason ?? 'unavailable'))
    // Recorded once its execution is accepted: a Create refused (`quota`) leaves an empty sub-stream, never listed, never followed.
    await this.workstreams.record(delegate, {
      kind: 'delegation.started',
      content: { delegator: caller.workstream, delegatorExecution: caller.execution, harness: pool.harness, pool: pool.name, settings, rights, ...(role !== null ? { agentType: role.name } : {}), ...(approval !== null ? { approval } : {}) },
    })
    const written = await this.fromDelegator(caller.workstream, delegate, instructions, role)
    if (!written.accepted) throw new Refused(written.reason)
    return `started ${delegate} · ${line(instructions)}`
  }

  // ---------------------------------------------------------------- send_message

  /**
   * docs/specs/delegation.md, "Messages": the words, written in the other's Workstream — one of the caller's delegates',
   * whatever it is doing, or `parent`, its own delegator's.
   */
  async send(caller: Caller, args: Readonly<Record<string, unknown>>): Promise<string> {
    const message = args.message
    if (typeof message !== 'string' || message.trim() === '') throw new Refused('invalid_query: message')
    if (typeof args.to !== 'string' || args.to.trim() === '') throw new Refused('invalid_query: to')
    const to = args.to.trim().toLowerCase()
    const delegator = await this.delegatorOf(caller.workstream)
    if (to === 'parent' || (delegator !== null && to === delegator)) {
      if (delegator === null) throw new Refused('no_delegator')
      const written = await this.fromDelegate(delegator, caller.workstream, randomUUID(), message, null)
      if (!written.accepted) throw new Refused(written.reason)
      return 'sent'
    }
    await this.mine(caller, to)
    if ((await this.exchanges(caller.workstream, to)) >= MAX_EXCHANGES) throw new Refused('too_many_exchanges: the person has to write first')
    if (!this.followed.has(to)) this.followed.set(to, { delegator: caller.workstream, seen: await this.past(to) })
    const written = await this.fromDelegator(caller.workstream, to, message)
    if (!written.accepted) throw new Refused(written.reason)
    return `sent ${to} · ${await this.titleOf(to, line(message))}`
  }

  /** The Workstream that started this one by `spawn_agent`, or null: a delegate's delegator. */
  private async delegatorOf(workstream: string): Promise<string | null> {
    const found = await this.store.writer.query(
      "SELECT w.parent FROM workstreams w WHERE w.id = $1 AND w.parent IS NOT NULL AND EXISTS (SELECT 1 FROM entries e WHERE e.workstream = w.id AND e.kind = 'delegation.started')",
      [workstream],
    )
    return (found.rows[0]?.parent as string | undefined) ?? null
  }

  /** `to`, one of the caller's delegates the person has not stopped: `not_a_delegate`, `delegate_stopped` otherwise. */
  private async mine(caller: Caller, to: string): Promise<void> {
    // A delegate's own right reaches its delegator alone (docs/specs/mcp.md, "The path").
    if (!UUID.test(to) || !caller.profiles.includes(DELEGATE_RIGHT)) throw new Refused('not_a_delegate')
    const delegate = await this.store.writer.query(
      "SELECT 1 FROM workstreams w WHERE w.id = $1 AND w.parent = $2 AND EXISTS (SELECT 1 FROM entries e WHERE e.workstream = w.id AND e.kind = 'delegation.started')",
      [to, caller.workstream],
    )
    if (delegate.rowCount === 0) throw new Refused('not_a_delegate')
    if ((await this.store.state(to)).current?.stopped) throw new Refused('delegate_stopped')
  }

  // ---------------------------------------------------------------- stop_agent, list_agents

  /**
   * docs/specs/delegation.md, "Stopping and listing": the delegate's turn in progress or uncertain cancelled, by a Cancel
   * of Agora's that names its delegator; with no such turn, nothing is done.
   */
  async stop(caller: Caller, args: Readonly<Record<string, unknown>>): Promise<string> {
    if (typeof args.to !== 'string' || args.to.trim() === '') throw new Refused('invalid_query: to')
    const to = args.to.trim().toLowerCase()
    await this.mine(caller, to)
    const title = await this.titleOf(to)
    // Twice at most: the turn seen may end, and the next start, between the look and the Cancel.
    for (let tries = 0; tries < 2; tries++) {
      const state = await this.store.state(to)
      const turn = state.active
      if (!turn || !state.current || !['in_progress', 'uncertain'].includes(turn.status)) return `no turn to stop ${to} · ${title}`
      const cancelled = await this.workstreams.command(
        to,
        { id: randomUUID(), kind: 'Cancel', target: { execution: state.current.id, turn: turn.id }, body: { from: { workstream: caller.workstream, as: 'delegator' } } },
        'agora',
      )
      if (cancelled.accepted) return `stopped ${to} · ${title}`
      if (cancelled.reason === 'stopped') throw new Refused('delegate_stopped')
      if (cancelled.reason !== 'stale_turn') throw new Refused(String(cancelled.reason ?? 'unavailable'))
    }
    return `no turn to stop ${to} · ${title}`
  }

  /**
   * docs/specs/delegation.md, "Stopping and listing": the caller's delegates, the most recently changed first, each as its
   * row says it; one just started has no row yet, and is read from the log.
   */
  async list(caller: Caller): Promise<string> {
    const mine = await this.store.writer.query(
      "SELECT w.id FROM workstreams w WHERE w.parent = $1 AND EXISTS (SELECT 1 FROM entries e WHERE e.workstream = w.id AND e.kind = 'delegation.started')",
      [caller.workstream],
    )
    const ids = (mine.rows as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) return 'no delegate'
    const rows = await this.store.projector.query("SELECT workstream, title, row->>'delegation' AS delegation, changed_at FROM listings WHERE workstream = ANY($1::uuid[])", [ids])
    const listed = new Map((rows.rows as { workstream: string; title: string | null; delegation: string | null; changed_at: Date | string }[]).map((r) => [r.workstream, r]))
    const out: { id: string; title: string; state: string; at: number }[] = []
    for (const id of ids) {
      const row = listed.get(id)
      if (row?.delegation) out.push({ id, title: row.title ?? 'Delegate', state: row.delegation, at: new Date(row.changed_at).getTime() })
      else out.push({ id, title: row?.title ?? 'Delegate', state: delegationOf(await this.store.state(id)), at: Number.MAX_SAFE_INTEGER })
    }
    out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    return out.map((d) => `${d.id} · ${d.title} · ${d.state}`).join('\n')
  }

  /** The `send_message` a delegate was given since the person last wrote, in its Workstream or its delegator's; its first message is not one. */
  private async exchanges(delegator: string, delegate: string): Promise<number> {
    const writes = async (workstream: string) => (await this.store.entries(workstream)).filter((e) => e.kind === 'command' && e.content.kind === 'Write')
    const [ours, theirs] = [await writes(delegator), await writes(delegate)]
    const since = [...ours, ...theirs].filter((e) => markOf(object(e.content.body)?.prompt) === null).reduce((latest, e) => Math.max(latest, Date.parse(e.time)), 0)
    return theirs.slice(1).filter((e) => markOf(object(e.content.body)?.prompt)?.as === 'delegator' && Date.parse(e.time) > since).length
  }

  /** A delegator's words; with a role, its first message opens on the role's persona (docs/specs/delegation.md, "Messages": Agora's line). */
  private fromDelegator(delegator: string, delegate: string, words: string, role: Role | null = null): Promise<Answer> {
    const from = `From your delegator ${delegator}, an agent, not the person. It receives your last message:`
    const opening = role === null ? from : `From Agora, not the person: your role, \`${role.name}\`.\n\n${role.persona}\n\n---\n\n${from}`
    return this.write(delegate, randomUUID(), { workstream: delegator, as: 'delegator' }, opening, words)
  }

  /** The caller's delegates awaiting approval or working (docs/specs/delegation.md, "A delegation"). */
  private async working(caller: string): Promise<number> {
    let count = 0
    for (const [delegate, known] of this.followed) {
      if (known.delegator !== caller) continue
      const state = await this.store.state(delegate)
      // From its Cancel on, a turn holds no place: its agent may take its time to say it stopped.
      if (delegationOf(state) === 'working' && !(state.held && state.active)) count++
    }
    return count
  }

  // ---------------------------------------------------------------- approval

  /** Holds the call until the person approves, writes, or the approval expires (docs/specs/delegation.md, "Approval"). */
  private async approve(
    caller: Caller,
    proposal: { role: string | null; harness: string; model: string | null; effort: string | null; beyond: string[]; instructions: string },
    args: Readonly<Record<string, unknown>>,
    hold: { progress: () => void; aborted: AbortSignal; toolUseId: string | null },
  ): Promise<{ settled: Settled; position: string }> {
    // A harness may give its tool line just after its call: looked for again a moment, then asked without one.
    let toolCallId = hold.toolUseId ?? (await this.match(caller.workstream, args))
    for (let tries = 0; toolCallId === null && tries < MATCH_TRIES && !hold.aborted.aborted; tries++) {
      await new Promise((resolve) => setTimeout(resolve, MATCH_EVERY_MS))
      toolCallId = await this.match(caller.workstream, args)
    }
    const expiresAt = new Date(Date.now() + this.approvalMs).toISOString()
    const body = [
      `${proposal.role !== null ? `Role \`${proposal.role}\`: ` : ''}**${proposal.harness}**${proposal.model ? `, ${proposal.model}` : ''}${proposal.effort ? `, effort ${proposal.effort}` : ''}`,
      '',
      `Rights beyond the caller's: ${proposal.beyond.map((r) => `\`${r}\``).join(', ')}`,
      '',
      proposal.instructions
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n'),
    ].join('\n')
    const asked = await this.workstreams.command(
      caller.workstream,
      {
        id: randomUUID(),
        kind: 'Ask',
        target: {},
        body: {
          kind: 'approval',
          title: line(proposal.instructions).slice(0, 200),
          text: body,
          options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }],
          ...(toolCallId !== null ? { toolCallId } : {}),
          expiresAt,
        },
      },
      'agora',
    )
    if (!asked.accepted) throw new Refused(asked.reason === 'question_pending' ? 'approval_pending' : String(asked.reason ?? 'unavailable'))
    const position = (await this.store.state(caller.workstream)).question?.position ?? ''
    const settled = await new Promise<Settled>((resolve) => {
      const progress = setInterval(() => hold.progress(), this.progressMs)
      const finish = (s: Settled) => {
        clearInterval(progress)
        clearTimeout(timer)
        this.held.delete(caller.workstream)
        resolve(s)
      }
      const timer = setTimeout(() => void this.expire(caller.workstream, position).then(() => finish({ outcome: 'expired' })), this.approvalMs)
      this.held.set(caller.workstream, { position, settle: finish })
      // A call its client gave up: nothing it asked may start.
      hold.aborted.addEventListener('abort', () => void this.expire(caller.workstream, position).then(() => finish({ outcome: 'expired' })), { once: true })
    })
    return { settled, position }
  }

  /** The workstreams' hook: an approval answered by the person, or refused by a Write. */
  settled(workstream: string, position: string, outcome: 'approved' | 'refused', words?: string): void {
    const held = this.held.get(workstream)
    if (held?.position !== position) return
    held.settle(outcome === 'approved' ? { outcome } : { outcome, words: words ?? '' })
  }

  private async expire(workstream: string, position: string): Promise<void> {
    const state = await this.store.state(workstream)
    if (state.question?.position !== position) return
    await this.workstreams.record(workstream, { kind: 'question.expired', content: { question: position } })
  }

  /** The caller's tool line a call came from, when its harness does not name it: running, `spawn_agent`, the same arguments. */
  private async match(caller: string, args: Readonly<Record<string, unknown>>): Promise<string | null> {
    const found = await this.store.projector.query(
      "SELECT object::text FROM objects WHERE workstream=$1 AND kind='element' AND type='tool' ORDER BY first_position DESC LIMIT 20",
      [caller],
    )
    const wanted = canonical(args)
    for (const row of found.rows as { object: string }[]) {
      const tool = object(JSON.parse(row.object))
      if (!tool || !['pending', 'in_progress'].includes(String(tool.status)) || !/spawn_agent/i.test(String(tool.title ?? ''))) continue
      // Its input, or the arguments of the MCP call it wraps (`{ server, tool, arguments }`).
      const input = object(tool.rawInput)
      if ([input, object(input?.arguments)].some((v) => v !== null && canonical(v) === wanted) && typeof tool.toolCallId === 'string') return tool.toolCallId
    }
    return null
  }

  // ---------------------------------------------------------------- what a delegate says

  private async fromDelegate(delegator: string, delegate: string, id: string, words: string, turn: string | null): Promise<Answer> {
    return this.write(delegator, id, { workstream: delegate, as: 'delegate', ...(turn !== null ? { turn } : {}) }, `From your delegate ${delegate} "${await this.titleOf(delegate)}", not the person:`, words)
  }

  // ---------------------------------------------------------------- what comes back by itself

  /** One delegate, one beat: each turn seen to its end once, then what its execution became; forgotten once it has ended and all is said. */
  private async follow(delegate: string, known: { readonly delegator: string; readonly seen: Set<string> }): Promise<void> {
    const state = await this.store.state(delegate)
    const turns = [...state.turns.values()]
    let said = true
    for (const [i, turn] of turns.entries()) {
      if (known.seen.has(turn.id) || ['saved', 'in_progress', 'uncertain'].includes(turn.status)) continue
      if (written(await this.turnEnded(delegate, known.delegator, state, turn, turns[i + 1]))) known.seen.add(turn.id)
      else said = false
    }
    for (const e of state.executions.values()) {
      const what = endOf(e)
      const id = identity(delegate, e.id, 'its end')
      if (what === null || known.seen.has(id)) continue
      if (written(await this.notice(known.delegator, delegate, id, what))) known.seen.add(id)
      else said = false
    }
    // A next execution, whoever asks for it, is followed again.
    if (said && state.current?.ended && !state.active) this.followed.delete(delegate)
  }

  /**
   * docs/specs/delegation.md, "Messages" and "What Agora writes", each written once whatever a restart does: its command's
   * id comes from what it is about. The end of an execution says the end of its turn.
   */
  private async turnEnded(delegate: string, delegator: string, state: State, turn: Turn, next: Turn | undefined): Promise<Answer | null> {
    const e = state.executions.get(turn.execution)
    const entries = await this.store.entries(delegate)
    if (turn.status === 'failed') {
      // The agent's error message, or the closed reason of a failure of Agora's.
      const why = object(turn.failure)?.message ?? turn.failure
      return e?.lost || e?.failed || e?.stopped ? null : this.notice(delegator, delegate, identity(delegate, turn.id, 'failed'), `Its turn failed${typeof why === 'string' ? `: ${why}` : ''}.`)
    }
    if (turn.status === 'cancelled') {
      // Its delegator's own `stop_agent` is told nothing: its call's answer said it.
      const ours = entries.some((x) => x.kind === 'command' && x.content.kind === 'Cancel' && object(x.content.target)?.turn === turn.id && object(object(x.content.body)?.from)?.as === 'delegator')
      return e?.stopped || ours ? null : this.notice(delegator, delegate, identity(delegate, turn.id, 'cancelled'), 'The person cancelled its turn.')
    }
    if (!this.holdsAnothers(entries, turn, next)) return null
    // A turn of the earlier contract in which the delegate called `submit` sent nothing more: said then, said for good.
    if ((await this.store.entries(delegator)).some((x) => x.kind === 'command' && x.content.kind === 'Write' && markOf(object(x.content.body)?.prompt)?.workstream === delegate && markOf(object(x.content.body)?.prompt)?.turn === turn.id)) return null
    const words = lastMessageOf(entries, turn, next, new Set(state.children.keys()))
    const id = identity(delegate, turn.id, 'last message')
    return words === '' ? this.notice(delegator, delegate, id, 'It ended its turn with nothing to say.') : this.fromDelegate(delegator, delegate, id, words, turn.id)
  }

  /** A turn holding a message that is not the person's: its prompt's, or one sent into it. */
  private holdsAnothers(entries: readonly Entry[], turn: Turn, next: Turn | undefined): boolean {
    const prompt = entries.find((e) => e.position === turn.requestPosition)
    if (markOf(object(prompt?.content.params)?.prompt) !== null) return true
    const to = next === undefined ? null : BigInt(next.requestPosition)
    return entries.some((e) => {
      if (e.kind !== 'acp' || e.direction !== 'in' || e.correlated_method !== STEERING || object(e.content.result)?.outcome !== 'injected' || e.request_position === null) return false
      const at = BigInt(e.position)
      if (at <= BigInt(turn.requestPosition) || (to !== null && at >= to)) return false
      return markOf(object(entries.find((x) => x.position === e.request_position)?.content.params)?.prompt) !== null
    })
  }

  /** A message `as` `agora`: what a delegate cannot tell its delegator (docs/specs/delegation.md, "What Agora writes"). */
  private async notice(delegator: string, delegate: string, id: string, what: string): Promise<Answer> {
    return this.write(delegator, id, { workstream: delegate, as: 'agora' }, 'From Agora, not the person:', `Your delegate ${delegate} "${await this.titleOf(delegate)}": ${what}`)
  }
}

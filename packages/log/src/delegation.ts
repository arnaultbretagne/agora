// Delegation (docs/specs/delegation.md): an agent hands work to another through Agora's MCP server. `delegate` starts a
// delegate — a sub-stream of the caller's Workstream — or continues one; a call giving more rights than the caller holds
// waits for the person; a typed result comes through `submit`; each outcome goes back to the caller as a report, once
// the caller is free. Everything is read back from the log: a step is a fact in the delegate's Workstream, its
// instructions a prompt marked with that step, its result and its report facts beside it.
import { randomUUID } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { offers } from '@agora/credentials'
import { canonical, object } from './json.ts'
import { DELEGATION_META, REPORT_META } from './marks.ts'
import type { State } from './state.ts'
import type { Entry } from './store.ts'
import type { Workstreams } from './workstreams.ts'

/** An approval lives this long on Agora's clock; the call it holds hears progress this often. */
export const APPROVAL_MS = 270_000
export const PROGRESS_MS = 30_000
/** How long an approval waits for the tool line it gates to reach Agora: ten looks, 200 ms apart. */
const MATCH_TRIES = 10,
  MATCH_EVERY_MS = 200
const MAX_DEPTH = 3
const AT_ONCE = 3
const LAST_WORDS = 2_000
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'additionalProperties'])
const ajv = new Ajv2020({ strict: false, allErrors: true })

/** What a tool answers instead of its result: the reason (docs/specs/delegation.md). */
export class Refused extends Error {}

export interface Caller {
  readonly workstream: string
  readonly execution: string
  readonly profiles: readonly string[]
}

type Settled = { outcome: 'approved' } | { outcome: 'refused'; words: string } | { outcome: 'expired' }

/** A step of a delegation: the fact that asked for it, its instructions, its schema. */
interface Step {
  readonly position: string
  readonly instructions: string
  readonly schema: Record<string, unknown> | null
}

/** Why a schema cannot be a delegation's `output_schema`, or null when it can (docs/specs/delegation.md, "Typed results"). */
export function schemaRefusal(schema: unknown): string | null {
  const root = object(schema)
  if (root === null || root.type !== 'object') return 'invalid_schema'
  const walk = (node: unknown): boolean => {
    if (typeof node === 'boolean') return true
    const o = object(node)
    if (o === null) return false
    for (const [key, value] of Object.entries(o)) {
      if (!KEYWORDS.has(key)) return false
      if (key === 'properties') {
        const properties = object(value)
        if (properties === null || !Object.values(properties).every(walk)) return false
      }
      if ((key === 'items' || key === 'additionalProperties') && !walk(value)) return false
    }
    return true
  }
  if (!walk(root)) return 'invalid_schema'
  try {
    ajv.compile(root)
  } catch {
    return 'invalid_schema'
  }
  return null
}

const line = (text: string): string => text.split('\n').map((l) => l.trim()).find((l) => l !== '')?.slice(0, 80) ?? 'Delegate'
const text = (blocks: unknown): string =>
  (Array.isArray(blocks) ? blocks : [])
    .map((b) => object(b))
    .filter((b) => b?.type === 'text')
    .map((b) => String(b!.text))
    .join('\n')
const markOf = (entry: Entry, key: string): Record<string, unknown> | null => {
  const blocks = object(entry.content.params)?.prompt
  if (!Array.isArray(blocks)) return null
  for (const block of blocks) {
    const mark = object(object(object(block)?._meta)?.[key])
    if (mark !== null) return mark
  }
  return null
}

export class Delegations {
  private readonly workstreams: Workstreams
  /**
   * The delegates with an outcome not yet reported, each to its caller's Workstream: the others need nothing more until
   * `to` gives them a step. A new entry per step, so that one forgotten as reported is never a step just given.
   */
  private readonly delegates = new Map<string, { readonly caller: string }>()
  /** The approvals a call holds, by the caller's Workstream. */
  private readonly held = new Map<string, { position: string; settle: (s: Settled) => void }>()
  private ticking = false

  private readonly approvalMs: number
  private readonly progressMs: number
  private readonly manual: boolean

  /**
   * `approvalMs` and `progressMs` are the spec's 4 min 30 s and 30 s, shorter in tests; `manual` leaves the clock to
   * whoever calls `tick(true)`: the point a test holds to order what happens.
   */
  constructor(workstreams: Workstreams, options: { approvalMs?: number; progressMs?: number; manual?: boolean } = {}) {
    this.workstreams = workstreams
    this.approvalMs = options.approvalMs ?? APPROVAL_MS
    this.progressMs = options.progressMs ?? PROGRESS_MS
    this.manual = options.manual ?? false
    workstreams.delegations = this
  }

  private get store() {
    return this.workstreams.options.store
  }

  // ---------------------------------------------------------------- start and the clock

  /** At start: the delegates with a step not yet reported, from the log; the approvals no call holds any more expire. */
  async start(): Promise<void> {
    const found = await this.store.writer.query(
      `SELECT d.workstream, d.content->>'caller' AS caller FROM entries d WHERE d.kind = 'delegation.started' AND EXISTS (
         SELECT 1 FROM entries s WHERE s.workstream = d.workstream AND s.kind IN ('delegation.started', 'delegation.continued') AND NOT EXISTS (
           SELECT 1 FROM entries r WHERE r.workstream = s.workstream AND r.kind = 'delegation.reported' AND r.content->>'step' = s.position::text))`,
    )
    for (const row of found.rows as { workstream: string; caller: string | null }[]) if (row.caller !== null) this.delegates.set(row.workstream, { caller: row.caller })
    // Every caller's, as its view shows them pending: the call that held each ended with the process before.
    const pending = await this.store.projector.query(
      "SELECT workstream, object->>'position' AS position FROM objects WHERE kind='element' AND type='question' AND object->>'kind'='approval' AND object->>'status'='pending'",
    )
    for (const row of pending.rows as { workstream: string; position: string }[]) await this.expire(row.workstream, row.position)
  }

  /** Each second: instructions to write, reminders to send, outcomes to report. */
  async tick(force = false): Promise<void> {
    if (this.ticking || (this.manual && !force)) return
    this.ticking = true
    try {
      const due = new Map<string, { delegate: string; step: Step; outcome: string }[]>()
      for (const [delegate, known] of this.delegates) {
        const outcomes = await this.advance(delegate)
        // Every step reported: forgotten, unless `to` gave it another meanwhile.
        if (outcomes === null) {
          if (this.delegates.get(delegate) === known) this.delegates.delete(delegate)
          continue
        }
        for (const outcome of outcomes) {
          const list = due.get(known.caller) ?? []
          list.push({ delegate, ...outcome })
          due.set(known.caller, list)
        }
      }
      for (const [caller, outcomes] of due) await this.deliver(caller, outcomes)
    } finally {
      this.ticking = false
    }
  }

  // ---------------------------------------------------------------- delegate

  /**
   * docs/specs/delegation.md: starts a delegate, or continues one with `to`, at once or once the person approves.
   * `progress` keeps a held call open; `toolUseId` is the caller's tool line when its harness names it.
   */
  async delegate(caller: Caller, args: Readonly<Record<string, unknown>>, hold: { progress: () => void; aborted: AbortSignal; toolUseId: string | null }): Promise<string> {
    const instructions = args.instructions
    if (typeof instructions !== 'string' || instructions.trim() === '') throw new Refused('invalid_query: instructions')
    const schema = args.output_schema === undefined || args.output_schema === null ? null : args.output_schema
    if (schema !== null) {
      const refusal = schemaRefusal(schema)
      if (refusal !== null) throw new Refused(refusal)
    }
    if (args.to !== undefined && args.to !== null) return this.continueDelegate(caller, String(args.to), instructions, schema as Record<string, unknown> | null, args)
    const found = await this.store.writer.query('SELECT depth, owner FROM workstreams WHERE id=$1', [caller.workstream])
    const depth = Number(found.rows[0]?.depth ?? 0)
    if (depth >= MAX_DEPTH) throw new Refused('depth_exceeded')
    if ((await this.working(caller.workstream)) >= AT_ONCE) throw new Refused('too_many_delegates')
    const pools = await this.workstreams.catalogue()
    const callerState = await this.store.state(caller.workstream)
    const callerExecution = callerState.executions.get(caller.execution)
    const harness = typeof args.harness === 'string' ? args.harness : String(callerExecution?.body.harness ?? '')
    const pool = pools.find((p) => p.harness === harness || p.name === harness)
    if (!pool) throw new Refused('unknown_harness')
    const rights = Array.isArray(args.rights) ? args.rights.map(String) : []
    const offered = this.workstreams.options.credentials?.offered ?? []
    if (offered.length > 0 && rights.some((r) => !offers(offered, r))) throw new Refused('profile_not_offered')
    const settings: Record<string, string> = {}
    for (const id of ['model', 'effort'] as const) if (typeof args[id] === 'string') settings[id] = String(args[id])
    const beyond = rights.filter((r) => !offers(caller.profiles, r))
    let approval: string | null = null
    if (beyond.length > 0) {
      const { settled, position } = await this.approve(caller, { harness: String(pool.harness), settings, beyond, instructions, schema }, args, hold)
      if (settled.outcome === 'refused') throw new Refused(`refused: ${settled.words}`)
      if (settled.outcome === 'expired') throw new Refused('expired')
      approval = position
    }
    const delegate = randomUUID()
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
          profiles: [...rights, ...(schema !== null ? ['agora:submit'] : [])],
          limits: { leaseSeconds: limits.leaseSeconds, turnCapSeconds: limits.turnCapSeconds },
        },
      },
      'agora',
    )
    if (!created.accepted) throw new Refused(String(created.reason ?? 'unavailable'))
    // Recorded once its execution is accepted: a Create refused (`quota`) leaves an empty sub-stream, never listed, never followed.
    await this.workstreams.record(delegate, {
      kind: 'delegation.started',
      content: {
        caller: caller.workstream,
        callerExecution: caller.execution,
        harness: pool.harness,
        pool: pool.name,
        settings,
        rights,
        instructions,
        ...(schema !== null ? { output_schema: schema } : {}),
        ...(approval !== null ? { approval } : {}),
      },
    })
    this.delegates.set(delegate, { caller: caller.workstream })
    return `started ${delegate} · ${line(instructions)}`
  }

  /** `to`: the next message of one of the caller's delegates, once its turn has ended. */
  private async continueDelegate(caller: Caller, to: string, instructions: string, schema: Record<string, unknown> | null, args: Readonly<Record<string, unknown>>): Promise<string> {
    for (const key of ['harness', 'model', 'effort', 'rights']) if (args[key] !== undefined && args[key] !== null) throw new Refused(`invalid_query: ${key}`)
    const delegate = await this.store.writer.query(
      "SELECT 1 FROM workstreams w WHERE w.id = $1 AND w.parent = $2 AND EXISTS (SELECT 1 FROM entries e WHERE e.workstream = w.id AND e.kind = 'delegation.started')",
      [to, caller.workstream],
    )
    if (delegate.rowCount === 0) throw new Refused('not_a_delegate')
    const state = await this.store.state(to)
    if (state.active || (await this.pending(to)).length > 0) throw new Refused('delegate_busy')
    await this.workstreams.record(to, { kind: 'delegation.continued', content: { instructions, ...(schema !== null ? { output_schema: schema } : {}) } })
    this.delegates.set(to, { caller: caller.workstream })
    return `started ${to} · ${line(instructions)}`
  }

  /** The caller's delegates awaiting approval or working (docs/specs/delegation.md, "A delegation"). */
  private async working(caller: string): Promise<number> {
    let count = this.held.has(caller) ? 1 : 0
    for (const [delegate, known] of this.delegates) {
      if (known.caller !== caller) continue
      const state = await this.store.state(delegate)
      if (state.current && !state.current.ended && (state.active || (await this.pending(delegate)).length > 0)) count++
    }
    return count
  }

  // ---------------------------------------------------------------- approval

  /** Holds the call until the person approves, writes, or the approval expires (docs/specs/delegation.md, "Approval"). */
  private async approve(
    caller: Caller,
    proposal: { harness: string; settings: Record<string, string>; beyond: string[]; instructions: string; schema: unknown },
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
      `**${proposal.harness}**${proposal.settings.model ? `, ${proposal.settings.model}` : ''}${proposal.settings.effort ? `, effort ${proposal.settings.effort}` : ''}`,
      '',
      `Rights beyond the caller's: ${proposal.beyond.map((r) => `\`${r}\``).join(', ')}`,
      '',
      proposal.instructions
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n'),
      ...(proposal.schema !== null ? ['', 'A result of this shape:', '```json', JSON.stringify(proposal.schema, null, 2), '```'] : []),
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

  /** The caller's tool line a call came from, when its harness does not name it: running, `delegate`, the same arguments. */
  private async match(caller: string, args: Readonly<Record<string, unknown>>): Promise<string | null> {
    const found = await this.store.projector.query(
      "SELECT object::text FROM objects WHERE workstream=$1 AND kind='element' AND type='tool' ORDER BY first_position DESC LIMIT 20",
      [caller],
    )
    const wanted = canonical(args)
    for (const row of found.rows as { object: string }[]) {
      const tool = object(JSON.parse(row.object))
      if (!tool || !['pending', 'in_progress'].includes(String(tool.status)) || !/delegate/i.test(String(tool.title ?? ''))) continue
      // Its input, or the arguments of the MCP call it wraps (`{ server, tool, arguments }`).
      const input = object(tool.rawInput)
      if ([input, object(input?.arguments)].some((v) => v !== null && canonical(v) === wanted) && typeof tool.toolCallId === 'string') return tool.toolCallId
    }
    return null
  }

  // ---------------------------------------------------------------- submit

  /** The schema `submit` takes now, for a delegate asked for a result; null when none is asked. */
  async schemaOf(delegate: string): Promise<Record<string, unknown> | null> {
    const step = await this.current(delegate)
    return step?.schema ?? null
  }

  /** docs/specs/delegation.md, "Typed results": the result, checked against the step's schema. */
  async submit(caller: Caller, args: Readonly<Record<string, unknown>>): Promise<string> {
    const step = await this.current(caller.workstream)
    if (step === null || step.schema === null) throw new Refused('not_allowed')
    const check = ajv.compile(step.schema)
    if (!check(args)) throw new Refused(`invalid_result: ${(check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ')}`)
    const state = await this.store.state(caller.workstream)
    await this.workstreams.record(caller.workstream, { kind: 'delegation.result', content: { step: step.position, turn: state.active?.id ?? null, result: args } })
    return 'submitted'
  }

  // ---------------------------------------------------------------- the steps, read back from the log

  private async steps(delegate: string): Promise<{ entries: readonly Entry[]; state: State; steps: Step[] }> {
    const entries = await this.store.entries(delegate)
    const state = await this.store.state(delegate)
    const steps: Step[] = []
    for (const entry of entries) {
      if (entry.kind !== 'delegation.started' && entry.kind !== 'delegation.continued') continue
      const content = object(entry.content) ?? {}
      steps.push({ position: entry.position, instructions: String(content.instructions ?? ''), schema: object(content.output_schema) })
    }
    return { entries, state, steps }
  }

  /** The steps whose instructions are not written yet. */
  private async pending(delegate: string): Promise<Step[]> {
    const { entries, steps } = await this.steps(delegate)
    const marked = new Set(
      entries
        .filter((e) => e.kind === 'acp' && e.direction === 'out' && e.method === 'session/prompt')
        .map((e) => markOf(e, DELEGATION_META)?.step)
        .filter((s) => s !== undefined)
        .map(String),
    )
    return steps.filter((s) => !marked.has(s.position))
  }

  /** The step the delegate works on now: the last whose instructions were written. */
  private async current(delegate: string): Promise<Step | null> {
    const { entries, steps } = await this.steps(delegate)
    const marked = entries.filter((e) => e.kind === 'acp' && e.direction === 'out' && e.method === 'session/prompt').map((e) => markOf(e, DELEGATION_META)?.step)
    const last = [...marked].reverse().find((s) => s !== undefined)
    return steps.find((s) => s.position === String(last)) ?? null
  }

  /**
   * One delegate, one beat: its instructions written when it can take them, a reminder when a result is missing, and
   * the outcomes not yet reported; null once every step is reported.
   */
  private async advance(delegate: string): Promise<{ step: Step; outcome: string }[] | null> {
    const { entries, state, steps } = await this.steps(delegate)
    const prompts = entries.filter((e) => e.kind === 'acp' && e.direction === 'out' && e.method === 'session/prompt')
    const reported = new Set(entries.filter((e) => e.kind === 'delegation.reported').map((e) => String(object(e.content)?.step)))
    if (steps.every((step) => reported.has(step.position))) return null
    const results = entries.filter((e) => e.kind === 'delegation.result')
    const outcomes: { step: Step; outcome: string }[] = []
    for (const step of steps) {
      if (reported.has(step.position)) continue
      const prompt = prompts.find((p) => String(markOf(p, DELEGATION_META)?.step) === step.position)
      if (!prompt) {
        const e = state.current
        if (e && (e.failed || e.lost)) outcomes.push({ step, outcome: `failed: the delegate's execution ${e.failed ? 'failed' : 'was lost'} before its instructions` })
        else await this.write(delegate, state, step)
        break
      }
      const turn = [...state.turns.values()].find((t) => t.requestPosition === prompt.position)
      if (!turn || !['done', 'failed', 'cancelled'].includes(turn.status)) break
      const result = results.findLast((r) => String(object(r.content)?.step) === step.position)
      if (turn.status === 'done' && step.schema !== null && result === undefined) {
        const reminder = prompts.find((p) => String(markOf(p, REPORT_META)?.reminds) === step.position)
        if (!reminder) {
          await this.remind(delegate, state, step)
          break
        }
        const after = [...state.turns.values()].find((t) => t.requestPosition === reminder.position)
        if (!after || !['done', 'failed', 'cancelled'].includes(after.status)) break
      }
      outcomes.push({ step, outcome: await this.describe(delegate, turn.status, result, turn.failure, step.schema !== null) })
    }
    return outcomes
  }

  /** An outcome as the report gives it (docs/specs/delegation.md, "Reports"). */
  private async describe(delegate: string, status: string, result: Entry | undefined, failure: unknown, asked: boolean): Promise<string> {
    if (status === 'failed') return `failed${failure ? `: ${JSON.stringify(failure).slice(0, 300)}` : ''}`
    if (status === 'cancelled') return 'cancelled'
    if (result !== undefined) return `completed, result: ${JSON.stringify(object(result.content)?.result)}`
    if (asked) return `completed with no result${await this.lastWords(delegate)}`
    return `completed${await this.lastWords(delegate)}`
  }

  /** The delegate's last message, cut to 2,000 characters. */
  private async lastWords(delegate: string): Promise<string> {
    const last = await this.store.projector.query(
      "SELECT object->>'text' AS text FROM objects WHERE workstream=$1 AND kind='element' AND type='agent_message_chunk' ORDER BY first_position DESC LIMIT 1",
      [delegate],
    )
    const words = String(last.rows[0]?.text ?? '').trim()
    return words ? `, its last message: ${words.length > LAST_WORDS ? `${words.slice(0, LAST_WORDS)}…` : words}` : ', with no message'
  }

  /** Writes a step's instructions once the delegate can take a message; continues its execution if it has ended. */
  private async write(delegate: string, state: State, step: Step): Promise<void> {
    const caller = this.delegates.get(delegate)!.caller
    const e = state.current
    if (!e || e.ended) return this.resume(delegate, state)
    if (!e.session || state.active) return
    await this.workstreams.command(
      delegate,
      {
        id: randomUUID(),
        kind: 'Write',
        target: { execution: e.id, session: e.session },
        body: { prompt: [{ type: 'text', text: step.instructions, _meta: { [DELEGATION_META]: { caller, step: step.position } } }] },
      },
      'agora',
    )
  }

  /** A result was asked and none came: written once (docs/specs/delegation.md, "Typed results"). */
  private async remind(delegate: string, state: State, step: Step): Promise<void> {
    const e = state.current
    if (!e || e.ended || !e.session || state.active) return
    await this.workstreams.command(
      delegate,
      {
        id: randomUUID(),
        kind: 'Write',
        target: { execution: e.id, session: e.session },
        body: { prompt: [{ type: 'text', text: 'From Agora: you were asked for a result: call submit with it.', _meta: { [REPORT_META]: { delegates: [], reminds: step.position } } }] },
      },
      'agora',
    )
  }

  /** An execution that has ended, continued in the same Workstream with what it had (docs/specs/log.md, "Continuing"). */
  private async resume(workstream: string, state: State): Promise<void> {
    const last = [...state.executions.values()].at(-1)
    if (!last || !last.ended) return
    await this.workstreams.command(
      workstream,
      {
        id: randomUUID(),
        kind: 'Create',
        target: {},
        body: {
          pool: last.body.pool,
          ...(last.body.settings !== undefined ? { settings: Object.fromEntries((Array.isArray(last.body.settings) ? last.body.settings : []).map((s) => [String(object(s)?.configId ?? object(s)?.id), String(object(s)?.value)])) } : {}),
          profiles: last.profiles,
          limits: last.body.limits,
        },
      },
      'agora',
    )
  }

  /** A report to the caller, once free: every outcome in one prompt, then each recorded as reported. */
  private async deliver(caller: string, outcomes: { delegate: string; step: Step; outcome: string }[]): Promise<void> {
    const state = await this.store.state(caller)
    const e = state.current
    if (!e || e.ended) return this.resume(caller, state)
    if (!e.session || state.active || state.question || state.permissions.size > 0) return
    const titles = await this.store.projector.query('SELECT workstream, title FROM listings WHERE workstream = ANY($1)', [outcomes.map((o) => o.delegate)])
    const titleOf = new Map((titles.rows as { workstream: string; title: string }[]).map((r) => [r.workstream, r.title]))
    const report = [
      'From Agora, not the person:',
      ...outcomes.map(
        (o) => `- ${o.delegate} "${titleOf.get(o.delegate) ?? line(o.step.instructions)}": ${o.outcome}${/[.!?]$/.test(o.outcome) ? '' : '.'} Read ${o.delegate} for the rest.`,
      ),
    ].join('\n')
    const id = randomUUID()
    const written = await this.workstreams.command(
      caller,
      {
        id,
        kind: 'Write',
        target: { execution: e.id, session: e.session },
        body: { prompt: [{ type: 'text', text: report, _meta: { [REPORT_META]: { delegates: outcomes.map((o) => o.delegate) } } }] },
      },
      'agora',
    )
    if (!written.accepted) return
    for (const o of outcomes) await this.workstreams.record(o.delegate, { kind: 'delegation.reported', content: { step: o.step.position, report: id } })
  }
}

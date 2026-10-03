// From the objects to what the screen shows (docs/specs/assistant-ui.md, "Messages", "The Workstream's
// state"): assistant-ui messages, the composer's state, the notices' texts. Pure, like objects.ts.
import type { ThreadMessageLike } from '@assistant-ui/react'
import { after, ofKind, type Json, type ThreadState, type ViewObject } from './objects.ts'

type Part = Exclude<ThreadMessageLike['content'], string>[number]
type Status = NonNullable<ThreadMessageLike['status']>

export type WorkstreamState = 'none' | 'starting' | 'ready' | 'interrupted' | 'stopped' | 'lost' | 'failed' | 'ended'
export type TurnStatus = 'saved' | 'in_progress' | 'done' | 'cancelled' | 'failed' | 'uncertain'

export interface WorkstreamView {
  readonly id: string
  readonly title: string
  readonly state: WorkstreamState
  readonly pool: string | null
  readonly harness: string | null
  readonly execution: string | null
  readonly session: string | null
  readonly anchor: string | null
  /** When the view last changed, as the server stamps it; absent before any entry. */
  readonly changedAt?: string | null
  /** The last Session's settings, its commands, and whether a change is unanswered (docs/specs/log.md). */
  readonly settings?: readonly Setting[] | null
  readonly commands?: readonly AgentCommand[]
  readonly configuring?: boolean
}

export interface Setting {
  readonly id: string
  readonly name: string
  readonly category: string | null
  readonly type: string
  readonly currentValue: unknown
  readonly options: readonly { readonly value: string; readonly name: string; readonly description: string | null }[]
}

export interface AgentCommand {
  readonly name: string
  readonly description: string
  readonly hint: string | null
}

const HARNESS_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', mock: 'Mock agent' }

/** A harness as people name it. */
export const harnessName = (harness: string | null | undefined): string => (harness ? (HARNESS_NAMES[harness] ?? harness) : 'the agent')

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const json = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const byPosition = (a: ViewObject, b: ViewObject): number => {
  const pa = text(a.object.firstPosition) || '0',
    pb = text(b.object.firstPosition) || '0'
  return after(pa, pb) ? 1 : after(pb, pa) ? -1 : 0
}

export function workstreamOf(state: ThreadState, id: string): WorkstreamView {
  const o = state.objects.get(id)?.object ?? {}
  return {
    id,
    title: text(o.title) || 'New workstream',
    state: (text(o.state) || 'none') as WorkstreamState,
    pool: text(o.pool) || null,
    harness: text(o.harness) || null,
    execution: text(o.execution) || null,
    session: text(o.session) || null,
    anchor: text(o.anchor) || null,
    settings: Array.isArray(o.settings) ? (o.settings as Setting[]) : null,
    commands: Array.isArray(o.commands) ? (o.commands as AgentCommand[]) : [],
    configuring: o.configuring === true,
  }
}

const turnsOf = (state: ThreadState): ViewObject[] =>
  ofKind(state, 'turn').sort((a, b) => {
    const pa = text(a.object.requestPosition),
      pb = text(b.object.requestPosition)
    return after(pa, pb) ? 1 : after(pb, pa) ? -1 : 0
  })

const status = (turn: ViewObject): TurnStatus => text(turn.object.status) as TurnStatus

// ---------------------------------------------------------------- the composer

export interface Composer {
  /** Sending is offered: a Write, or a Create then a Write. */
  readonly open: boolean
  /** Sending starts an execution first: none yet, or the last one is over. */
  readonly create: boolean
  /** Why sending is not offered, when it is not. */
  readonly reason: string | null
  /** The last turn is saved or in progress. */
  readonly running: boolean
  /** The turn a Cancel targets: in progress or uncertain. */
  readonly cancellable: ViewObject | null
  readonly uncertain: ViewObject | null
  readonly pendingPermission: ViewObject | null
}

const STATE_REASON: Record<WorkstreamState, string | null> = {
  none: null,
  starting: 'Starting the sandbox…',
  ready: null,
  interrupted: 'Reconnecting to the sandbox…',
  stopped: 'Stopped. The sandbox ends at its deadline.',
  lost: 'The sandbox was lost. It ends at its deadline; then a new one can start.',
  failed: null,
  ended: null,
}

/** The states in which no execution runs: sending starts one. */
const IDLE: readonly WorkstreamState[] = ['none', 'failed', 'ended']

export function composerOf(state: ThreadState, view: WorkstreamView): Composer {
  const turns = turnsOf(state)
  const last = turns.at(-1)
  const active = turns.find((t) => ['saved', 'in_progress', 'uncertain'].includes(status(t))) ?? null
  const uncertain = active && status(active) === 'uncertain' ? active : null
  const pendingPermission =
    ofKind(state, 'element').find((e) => e.object.type === 'permission' && e.object.status === 'pending' && e.object.session === view.session) ?? null
  const running = last !== undefined && ['saved', 'in_progress'].includes(status(last))
  const cancellable = turns.find((t) => ['in_progress', 'uncertain'].includes(status(t))) ?? null
  const settling = view.state === 'ready' && view.configuring === true
  const reason = !state.complete
    ? 'Loading…'
    : STATE_REASON[view.state] ??
      (pendingPermission
        ? 'Answer the permission request above.'
        : settling
          ? 'Applying the settings…'
          : uncertain
            ? 'The end of the last turn could not be confirmed.'
            : null)
  const create = state.complete && IDLE.includes(view.state)
  const open = create || (state.complete && view.state === 'ready' && active === null && pendingPermission === null && !settling)
  return { open, create, reason: open ? null : reason, running, cancellable, uncertain, pendingPermission }
}

// ---------------------------------------------------------------- notices

const LOST: Record<string, string> = {
  adapter_exited: "The agent's process exited",
  claim_missing: 'The sandbox disappeared',
  claim_conflict: 'The sandbox was replaced',
  instance_changed: 'The sandbox was replaced',
}

const FAILED: Record<string, string> = {
  startup_failed: 'The sandbox could not start',
  restore_failed: 'The saved session could not be restored',
  anchor_missing: 'The saved session was not found',
  credentials_refused: "The agent's credentials were refused",
}

const REQUEST: Record<string, string> = {
  response_timeout: 'The agent did not answer in time.',
  deadline_refused: "The sandbox's deadline could not be extended.",
  transport_error: 'A message could not reach the sandbox.',
}

/** A Session's end says nothing the execution's own notice does not, unless another replaced it. */
export const shownNotice = (notice: Json): boolean => notice.type !== 'session.ended' || notice.reason === 'replaced'

export function noticeText(notice: Json, first: boolean): string {
  const reason = text(notice.reason)
  switch (notice.type) {
    case 'session.opened':
      if (notice.origin !== 'new') return `Session restored with ${harnessName(text(notice.harness))}: the agent remembers the history above.`
      return first
        ? `Session started with ${harnessName(text(notice.harness))}.`
        : `New session with ${harnessName(text(notice.harness))}: the agent does not know the history above.`
    case 'session.ended':
      return reason === 'replaced' ? 'Another session replaced this one.' : 'The session ended.'
    case 'execution.break':
      return 'The connection to the sandbox was interrupted.'
    case 'request.failed':
      return REQUEST[reason] ?? 'A request to the agent failed.'
    case 'execution.lost':
      return `${LOST[reason] ?? 'The sandbox was lost'}. The history is kept.`
    case 'execution.failed':
      return `${FAILED[reason] ?? 'The execution could not start'}.`
    case 'execution.ended':
      return 'The sandbox has ended.'
    default:
      return text(notice.type)
  }
}

// ---------------------------------------------------------------- parts

/** ACP spells permission kinds with an underscore, assistant-ui with a dash. */
export const optionKind = (kind: unknown): string => text(kind).replace(/_/g, '-')

function approvalOf(permission: ViewObject, title: string): NonNullable<Extract<Part, { type: 'tool-call' }>['approval']> {
  const p = permission.object
  const params = json(p.params) ?? {}
  const options = list(params.options).map((o) => json(o) ?? {})
  const outcome = json(json(p.answer)?.outcome)
  const cancelled = p.status === 'cancelled' || outcome?.outcome === 'cancelled'
  const chosen = outcome?.outcome === 'selected' ? options.find((o) => o.optionId === outcome.optionId) : undefined
  return {
    id: permission.id,
    prompt: title,
    options: options.map((o) => ({ id: text(o.optionId), kind: optionKind(o.kind), label: text(o.name) })),
    ...(cancelled
      ? { resolution: 'cancelled' as const }
      : chosen
        ? { approved: optionKind(chosen.kind).startsWith('allow'), optionId: text(chosen.optionId) }
        : {}),
  }
}

function contentText(content: unknown): string {
  return list(content)
    .map((c) => json(json(c)?.content))
    .filter((c) => c?.type === 'text')
    .map((c) => text(c!.text))
    .join('\n')
}

const diffsOf = (content: unknown): Json[] => list(content).map((c) => json(c)).filter((c): c is Json => c?.type === 'diff')

function toolPart(tool: Json, permission: ViewObject | undefined): Part {
  const done = tool.status === 'completed' || tool.status === 'failed'
  const title = text(tool.title) || text(tool.kind) || 'Tool'
  const input = json(tool.rawInput)
  const output = tool.rawOutput === undefined ? contentText(tool.content) : typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2)
  // An agent may send the change only with the permission it asks for it.
  const diffs = diffsOf(tool.content)
  const asked = diffs.length === 0 && permission ? diffsOf(json(json(permission.object.params)?.toolCall)?.content) : []
  const todos = list(input?.todos).map((t) => json(t)).filter((t): t is Json => typeof t?.content === 'string')
  return {
    type: 'tool-call',
    toolCallId: text(tool.toolCallId),
    toolName: text(tool.kind) || 'other',
    args: (input ?? {}) as never,
    argsText: input ? JSON.stringify(input, null, 2) : '',
    // A closed tool always carries a result: without one, assistant-ui shows it running.
    ...(done ? { result: output || '(no output)' } : {}),
    isError: tool.status === 'failed',
    artifact: {
      title,
      kind: text(tool.kind) || 'other',
      status: text(tool.status) || 'pending',
      locations: list(tool.locations),
      diffs: diffs.length > 0 ? diffs : asked,
      ...(todos.length > 0 ? { todos: todos.map((t) => ({ content: text(t.content), status: text(t.status) })) } : {}),
    },
    ...(permission ? { approval: approvalOf(permission, title) } : {}),
  }
}

function partsOf(elements: ViewObject[]): Part[] {
  const permissions = new Map<string, ViewObject>()
  for (const e of elements)
    if (e.object.type === 'permission') permissions.set(text(json(json(e.object.params)?.toolCall)?.toolCallId), e)
  const tools = new Set(elements.filter((e) => e.object.type === 'tool').map((e) => text(e.object.toolCallId)))
  const parts: Part[] = []
  for (const e of elements) {
    const o = e.object
    if (o.type === 'agent_message_chunk') parts.push({ type: 'text', text: text(o.text) })
    else if (o.type === 'agent_thought_chunk') parts.push({ type: 'reasoning', text: text(o.text) })
    else if (o.type === 'tool') parts.push(toolPart(o, permissions.get(text(o.toolCallId))))
    else if (o.type === 'plan') parts.push({ type: 'data', name: 'plan', data: { entries: list(o.entries) } as never })
    else if (o.type === 'permission') {
      const call = json(json(o.params)?.toolCall) ?? {}
      if (!tools.has(text(call.toolCallId))) parts.push(toolPart(call, e))
    }
  }
  return parts
}

function failureOf(turn: Json): string {
  const failure = turn.failure
  if (typeof failure === 'string') return `The request failed (${failure}).`
  const message = text(json(failure)?.message)
  return message || 'The execution ended before the answer.'
}

function assistantStatus(turn: ViewObject, pending: boolean): Status {
  switch (status(turn)) {
    case 'saved':
      return { type: 'running' }
    case 'in_progress':
      // A pending permission is what makes ToolFallback show its buttons.
      return pending ? { type: 'requires-action', reason: 'tool-calls' } : { type: 'running' }
    case 'done':
      return { type: 'complete', reason: 'stop' }
    case 'cancelled':
      return { type: 'incomplete', reason: 'cancelled' }
    case 'failed':
      return { type: 'incomplete', reason: 'error', error: failureOf(turn.object) }
    case 'uncertain':
      return { type: 'incomplete', reason: 'other', error: 'The end of this turn could not be confirmed.' }
  }
}

// ---------------------------------------------------------------- plan and commands

export interface PlanItem {
  readonly id: string
  readonly text: string
  readonly status: 'pending' | 'active' | 'done'
}

const PLAN_STATUS: Record<string, PlanItem['status']> = { pending: 'pending', in_progress: 'active', completed: 'done' }

export function planItems(entries: unknown): PlanItem[] {
  return list(entries).map((e, i) => ({ id: String(i), text: text(json(e)?.content), status: PLAN_STATUS[text(json(e)?.status)] ?? 'pending' }))
}

/** What **Continue** sends: Create with the ended execution's pool and anchor. */
export function continueBody(view: WorkstreamView): Json | null {
  return view.state === 'ended' && view.pool && view.anchor ? { pool: view.pool, anchor: view.anchor } : null
}

/**
 * The Create that a message sent with no execution running starts: in the same pool as the last one,
 * from its anchor when there is one, so the agent remembers; in another pool, from nothing.
 */
export function createBody(view: WorkstreamView, pool: string): Json {
  return view.pool === pool && continueBody(view) !== null ? continueBody(view)! : { pool }
}

/**
 * A first message waits for the Session its Create opens: written once that execution is ready, given
 * back if it fails, ends or is lost first.
 */
export function firstMessageStep(execution: string, view: WorkstreamView, complete: boolean): 'wait' | 'write' | 'give back' {
  if (!complete || view.execution !== execution) return 'wait'
  if (view.state === 'failed' || view.state === 'ended' || view.state === 'lost') return 'give back'
  return view.state === 'ready' && view.session !== null ? 'write' : 'wait'
}

// ---------------------------------------------------------------- settings and commands

/** The values a picker offers: the real ones, never `default`. */
const real = (setting: Setting | undefined) => (setting?.options ?? []).filter((o) => o.value !== 'default')

export interface ModelChoice {
  readonly model: Setting | undefined
  readonly effort: Setting | undefined
  readonly models: Setting['options']
  readonly efforts: Setting['options']
  /** The values shown as chosen. */
  readonly current: { readonly model: string | null; readonly effort: string | null }
}

/**
 * What the model picker offers (docs/specs/assistant-ui.md, "Settings and commands"): the setting in
 * category `model` and the one in `thought_level`, without `default`. Chosen: what was picked here,
 * else the value the Session starts with or has, when it is a real one.
 */
export function modelChoice(settings: readonly Setting[] | null | undefined, chosen: Readonly<Record<string, string>> = {}): ModelChoice {
  const model = settings?.find((s) => s.category === 'model')
  const effort = settings?.find((s) => s.category === 'thought_level')
  const value = (s: Setting | undefined): string | null => {
    if (!s) return null
    const v = chosen[s.id] ?? (typeof s.currentValue === 'string' ? s.currentValue : null)
    return v !== null && real(s).some((o) => o.value === v) ? v : null
  }
  return { model, effort, models: real(model), efforts: real(effort), current: { model: value(model), effort: value(effort) } }
}

/**
 * A pool's settings as a draft sees them: what its last Session offered, each current value the one
 * its Sessions start with, when the pool declares one.
 */
export function poolSettings(pool: { sessionConfig?: readonly { id: string; value: string }[]; settings?: readonly Setting[] | null } | undefined): Setting[] | null {
  if (!pool?.settings) return null
  return pool.settings.map((s) => {
    const declared = pool.sessionConfig?.find((w) => w.id === s.id)
    return declared ? { ...s, currentValue: declared.value } : s
  })
}

/** The commands `/` lists: while the composer holds `/` and a name being typed, those it starts. */
export function commandsMatching(commands: readonly AgentCommand[], text: string): AgentCommand[] {
  const typed = /^\/(\S*)$/.exec(text)
  if (typed === null) return []
  const prefix = typed[1]!.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix))
}

// ---------------------------------------------------------------- the list

export interface Section {
  readonly label: string
  readonly workstreams: readonly WorkstreamView[]
}

const DAY = 86_400_000

/**
 * The Workstreams by when they last changed: today, yesterday, the past week, then older. One with no
 * entry is left out, unless it is the one open; a search keeps the titles that contain it.
 */
export function sections(workstreams: readonly WorkstreamView[], now: Date, search: string, current: string | null): Section[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const wanted = search.trim().toLowerCase()
  const groups: { label: string; from: number }[] = [
    { label: 'Today', from: midnight },
    { label: 'Yesterday', from: midnight - DAY },
    { label: 'Previous 7 days', from: midnight - 7 * DAY },
    { label: 'Older', from: -Infinity },
  ]
  const out = groups.map((g) => ({ label: g.label, workstreams: [] as WorkstreamView[] }))
  for (const w of workstreams) {
    if (w.state === 'none' && w.id !== current) continue
    if (wanted !== '' && !w.title.toLowerCase().includes(wanted)) continue
    const at = w.changedAt ? Date.parse(w.changedAt) : now.getTime()
    out[groups.findIndex((g) => at >= g.from)]!.workstreams.push(w)
  }
  return out.filter((s) => s.workstreams.length > 0)
}

// ---------------------------------------------------------------- messages

export function messagesOf(state: ThreadState): ThreadMessageLike[] {
  const elements = ofKind(state, 'element').sort(byPosition)
  const placed: { position: string; messages: ThreadMessageLike[] }[] = []
  for (const turn of turnsOf(state)) {
    const own = elements.filter((e) => e.object.turn === turn.id)
    const prompt = own.find((e) => e.object.type === 'user')
    const custom = { turnStatus: status(turn), turn: turn.id }
    const pending = own.some((e) => e.object.type === 'permission' && e.object.status === 'pending')
    placed.push({
      position: text(turn.object.requestPosition),
      messages: [
        {
          id: `${turn.id}:user`,
          role: 'user',
          content: [{ type: 'text', text: list(prompt?.object.content).map((b) => json(b)).filter((b) => b?.type === 'text').map((b) => text(b!.text)).join('\n') }],
          metadata: { custom },
        },
        {
          id: `${turn.id}:assistant`,
          role: 'assistant',
          content: partsOf(own.filter((e) => e.object.type !== 'user')),
          status: assistantStatus(turn, pending),
          metadata: { custom },
        },
      ],
    })
  }
  let sessions = 0
  const notices = ofKind(state, 'notice').sort(byPosition)
  // A break the execution's loss or end follows is explained by it: only the end is shown.
  const explained = new Set(
    notices
      .filter((n, i) => {
        if (n.object.type !== 'execution.break') return false
        const next = notices.slice(i + 1).find((m) => m.object.execution === n.object.execution)
        return next !== undefined && ['execution.lost', 'execution.ended'].includes(text(next.object.type))
      })
      .map((n) => n.id),
  )
  for (const notice of notices) {
    if (!shownNotice(notice.object) || explained.has(notice.id)) continue
    const first = notice.object.type === 'session.opened' && notice.object.origin === 'new' && sessions++ === 0
    placed.push({
      position: text(notice.object.firstPosition),
      messages: [
        {
          id: notice.id,
          role: 'system',
          content: [{ type: 'text', text: noticeText(notice.object, first) }],
          metadata: { custom: { notice: notice.object.type, reason: notice.object.reason ?? null } },
        },
      ],
    })
  }
  return placed.sort((a, b) => (after(a.position, b.position) ? 1 : after(b.position, a.position) ? -1 : 0)).flatMap((p) => p.messages)
}

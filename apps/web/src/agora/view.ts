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
}

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
  /** Write is offered. */
  readonly open: boolean
  /** Why it is not, when it is not. */
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
  interrupted: 'Connection to the sandbox lost, reconnecting…',
  stopped: 'Stopped. The sandbox ends at its deadline.',
  lost: 'The sandbox was lost.',
  failed: 'The execution could not start.',
  ended: null,
}

export function composerOf(state: ThreadState, view: WorkstreamView): Composer {
  const turns = turnsOf(state)
  const last = turns.at(-1)
  const active = turns.find((t) => ['saved', 'in_progress', 'uncertain'].includes(status(t))) ?? null
  const uncertain = active && status(active) === 'uncertain' ? active : null
  const pendingPermission =
    ofKind(state, 'element').find((e) => e.object.type === 'permission' && e.object.status === 'pending' && e.object.session === view.session) ?? null
  const running = last !== undefined && ['saved', 'in_progress'].includes(status(last))
  const cancellable = turns.find((t) => ['in_progress', 'uncertain'].includes(status(t))) ?? null
  const reason = !state.complete
    ? 'Loading…'
    : STATE_REASON[view.state] ??
      (pendingPermission ? 'Answer the permission request first.' : uncertain ? 'The end of the last turn could not be confirmed.' : null)
  const open = state.complete && view.state === 'ready' && active === null && pendingPermission === null
  return { open, reason: open ? null : reason, running, cancellable, uncertain, pendingPermission }
}

// ---------------------------------------------------------------- notices

export function noticeText(notice: Json, first: boolean): string {
  const reason = text(notice.reason)
  switch (notice.type) {
    case 'session.opened':
      if (notice.origin !== 'new') return 'Session restored: the agent remembers the history above.'
      return first ? `Session started with ${text(notice.harness) || 'the harness'}.` : 'New session: the agent does not know the history above.'
    case 'session.ended':
      return `Session ended (${reason}).`
    case 'execution.break':
      return 'Connection to the sandbox lost, reconnecting…'
    case 'request.failed':
      return `A request failed (${reason}).`
    case 'execution.lost':
      return `The sandbox was lost (${reason}). The history is kept.`
    case 'execution.failed':
      return `The execution could not start (${reason}).`
    case 'execution.ended':
      return 'The execution has ended.'
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

function toolPart(tool: Json, permission: ViewObject | undefined): Part {
  const done = tool.status === 'completed' || tool.status === 'failed'
  const title = text(tool.title) || text(tool.kind) || 'Tool'
  const input = json(tool.rawInput)
  const output = tool.rawOutput === undefined ? contentText(tool.content) : typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2)
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
      locations: list(tool.locations),
      diffs: list(tool.content).map((c) => json(c)).filter((c) => c?.type === 'diff'),
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
  for (const notice of ofKind(state, 'notice').sort(byPosition)) {
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

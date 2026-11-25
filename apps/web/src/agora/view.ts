// From the objects to what the screen shows (docs/specs/assistant-ui.md, "Messages", "The Workstream's
// state"): assistant-ui messages, the composer's state, the notices' texts. Pure, like objects.ts.
import type { ThreadMessageLike } from '@assistant-ui/react'
import { attachmentsOf, promptCapabilitiesOf, type PromptCapabilities } from './attachments.ts'
import { after, ofKind, type Json, type ThreadState, type ViewObject } from './objects.ts'
import { firstLine } from './tools.ts'

type Part = Exclude<ThreadMessageLike['content'], string>[number]
type Status = NonNullable<ThreadMessageLike['status']>

export type WorkstreamState = 'none' | 'starting' | 'ready' | 'interrupted' | 'stopped' | 'lost' | 'failed' | 'ended' | 'native'
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
  /** The open Session's context: its tokens in use and its size, as the agent last said (docs/specs/log.md). */
  readonly usage?: Usage | null
  /** The last execution's own profiles (docs/specs/credentials.md). */
  readonly profiles?: readonly string[]
  /** What the last execution's agent accepts in a prompt beyond text, or null before it has said (docs/specs/log.md). */
  readonly promptCapabilities?: PromptCapabilities | null
  /** The exchanges sent to an agent, and per harness its last anchor and the exchanges since (docs/specs/log.md, "Continuing"). */
  readonly exchanges?: number
  readonly continuation?: Readonly<Record<string, { readonly anchor: string; readonly exchanges: number }>>
  /** The pending question's position, or null (docs/specs/log.md, "The Workstream view"). */
  readonly question?: string | null
  /** The oldest request its agent waits on — a permission —, or null (docs/specs/log.md, "The Workstream view"). */
  readonly request?: string | null
  /**
   * On a native sub-stream alone (docs/specs/log.md, "Native sub-agents"): its host, whose log holds its lines and takes
   * the commands that reach it; its description; whether its turn can be cancelled. And its state: `working`, `waiting`,
   * `idle`, `failed` or `cancelled`.
   */
  readonly native?: { readonly host: string; readonly description: string | null; readonly cancel: boolean } | null
  readonly subagent?: string | null
  /** Its role, its first execution's and kept (docs/specs/roles.md, "Naming a role"); null when it has none. */
  readonly role?: string | null
}

export interface Usage {
  readonly used: number
  readonly size: number
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

const HARNESS_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', mock: 'Mock agent' }

/** A harness as people name it. */
export const harnessName = (harness: string | null | undefined): string => (harness ? (HARNESS_NAMES[harness] ?? harness) : 'the agent')

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const json = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const usageOf = (value: unknown): Usage | null => {
  const v = json(value)
  return v && typeof v.used === 'number' && typeof v.size === 'number' && v.size > 0 && v.used >= 0 ? { used: v.used, size: v.size } : null
}
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
    usage: usageOf(o.usage),
    profiles: Array.isArray(o.profiles) ? o.profiles.filter((p): p is string => typeof p === 'string') : [],
    promptCapabilities: promptCapabilitiesOf(o.promptCapabilities),
    exchanges: typeof o.exchanges === 'number' ? o.exchanges : 0,
    question: text(o.question) || null,
    request: text(o.request) || null,
    native: json(o.native) && text(json(o.native)!.host) ? { host: text(json(o.native)!.host), description: text(json(o.native)!.description) || null, cancel: json(o.native)!.cancel === true } : null,
    subagent: text(o.subagent) || null,
    role: text(o.role) || null,
    continuation: Object.fromEntries(
      Object.entries(json(o.continuation) ?? {}).flatMap(([harness, c]) => {
        const v = json(c)
        return v && typeof v.anchor === 'string' && typeof v.exchanges === 'number' ? [[harness, { anchor: v.anchor, exchanges: v.exchanges }]] : []
      }),
    ),
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
  /** What is sent refuses the pending approval (docs/specs/delegation.md, "Approval"). */
  readonly refuses: boolean
  /** Messages wait with no turn running: the next one sends them (docs/specs/assistant-ui.md, "Messages during a turn"). */
  readonly held: boolean
  /** A native sub-stream: it takes no message (docs/specs/log.md, "Native sub-agents"). */
  readonly readOnly: boolean
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
  native: null,
}

/** The states in which no execution runs: sending starts one. */
const IDLE: readonly WorkstreamState[] = ['none', 'failed', 'ended']

export function composerOf(state: ThreadState, view: WorkstreamView): Composer {
  const turns = turnsOf(state)
  const last = turns.at(-1)
  // A native sub-stream takes no message: its turn can be cancelled where its adapter offers it, a permission it asks answered.
  if (view.state === 'native') {
    const working = turns.find((t) => status(t) === 'in_progress') ?? null
    const asked = ofKind(state, 'element').find((e) => isAsked(e) && e.object.status === 'pending') ?? null
    return { open: false, create: false, reason: null, running: working !== null, cancellable: view.native?.cancel === true ? working : null, uncertain: null, pendingPermission: asked, refuses: false, held: false, readOnly: true }
  }
  const active = turns.find((t) => ['saved', 'in_progress', 'uncertain'].includes(status(t))) ?? null
  const uncertain = active && status(active) === 'uncertain' ? active : null
  const pendingPermission =
    ofKind(state, 'element').find((e) => isAsked(e) && e.object.status === 'pending' && e.object.session === view.session) ?? null
  const pending = (approval: boolean) =>
    // A merge card waits for a click, not for an answer: sending stays open, and cancels it (docs/specs/merge.md).
    ofKind(state, 'element').some((e) => e.object.type === 'question' && e.object.status === 'pending' && e.object.kind !== 'merge' && (e.object.kind === 'approval') === approval)
  const pendingQuestion = pending(false)
  const running = last !== undefined && ['saved', 'in_progress'].includes(status(last))
  const cancellable = turns.find((t) => ['in_progress', 'uncertain'].includes(status(t))) ?? null
  const settling = view.state === 'ready' && view.configuring === true
  // A pending approval leaves sending open, a turn running included: what is sent refuses it (docs/specs/assistant-ui.md).
  if (state.complete && pending(true)) return { open: true, create: false, reason: null, running, cancellable, uncertain, pendingPermission, refuses: true, held: false, readOnly: false }
  const reason = !state.complete
    ? 'Loading…'
    : pendingQuestion
      ? 'Answer the question above.'
      : STATE_REASON[view.state] ??
      (pendingPermission
        ? pendingPermission.object.type === 'elicitation'
          ? 'Answer the question above.'
          : 'Answer the permission request above.'
        : settling
          ? 'Applying the settings…'
          : uncertain
            ? 'The end of the last turn could not be confirmed.'
            : null)
  // A question holds sending back in every state, a first message included (docs/specs/assistant-ui.md).
  const create = state.complete && IDLE.includes(view.state) && !pendingQuestion
  // A turn running leaves sending open: what is sent waits (docs/specs/assistant-ui.md, "Messages during a turn").
  const open = create || (state.complete && view.state === 'ready' && uncertain === null && pendingPermission === null && !pendingQuestion && !settling)
  const held = open && active === null && waitingOf(state, view).length > 0
  return { open, create, reason: open ? null : reason, running, cancellable, uncertain, pendingPermission, refuses: false, held, readOnly: false }
}

/** A message that waits, as the list above the composer shows it (docs/specs/assistant-ui.md, "Messages during a turn"). */
export interface Waiting {
  readonly id: string
  /** Its Write's position: what a Retract names. */
  readonly position: string
  readonly text: string
  /** Its blocks that are not text. */
  readonly attachments: number
  /** Who wrote it, when not the person (docs/specs/log.md, "Elements"). */
  readonly from: string | null
  readonly as: string | null
}

/**
 * The messages waiting for the Session of the execution they start (docs/specs/assistant-ui.md, "Sending"):
 * those the Workstream's execution was created with, while it starts. The thread shows them.
 */
export function startingOf(state: ThreadState, view: WorkstreamView): ViewObject[] {
  if (view.state !== 'starting' || view.execution === null) return []
  return ofKind(state, 'element')
    .filter((e) => e.object.type === 'waiting' && e.object.status === 'waiting' && e.object.first === view.execution)
    .sort(byPosition)
}

/** A message the log gave back (docs/specs/log.md, "Messages during a turn"): its text, and its blocks that are not text. */
export interface Returned {
  readonly id: string
  readonly text: string
  readonly blocks: readonly Json[]
}

/** The messages given back by the Workstream's execution, which did not start: they return to its composer. */
export function returnedOf(state: ThreadState, view: WorkstreamView): Returned[] {
  if (view.execution === null) return []
  return ofKind(state, 'element')
    .filter((e) => e.object.type === 'waiting' && e.object.status === 'returned' && e.object.first === view.execution)
    .sort(byPosition)
    .map((e) => {
      const blocks = list(e.object.content).map((b) => json(b)).filter((b): b is Json => b !== undefined)
      return { id: e.id, text: blocks.filter((b) => b.type === 'text').map((b) => text(b.text)).join('\n'), blocks: blocks.filter((b) => b.type !== 'text') }
    })
}

/** The messages waiting above the composer, oldest first: all but those the thread shows while their execution starts. */
export function waitingOf(state: ThreadState, view?: WorkstreamView): Waiting[] {
  const starting = new Set(view ? startingOf(state, view).map((e) => e.id) : [])
  return ofKind(state, 'element')
    .filter((e) => e.object.type === 'waiting' && e.object.status === 'waiting' && !starting.has(e.id))
    .sort(byPosition)
    .map((e) => {
      const blocks = list(e.object.content).map((b) => json(b))
      return {
        id: e.id,
        position: text(e.object.position),
        text: blocks.filter((b) => b?.type === 'text').map((b) => text(b!.text)).join('\n'),
        attachments: blocks.filter((b) => b?.type !== 'text').length,
        from: text(e.object.from) || null,
        as: text(e.object.as) || null,
      }
    })
}

// ---------------------------------------------------------------- notices

const LOST: Record<string, string> = {
  adapter_exited: "The agent's process exited",
  agent_failed: 'The agent stopped on an internal error',
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

const exchanges = (n: number): string => `${String(n)} exchange${n === 1 ? '' : 's'}`
const go = (n: number): string => (n === 1 ? 'goes' : 'go')

export function noticeText(notice: Json, first: boolean): string {
  const reason = text(notice.reason)
  switch (notice.type) {
    case 'session.opened': {
      const harness = harnessName(text(notice.harness))
      // A Session opened before catch-ups existed has no count: it was given nothing.
      const given = typeof notice.catchUp === 'number' ? notice.catchUp : null
      const omitted = typeof notice.omitted === 'number' && notice.omitted > 0 ? ` (the ${exchanges(notice.omitted)} before them left out for length)` : ''
      if (notice.origin !== 'new')
        return given
          ? `Session restored with ${harness}. The ${exchanges(given)} since its last save ${go(given)} to the agent with your next message${omitted}.`
          : `Session restored with ${harness}: the agent remembers the history above.`
      if (given) return `New session with ${harness}. The ${exchanges(given)} above ${go(given)} to the agent with your next message${omitted}.`
      if (first) return `Session started with ${harness}.`
      return given === 0 ? `New session with ${harness}.` : `New session with ${harness}: the agent does not know the history above.`
    }
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

type Approval = NonNullable<Extract<Part, { type: 'tool-call' }>['approval']>

function approvalOf(permission: ViewObject, title: string): Approval {
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

// ---------------------------------------------------------------- forms

/** A request of an agent's the person answers: a permission, or a form (docs/specs/log.md, "Requests"). */
const isAsked = (e: ViewObject): boolean => e.object.type === 'permission' || (e.object.type === 'elicitation' && !e.object.declined)

/** The title of a form's own line, when it names no tool line. */
export const FORM_TITLE = 'Asking for your input'

/** A form's question as the screen draws it (docs/specs/assistant-ui.md, "Forms"). */
export interface FormQuestion {
  readonly key: string
  /** `one` of its options, `many` of them, a `text`, a `number`, an `integer`, `yes-no` for true or false. */
  readonly kind: 'one' | 'many' | 'text' | 'number' | 'integer' | 'yes-no'
  /** What it asks: the longer of its title and its description; the other, its label. */
  readonly question: string
  readonly label: string | null
  readonly required: boolean
  readonly options: readonly { id: string; label: string; description?: string }[]
  /** Its "Other" field — the free text beside its options —, by its key, when it has one. */
  readonly other: string | null
  /** A number's bounds; a list's, in options chosen (`minItems`, `maxItems`); a text's, in code points (`minLength`, `maxLength`). */
  readonly min: number | null
  readonly max: number | null
}

/** A form an agent asks, from its `elicitation` element (docs/specs/assistant-ui.md, "Forms"). */
export interface Form {
  readonly id: string
  readonly message: string
  readonly questions: readonly FormQuestion[]
  /** `select`, `text`, `confirm`: answered as an approval; `list`, `flow`: as an interrupt, by `resume`. */
  readonly shape: 'select' | 'text' | 'confirm' | 'list' | 'flow'
  readonly status: 'pending' | 'answered' | 'declined' | 'cancelled'
  /** Why Agora declined it itself: `secret`, `async`, `mode` (docs/specs/log.md, "Requests"). */
  readonly declined: string | null
  /** What it was answered: its fields' values. */
  readonly content: Readonly<Record<string, unknown>> | null
  /** Who answered it, when not the person: its delegator. */
  readonly by: string | null
}

/** What answers a form: accepted with its fields' values, or declined. */
export type FormAnswer = { readonly action: 'accept'; readonly content: Record<string, unknown> } | { readonly action: 'decline' }

const bound = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * A form's questions: each field, its "Other" companion folded into it — the free text Claude Code names
 * `question_<n>_custom`, Codex marks `_meta.codex.questionId`.
 */
export function formOf(element: ViewObject): Form {
  const o = element.object
  const params = json(o.params) ?? {}
  const schema = json(params.requestedSchema) ?? {}
  const listed = list(schema.required).map(text)
  const required = new Set(listed)
  // The log keeps no member order: those `required` names first, in its order, then the others by name, numbers as numbers.
  const rank = (key: string) => (required.has(key) ? listed.indexOf(key) : listed.length)
  const fields = Object.entries(json(schema.properties) ?? {})
    .map(([key, raw]) => ({ key, p: json(raw) ?? {} }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, 'en', { numeric: true }))
  const optionsOf = (p: Json) => {
    const items = json(p.items)
    const raw = list(p.type === 'array' ? (items?.anyOf ?? items?.enum) : (p.oneOf ?? p.enum))
    return raw.map((r) => {
      const v = json(r)
      return v ? { id: text(v.const), label: text(v.title) || text(v.const), ...(text(v.description) ? { description: text(v.description) } : {}) } : { id: String(r), label: String(r) }
    })
  }
  const choice = (p: Json) => optionsOf(p).length > 0
  const companionOf = (key: string, p: Json): string | null => {
    if (!choice(p)) return null
    return fields.find((f) => f.p.type === 'string' && !choice(f.p) && (f.key === `${key}_custom` || text(json(json(f.p._meta)?.codex)?.questionId) === key))?.key ?? null
  }
  const companions = new Set(fields.map((f) => companionOf(f.key, f.p)).filter((k): k is string => k !== null))
  const questions: FormQuestion[] = fields
    .filter((f) => !companions.has(f.key))
    .map(({ key, p }) => {
      const title = text(p.title),
        description = text(p.description)
      const [question, label] = description.length > title.length ? [description, title || null] : [title || key, description || null]
      const kind: FormQuestion['kind'] =
        p.type === 'array' ? 'many' : choice(p) ? 'one' : p.type === 'boolean' ? 'yes-no' : p.type === 'number' ? 'number' : p.type === 'integer' ? 'integer' : 'text'
      const options = kind === 'yes-no' ? [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] : optionsOf(p)
      const array = p.type === 'array'
      return {
        key,
        kind,
        question,
        label,
        required: required.has(key),
        options,
        other: companionOf(key, p),
        min: bound(array ? p.minItems : kind === 'text' ? p.minLength : p.minimum),
        max: bound(array ? p.maxItems : kind === 'text' ? p.maxLength : p.maximum),
      }
    })
  const [only] = questions
  const shape: Form['shape'] =
    questions.length === 0 ? 'confirm' : questions.length > 1 ? 'flow' : only!.kind === 'one' ? 'select' : only!.kind === 'text' ? 'text' : only!.kind === 'many' ? 'list' : 'flow'
  const answer = json(o.answer)
  const action = text(answer?.action)
  const status: Form['status'] =
    o.status === 'pending' ? 'pending' : o.status === 'cancelled' || action === 'cancel' || action === '' ? 'cancelled' : action === 'accept' ? 'answered' : 'declined'
  return {
    id: element.id,
    message: text(params.message),
    questions,
    shape,
    status,
    declined: text(o.declined) || null,
    content: action === 'accept' ? (json(answer?.content) ?? {}) : null,
    by: o.as === 'delegator' ? 'delegator' : null,
  }
}

/** A question's answer, as its form's content holds it: the options chosen, its text. */
export function answerOf(question: FormQuestion, content: Readonly<Record<string, unknown>> | null): { chosen: string[]; text: string } {
  const value = content?.[question.key]
  const other = question.other === null ? '' : text(content?.[question.other])
  if (question.kind === 'yes-no') return { chosen: typeof value === 'boolean' ? [String(value)] : [], text: '' }
  if (question.kind === 'number' || question.kind === 'integer') return { chosen: [], text: typeof value === 'number' ? String(value) : '' }
  if (question.kind === 'text') return { chosen: [], text: text(value) }
  return { chosen: (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String), text: other }
}

/**
 * The content the answers give, each question's own: its options, its "Other" text, its value (docs/specs/assistant-ui.md,
 * "Forms"). A required list or text is given even empty — `[]`, `""` — where its minimum allows it; an optional one left
 * empty is left out.
 */
export function formContent(form: Form, chosen: Readonly<Record<string, readonly string[]>>, texts: Readonly<Record<string, string>>): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const q of form.questions) {
    const ids = chosen[q.key] ?? []
    const typed = (texts[q.key] ?? '').trim()
    if (q.kind === 'one' && ids[0] !== undefined) content[q.key] = ids[0]
    if (q.kind === 'many' && (ids.length > 0 || q.required)) content[q.key] = [...ids]
    if (q.kind === 'yes-no' && ids[0] !== undefined) content[q.key] = ids[0] === 'true'
    if (q.kind === 'text' && (typed !== '' || q.required)) content[q.key] = typed
    if ((q.kind === 'number' || q.kind === 'integer') && typed !== '') content[q.key] = Number(typed)
    if (q.other !== null && typed !== '' && (q.kind === 'one' || q.kind === 'many')) content[q.other] = typed
  }
  return content
}

/**
 * Whether a text typed fits its question: its length in code points within `minLength` and `maxLength`; empty, left out
 * when optional, given `""` when required and its minimum allows it. Its `pattern` and `format` are checked by Agora
 * (docs/specs/log.md, "Requests"): the browser runs no pattern of an agent's.
 */
export function textFits(question: FormQuestion, typed: string): boolean {
  const length = [...typed.trim()].length
  if (length === 0) return !question.required || (question.min ?? 0) === 0
  return (question.min === null || length >= question.min) && (question.max === null || length <= question.max)
}

/** Whether a number typed fits its question: a number, an integer when it asks one, within its bounds. */
export function numberFits(question: FormQuestion, typed: string): boolean {
  if (typed.trim() === '') return !question.required
  const n = Number(typed)
  if (!Number.isFinite(n) || (question.kind === 'integer' && !Number.isInteger(n))) return false
  return (question.min === null || n >= question.min) && (question.max === null || n <= question.max)
}

/** A form answered by an approval — one option, one text, or nothing to fill — as assistant-ui holds it. */
function formApproval(form: Form): Approval {
  const [q] = form.questions
  const settled = (() => {
    if (form.declined !== null || form.status === 'declined') return { approved: false }
    if (form.status === 'pending') return {}
    if (form.status === 'cancelled') return { resolution: 'cancelled' as const }
    const answer = q ? answerOf(q, form.content) : { chosen: [], text: '' }
    return { approved: true, ...(answer.chosen[0] !== undefined ? { optionId: answer.chosen[0] } : {}), ...(answer.text !== '' ? { text: answer.text } : {}) }
  })()
  return {
    id: form.id,
    prompt: form.message,
    display: form.shape === 'select' ? 'select' : form.shape === 'text' ? 'text' : 'decision',
    // An option is an answer, no decision: a custom kind, never resolved by assistant-ui itself.
    ...(form.shape === 'select' ? { options: q!.options.map((o) => ({ id: o.id, kind: '_option', label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
    ...(form.shape === 'select' && q!.other !== null ? { allowFreeform: true } : {}),
    dismissible: true,
    ...settled,
  }
}

/** What an approval's answer gives its form (docs/specs/assistant-ui.md, "Forms"): its option and its text; declined when dismissed. */
export function approvalAnswer(form: Form, response: { approved: boolean; optionId?: string; text?: string }): FormAnswer {
  const [q] = form.questions
  if (!response.approved) return { action: 'decline' }
  if (q === undefined) return { action: 'accept', content: {} }
  return { action: 'accept', content: formContent(form, { [q.key]: response.optionId === undefined ? [] : [response.optionId] }, { [q.key]: response.text ?? '' }) }
}

/** The pending form a part answers by `resume`: by the tool call it names, or its own. */
export function formFor(state: ThreadState, toolCallId: string): ViewObject | null {
  return ofKind(state, 'element').find((e) => e.object.type === 'elicitation' && e.object.status === 'pending' && (text(json(e.object.params)?.toolCallId) === toolCallId || e.id === toolCallId)) ?? null
}

function contentText(content: unknown): string {
  return list(content)
    .map((c) => json(json(c)?.content))
    .filter((c) => c?.type === 'text')
    .map((c) => text(c!.text))
    .join('\n')
}

/** An approval (docs/specs/assistant-ui.md, "A tool's line"): on the `spawn_agent` line it gates, or a box of its own. */
export interface Gate {
  readonly id: string
  readonly status: 'pending' | 'answered' | 'refused' | 'expired'
  readonly title: string
  /** The proposal, as Markdown. */
  readonly text: string
  /** A refusing Write's words. */
  readonly words: string | null
}

/** A question's own options as assistant-ui's approval holds them: ACP's kinds, with a dash (docs/specs/assistant-ui.md, "Answering"). */
const optionsOf = (question: Json) => list(question.options).map((o) => json(o) ?? {}).map((o) => ({ id: text(o.optionId), kind: optionKind(o.kind), label: text(o.name) }))

/** An approval's or a merge card's question as assistant-ui's approval: Approve, or Merge, once; settled, how. */
function askedOf(question: ViewObject): Approval {
  const q = question.object
  const chosen = q.status === 'answered' ? text(json(q.answer)?.optionId) : ''
  return {
    id: question.id,
    prompt: text(q.title),
    options: optionsOf(q),
    ...(chosen !== ''
      ? { approved: true, optionId: chosen }
      : q.status === 'refused'
        ? { approved: false }
        : q.status === 'expired' || q.status === 'cancelled'
          ? { resolution: q.status as 'expired' | 'cancelled' }
          : {}),
  }
}

function gateOf(question: ViewObject): Gate {
  const q = question.object
  const note = json(q.answer)?.note
  return {
    id: question.id,
    status: (text(q.status) || 'pending') as Gate['status'],
    title: text(q.title),
    text: text(q.text),
    words: q.status === 'refused' && typeof note === 'string' ? note : null,
  }
}

const isGate = (e: ViewObject): boolean => e.object.type === 'question' && e.object.kind === 'approval'
const isMergeCard = (e: ViewObject): boolean => e.object.type === 'question' && e.object.kind === 'merge'

/** A merge card (docs/specs/merge.md, "The card"): the pull request, its status in the log, its outcome. */
export interface MergeCard {
  readonly id: string
  /** The Ask's position, which the card's state names. */
  readonly position: string
  readonly status: 'pending' | 'answered' | 'cancelled'
  readonly title: string
  readonly url: string
  readonly repo: string
  readonly number: number
  readonly outcome: { readonly merged: true; readonly sha: string } | { readonly merged: false; readonly reason: string } | null
}

export function mergeCardOf(question: ViewObject): MergeCard {
  const q = question.object
  const o = json(q.outcome)
  return {
    id: question.id,
    position: text(q.position),
    status: q.status === 'answered' ? 'answered' : q.status === 'cancelled' ? 'cancelled' : 'pending',
    title: text(q.title),
    url: text(q.url),
    repo: text(q.repo),
    number: Number(q.number),
    outcome: o === null || o === undefined ? null : o.merged === true ? { merged: true, sha: text(o.sha) } : { merged: false, reason: text(o.reason) },
  }
}

/** A merge card's own message, at its position. */
function mergeMessage(question: ViewObject): ThreadMessageLike {
  const card = mergeCardOf(question)
  return {
    id: `${question.id}:merge`,
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: question.id,
        toolName: 'merge',
        args: {} as never,
        argsText: '',
        ...(card.status === 'pending' ? {} : { result: card.status }),
        artifact: { title: card.title, kind: 'other', status: card.status === 'pending' ? 'pending' : 'completed', merge: card },
        approval: askedOf(question),
      },
    ],
    status: { type: 'complete', reason: 'stop' },
    metadata: { custom: { merge: question.id } },
  }
}

/**
 * The delegate a call's answer names (docs/specs/mcp.md, "Tools"): `started <id> · <title>` for `spawn_agent`, `sent <id> ·
 * <title>` for `send_message`, `stopped` or `no turn to stop <id> · <title>` for `stop_agent`, `answered <id> · <title>` for
 * `answer_agent` — as a harness gives it, the
 * text alone or inside the JSON of its result.
 */
export function startedDelegate(output: string): { id: string; title: string } | null {
  const m = /(?:started|sent|stopped|no turn to stop|answered|declined) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) · ([^\n"\\]*)/.exec(output)
  return m ? { id: m[1]!, title: m[2]!.trim() } : null
}

/** What a tool printed: its raw output, as text or as JSON, else its content's text. */
const outputOf = (tool: Json): string =>
  tool.rawOutput === undefined ? contentText(tool.content) : typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2)

/**
 * A line that may name a delegate, by its title as each harness gives it — `mcp__agora__spawn_agent`, `mcp.agora.send_message`,
 * `agora_stop_agent`…: the tool's name alone, `spawn_agent`, `send_message`, `stop_agent`, or the `delegate` of an earlier
 * contract. A command that merely names one, with words around it, is no such line.
 */
const delegating = (tool: Json): boolean => /^\S*?(?<![a-z0-9])(?:spawn_agent|send_message|stop_agent|answer_agent|delegate)$/i.test(text(tool.title).trim())

/** The delegates this Workstream's lines name: whose rows their lines read. */
export function delegatesOf(state: ThreadState): string[] {
  return ofKind(state, 'element').flatMap((e) => {
    // Only such a line's output is read: every other tool's would cost its whole size at each change.
    // A native sub-agent's line names its sub-stream itself (docs/specs/log.md, "Native sub-agents").
    if (e.object.type === 'subagent' && text(e.object.workstream)) return [text(e.object.workstream)]
    const started = e.object.type === 'tool' && delegating(e.object) ? startedDelegate(outputOf(e.object)) : null
    return started ? [started.id] : []
  })
}

const diffsOf = (content: unknown): Json[] => list(content).map((c) => json(c)).filter((c): c is Json => c?.type === 'diff')

function toolPart(tool: Json, permission: ViewObject | undefined, gate?: ViewObject, elicitation?: ViewObject): Part {
  const done = tool.status === 'completed' || tool.status === 'failed'
  const title = text(tool.title) || text(tool.kind) || 'Tool'
  const input = json(tool.rawInput)
  const output = outputOf(tool)
  // An agent may send the change only with the permission it asks for it.
  const diffs = diffsOf(tool.content)
  const asked = diffs.length === 0 && permission ? diffsOf(json(json(permission.object.params)?.toolCall)?.content) : []
  const todos = list(input?.todos).map((t) => json(t)).filter((t): t is Json => typeof t?.content === 'string')
  const delegate = delegating(tool) ? startedDelegate(output) : null
  const form = elicitation ? formOf(elicitation) : undefined
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
      ...(delegate ? { delegate } : {}),
      ...(gate ? { gate: gateOf(gate) } : {}),
      // Answered by its delegator's `answer_agent` (docs/specs/delegation.md, "Requests").
      ...(permission?.object.as === 'delegator' ? { answeredBy: 'delegator' } : {}),
      ...(form ? { form } : {}),
    },
    // What waits for the person on this line: the approval Agora asks, the permission its agent asks, or its form —
    // an approval, or an interrupt that `resume` answers (docs/specs/assistant-ui.md, "Forms").
    ...(gate
      ? { approval: askedOf(gate) }
      : permission
        ? { approval: approvalOf(permission, title) }
        : form && ['select', 'text', 'confirm'].includes(form.shape)
          ? { approval: formApproval(form) }
          : form && form.status === 'pending' && form.declined === null
            ? { interrupt: { type: 'human' as const, payload: { form: form.id } } }
            : {}),
  }
}

/**
 * A native sub-agent's line in its parent's thread (docs/specs/assistant-ui.md, "A tool's line"): drawn as a delegate's
 * is, by its title, with a link to its sub-stream and its state.
 */
function subagentPart(e: ViewObject): Part {
  const o = e.object
  const state = text(o.state) || 'working'
  const working = state === 'working' || state === 'waiting'
  return {
    type: 'tool-call',
    toolCallId: e.id,
    toolName: 'other',
    args: {} as never,
    argsText: '',
    ...(working ? {} : { result: state }),
    isError: state === 'failed',
    artifact: { title: text(o.title) || 'Sub-agent', kind: 'other', status: working ? 'in_progress' : state === 'failed' ? 'failed' : 'completed', delegate: { id: text(o.workstream), title: text(o.title) || 'Sub-agent' }, subagent: state },
  }
}

/**
 * A message the agent receives from another than the person (docs/specs/assistant-ui.md, "Messages"): a `user` element
 * that names its writer — a delegate's, its delegator's, its parent's, Agora's —, or an earlier delegation's report.
 */
const received = (e: ViewObject): boolean => e.object.type === 'report' || (e.object.type === 'user' && (text(e.object.from) !== '' || text(e.object.as) !== ''))

/** Such a message as its line shows it: who wrote it, and its whole text. */
export interface Received {
  /** Its writer's Workstream; null for Agora's. */
  readonly from: string | null
  /** How its writer stands to the agent: `delegate`, `delegator`, `parent`, `agora`; null as an earlier delegation wrote it. */
  readonly as: string | null
  readonly text: string
  /** An earlier delegation's report: how many outcomes it gave. */
  readonly outcomes?: number
}

/** A message received, as a tool call of its response: what lets it fold with the agent's tools (docs/specs/assistant-ui.md, "Folded tools"). */
function receivedPart(e: ViewObject): Part {
  const o = e.object
  const message: Received =
    o.type === 'report'
      ? { from: null, as: 'agora', text: text(o.text), outcomes: list(o.delegates).length }
      : { from: o.as === 'agora' ? null : text(o.from) || null, as: text(o.as) || null, text: textOf(e) }
  return {
    type: 'tool-call',
    toolCallId: e.id,
    toolName: 'message',
    args: {} as never,
    argsText: '',
    result: message.text,
    artifact: { title: firstLine(message.text), kind: 'message', status: 'completed', message },
  }
}

function partsOf(elements: ViewObject[], gates: ReadonlyMap<string, ViewObject>): Part[] {
  const permissions = new Map<string, ViewObject>()
  for (const e of elements)
    if (e.object.type === 'permission') permissions.set(text(json(json(e.object.params)?.toolCall)?.toolCallId), e)
  // A form names the tool call it asks for, when it asks for one (Claude Code's AskUserQuestion).
  const forms = new Map<string, ViewObject>()
  for (const e of elements) if (e.object.type === 'elicitation' && text(json(e.object.params)?.toolCallId)) forms.set(text(json(e.object.params)?.toolCallId), e)
  const tools = new Set(elements.filter((e) => e.object.type === 'tool').map((e) => text(e.object.toolCallId)))
  const parts: Part[] = []
  for (const e of elements) {
    const o = e.object
    if (o.type === 'agent_message_chunk') parts.push({ type: 'text', text: text(o.text) })
    else if (o.type === 'agent_thought_chunk') parts.push({ type: 'reasoning', text: text(o.text) })
    else if (o.type === 'tool') parts.push(toolPart(o, permissions.get(text(o.toolCallId)), gates.get(text(o.toolCallId)), forms.get(text(o.toolCallId))))
    else if (o.type === 'plan') parts.push({ type: 'data', name: 'plan', data: { entries: list(o.entries) } as never })
    else if (o.type === 'subagent') parts.push(subagentPart(e))
    else if (received(e)) parts.push(receivedPart(e))
    else if (o.type === 'permission') {
      const call = json(json(o.params)?.toolCall) ?? {}
      if (!tools.has(text(call.toolCallId))) parts.push(toolPart(call, e))
    } else if (o.type === 'elicitation') {
      // A form on no tool line of this thread (Codex's request_user_input, an MCP server's): a tool call of its own.
      const call = text(json(o.params)?.toolCallId)
      if (!tools.has(call)) parts.push(toolPart({ toolCallId: call || e.id, title: FORM_TITLE, kind: 'other', status: o.status === 'pending' ? 'pending' : 'completed' }, undefined, undefined, e))
    }
  }
  return parts
}

/**
 * A question to the person (docs/specs/assistant-ui.md, "Messages"): its title and text as Markdown,
 * then its line and card, as a tool call whose approval holds its options.
 */
function questionMessage(question: ViewObject): ThreadMessageLike {
  const q = question.object
  const options = list(q.options).map((o) => json(o) ?? {})
  const answer = json(q.answer)
  const chosen = q.status === 'answered' ? options.find((o) => o.optionId === answer?.optionId) : undefined
  const title = text(q.title)
  const note = typeof answer?.note === 'string' && answer.note !== '' ? answer.note : null
  // Its note is the approval's free-form answer: allowed when the question takes one, recorded as its text.
  return {
    id: `${question.id}:question`,
    role: 'assistant',
    content: [
      { type: 'text', text: `**${title}**\n\n${text(q.text)}` },
      {
        type: 'tool-call',
        toolCallId: question.id,
        toolName: 'question',
        args: {} as never,
        argsText: '',
        ...(chosen ? { result: note ? `${text(chosen.name)}: ${note}` : text(chosen.name) } : {}),
        artifact: { title, kind: 'question', status: chosen ? 'completed' : 'pending', ...(chosen ? { answer: text(chosen.name), answerNote: note } : {}) },
        approval: {
          id: question.id,
          prompt: title,
          options: optionsOf(q),
          ...(q.note === true ? { allowFreeform: true } : {}),
          ...(chosen ? { approved: optionKind(chosen.kind).startsWith('allow'), optionId: text(chosen.optionId), ...(note !== null ? { text: note } : {}) } : {}),
        },
      },
    ],
    status: chosen ? { type: 'complete', reason: 'stop' } : { type: 'requires-action', reason: 'tool-calls' },
    metadata: { custom: { question: question.id } },
  }
}

/** An approval matched to no line (docs/specs/assistant-ui.md, "A tool's line"): the same box, at its position. */
function gateMessage(question: ViewObject): ThreadMessageLike {
  const gate = gateOf(question)
  return {
    id: `${question.id}:approval`,
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: question.id,
        toolName: 'delegate',
        args: {} as never,
        argsText: '',
        ...(gate.status === 'pending' ? {} : { result: gate.status }),
        artifact: { title: `delegate · ${gate.title}`, kind: 'other', status: gate.status === 'pending' ? 'pending' : 'completed', gate },
        approval: askedOf(question),
      },
    ],
    status: { type: 'complete', reason: 'stop' },
    metadata: { custom: { approval: question.id } },
  }
}

function failureOf(turn: Json): string {
  const failure = turn.failure
  if (typeof failure === 'string') return `The request failed (${failure}).`
  const message = text(json(failure)?.message)
  return message || 'The execution ended before the answer.'
}

function assistantStatus(turn: ViewObject, pending: boolean, interrupted = false): Status {
  switch (status(turn)) {
    case 'saved':
      return { type: 'running' }
    case 'in_progress':
      // A pending permission is what makes ToolFallback show its buttons; a form answered by `resume`, an interrupt.
      return pending ? { type: 'requires-action', reason: interrupted ? 'interrupt' : 'tool-calls' } : { type: 'running' }
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

/**
 * What sending will give the agent of the conversation above, when not all of it is in a save of its
 * harness (docs/specs/log.md, "Continuing"): Agora restores that harness's last save and gives the
 * exchanges after it as text — all of them when there is none. Null when there is nothing to say.
 */
export function continuationNote(view: WorkstreamView, harness: string | null | undefined): string | null {
  const total = view.exchanges ?? 0
  if (total === 0 || !harness) return null
  const saved = view.continuation?.[harness]
  if (saved && saved.exchanges === 0) return null
  return saved
    ? `${harnessName(harness)} resumes its saved session; the ${exchanges(saved.exchanges)} since then ${go(saved.exchanges)} to it as text.`
    : `No saved ${harnessName(harness)} session: the ${exchanges(total)} above ${go(total)} to the agent as text.`
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

/** The pools the screen offers: all but those kept for the tests. */
export const offeredPools = <P extends { readonly testing?: boolean }>(pools: readonly P[]): P[] => pools.filter((p) => p.testing !== true)

/**
 * The pool a new execution starts in (docs/specs/assistant-ui.md, "Sending"): the one picked here;
 * else the Workstream's own; else, its own gone with an older image, one of its harness — so it
 * continues; else the one picked last; else the first offered.
 */
export function poolOffered(
  pools: readonly { readonly name: string; readonly harness?: string; readonly testing?: boolean }[],
  picked: string | null,
  own: string | null,
  last: string | null,
  ownHarness: string | null = null,
): string | null {
  const offered = offeredPools(pools)
  const valid = (name: string | null): name is string => name !== null && offered.some((p) => p.name === name)
  if (valid(picked)) return picked
  if (valid(own)) return own
  const same = ownHarness === null ? undefined : offered.find((p) => p.harness === ownHarness)
  if (same) return same.name
  if (valid(last)) return last
  return offered[0]?.name ?? null
}

// ---------------------------------------------------------------- access

/**
 * One line of the access picker: a service, or what folds several profiles into one right. On, it gives
 * `profiles`; off, it takes back every profile it `covers`, at any level.
 */
export interface AccessEntry {
  readonly key: string
  readonly name: string
  readonly profiles: readonly string[]
  readonly covers: readonly string[]
  /** For GitHub: the repositories it gives, by `owner/repo`, each with its level when it is not a write. */
  readonly detail?: string
}

/** The profile for any other host, with no credential (docs/specs/credentials.md, "Profiles"). */
export const INTERNET = 'internet'

const SERVICE_NAMES: Record<string, string> = { [INTERNET]: 'Internet', anthropic: 'Anthropic', zai: 'z.ai', chatgpt: 'ChatGPT', antigravity: 'Antigravity' }
const REPOSITORY = /^github:([^:]+):(read|review|write)$/
const LEVELS = ['read', 'review', 'write'] as const
/** What a profile is a level of: its repository, the vault, or itself. */
const familyOf = (profile: string): string => {
  const repo = REPOSITORY.exec(profile)?.[1]
  return repo !== undefined ? `github:${repo}` : profile.startsWith('vault:') ? 'vault' : profile
}
const single = (profile: string, name: string): AccessEntry => ({ key: profile, name, profiles: [profile], covers: [profile] })

/**
 * The rights the access picker offers (docs/specs/assistant-ui.md, "Access"), folded, write giving read: the
 * Internet, then each other service; "GitHub", every offered repository at the widest level it is offered;
 * "vault", its write, else its read; "k8s", `kubernetes:read`; "agora", `agora:delegate`; then any other
 * profile offered, as itself.
 */
export function accessEntries(offered: readonly string[]): AccessEntry[] {
  const has = (p: string) => offered.includes(p)
  const services = offered.filter((p) => SERVICE_NAMES[p] !== undefined).sort((x, y) => Number(y === INTERNET) - Number(x === INTERNET))
  const repositories = [...new Set(offered.flatMap((p) => REPOSITORY.exec(p)?.[1] ?? []))]
  // Each repository's widest level offered, and the levels under it, which it takes back off.
  const widest = (repo: string) => LEVELS.findLastIndex((l) => has(`github:${repo}:${l}`))
  const level = (repo: string, i: number) => `github:${repo}:${LEVELS[i]!}`
  const out = services.map((p) => single(p, SERVICE_NAMES[p]!))
  if (repositories.length > 0)
    out.push({
      key: 'github',
      name: 'GitHub',
      profiles: repositories.map((r) => level(r, widest(r))),
      covers: repositories.flatMap((r) => LEVELS.slice(0, widest(r) + 1).map((_, i) => level(r, i))),
      detail: repositories.map((r) => (LEVELS[widest(r)] === 'write' ? r : `${r} (${LEVELS[widest(r)]!})`)).join(', '),
    })
  const vault = has('vault:write') ? 'vault:write' : has('vault:read') ? 'vault:read' : null
  if (vault !== null) out.push({ key: 'vault', name: 'vault', profiles: [vault], covers: vault === 'vault:write' ? ['vault:read', 'vault:write'] : ['vault:read'] })
  if (has('kubernetes:read')) out.push(single('kubernetes:read', 'k8s'))
  if (has('agora:delegate')) out.push(single('agora:delegate', 'agora'))
  const folded = new Set(out.flatMap((e) => e.covers))
  for (const p of offered) if (!folded.has(p)) out.push(single(p, p))
  return out
}

/** An entry's state: all it gives granted, none of what it covers, or some of it — as a role's card may give. */
export function accessState(granted: readonly string[], entry: AccessEntry): 'on' | 'off' | 'partial' {
  if (entry.profiles.every((p) => granted.includes(p))) return 'on'
  return granted.some((p) => entry.covers.includes(p)) ? 'partial' : 'off'
}

/**
 * The whole set once an entry is switched: on, what it gives in place of what it covered; off, none of it.
 * In the order offered, each profile with its repository's or the vault's; then what was granted beyond them, kept.
 */
export function withAccess(granted: readonly string[], offered: readonly string[], entry: AccessEntry, on: boolean): string[] {
  return inOfferedOrder([...granted.filter((p) => !entry.covers.includes(p)), ...(on ? entry.profiles : [])], offered)
}

/** Profiles once each, in the order offered, each with its repository's or the vault's; then the others, as they came. */
function inOfferedOrder(profiles: readonly string[], offered: readonly string[]): string[] {
  const all = [...new Set(profiles)]
  const ordered = [...new Set(offered.map(familyOf))].flatMap((f) => all.filter((p) => familyOf(p) === f))
  return [...ordered, ...all.filter((p) => !ordered.includes(p))]
}

/** The key's name and tooltip: each entry granted, in the menu's order, "partly" where only some of it is; or "No access". */
export function accessTitle(granted: readonly string[], entries: readonly AccessEntry[]): string {
  const rights = entries.flatMap((e) => {
    const state = accessState(granted, e)
    return state === 'off' ? [] : [state === 'on' ? e.name : `${e.name} (partly)`]
  })
  return rights.length === 0 ? 'No access' : rights.join(', ')
}

/** The access a Workstream starts with, before any execution: the Internet, when it is offered. */
export const accessDefault = (offered: readonly string[]): readonly string[] => (offered.includes(INTERNET) ? [INTERNET] : [])

/**
 * The access shown and sent: what was picked here; else the last execution's own; else, before any
 * execution, the default.
 */
export const accessGranted = (picked: readonly string[] | null, view: WorkstreamView, initial: readonly string[] = []): readonly string[] =>
  picked ?? (view.execution !== null ? (view.profiles ?? []) : initial)

/**
 * The Create a message starts: the pool, with the settings and the access picked, and the role, which only a
 * Workstream's first names (docs/specs/assistant-ui.md, "Roles"). Which save it continues from is the server's
 * to find (docs/specs/log.md, "Continuing").
 */
export function startBody(pool: string, settings: Readonly<Record<string, string>>, access: readonly string[], role: string | null = null): Json {
  return {
    pool,
    ...(Object.keys(settings).length > 0 ? { settings: { ...settings } } : {}),
    ...(access.length > 0 ? { profiles: [...access] } : {}),
    ...(role !== null ? { role } : {}),
  }
}

// ---------------------------------------------------------------- roles

/** A role's card, as `GET /api/config` gives it (docs/specs/roles.md, "Cards"): who the agent is to be, and what it works with by default. */
export interface Role {
  readonly role: string
  readonly summary: string
  readonly harness: string
  /** Its harness's own; null when the card leaves it to the pool. */
  readonly model: string | null
  readonly effort: string | null
  /** The profiles a draft starts with beside its own, when the role is picked. */
  readonly access: readonly string[]
}

/**
 * What the person picked themselves before a Workstream's first execution (docs/specs/assistant-ui.md, "Roles"),
 * each null while its picker has not been used there: the harness's pool; the model with its effort, by setting,
 * and the pool they were picked in; the whole access.
 */
export interface Picks {
  readonly pool: string | null
  readonly settings: { readonly pool: string | null; readonly values: Readonly<Record<string, string>> } | null
  readonly access: readonly string[] | null
}

/**
 * The picks in effect once a role is picked (docs/specs/assistant-ui.md, "Roles"): its card's values are
 * defaults, never set over the person's own. The harness, the model with its effort, and the access each take
 * the card's only where the person picked nothing, and only what is offered: a pool of the card's harness — the
 * draft's own, `start`, when it is one —; its model and its effort, on that harness alone (docs/specs/roles.md,
 * "Naming a role"), each among that pool's options; its `access`, beside the draft's own start. A model the
 * person picked is its harness's: it keeps that harness with it. With no role, the person's picks alone.
 */
export function withRole(
  role: Role | null,
  own: Picks,
  pools: readonly ({ readonly name: string; readonly harness: string; readonly testing?: boolean } & NonNullable<Parameters<typeof poolSettings>[0]>)[],
  offered: readonly string[],
  start: string | null,
): Picks {
  const open = offeredPools(pools)
  const named = (name: string | null | undefined) => open.find((p) => p.name === name)
  const pool = named(own.pool) ?? named(own.settings?.pool) ?? (role === null ? undefined : [named(start), ...open].find((p) => p?.harness === role.harness))
  // The model and effort picked in another pool are that pool's: here, the person picked none.
  const on = pool ?? named(start)
  const picked = own.settings !== null && own.settings.pool === on?.name ? own.settings : null
  if (role === null) return { pool: pool?.name ?? null, settings: picked, access: own.access }
  const values: Record<string, string> = {}
  if (picked === null && on?.harness === role.harness) {
    const choice = modelChoice(poolSettings(on))
    const offer = (setting: Setting | undefined, options: Setting['options'], value: string | null) => {
      if (setting && value !== null && options.some((o) => o.value === value)) values[setting.id] = value
    }
    offer(choice.model, choice.models, role.model)
    offer(choice.effort, choice.efforts, role.effort)
  }
  const granted = [...role.access, ...accessDefault(offered)]
  return {
    pool: pool?.name ?? null,
    settings: picked ?? (on && Object.keys(values).length > 0 ? { pool: on.name, values } : null),
    access: own.access ?? inOfferedOrder(granted.filter((p) => accessEntries(offered).some((entry) => entry.covers.includes(p))), offered),
  }
}

/** The commands `/` lists: while the composer holds `/` and a name being typed, those it starts. */
export function commandsMatching(commands: readonly AgentCommand[], text: string): AgentCommand[] {
  const typed = /^\/(\S*)$/.exec(text)
  if (typed === null) return []
  const prefix = typed[1]!.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix))
}

// ---------------------------------------------------------------- context and limits

export type WindowKind = 'five_hour' | 'weekly'

/** One window of an account's limits, as `GET /api/limits` gives it (docs/specs/credentials.md, "Limits"). */
export interface LimitWindow {
  readonly kind: WindowKind
  readonly usedPercent: number
  readonly resetsAt: string | null
}

export interface AccountLimits {
  readonly windows: readonly LimitWindow[]
  readonly plan: string | null
  readonly checkedAt: string | null
  readonly stale: boolean
  readonly error: string | null
}

const WINDOW_NAMES: Record<WindowKind, string> = { five_hour: '5-hour', weekly: 'Weekly' }

/** A window as people name it. */
export const windowName = (kind: WindowKind): string => WINDOW_NAMES[kind]

const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Claude', chatgpt: 'ChatGPT', zai: 'z.ai' }

/** A subscription in the header's limits (docs/specs/assistant-ui.md, "Context and limits"): its base profile, its provider's name, its limits. */
export interface Subscription {
  readonly profile: string
  readonly name: string
  readonly limits: AccountLimits
}

/**
 * The subscriptions the header shows (docs/specs/assistant-ui.md, "Context and limits"): every account
 * `GET /api/limits` gives that has windows or a reason, in its order, named after its provider; none before they are read.
 */
export function subscriptions(limits: Readonly<Record<string, AccountLimits>> | null): readonly Subscription[] {
  return Object.entries(limits ?? {})
    .filter(([, account]) => account.windows.length > 0 || account.error !== null)
    .map(([profile, account]) => ({ profile, name: PROVIDER_NAMES[profile] ?? profile, limits: account }))
}

/** How full the fullest window of every subscription is, in percent: what colours the gauge; 0 without any window. */
export const fullest = (accounts: readonly Subscription[]): number => Math.max(0, ...accounts.flatMap((a) => a.limits.windows.map((w) => w.usedPercent)))

/** How long until a window resets, short: "45m", "2h 10m", "3d 4h"; null when not known or passed. */
export function resetIn(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return null
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes % 60)}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${String(days)}d` : `${String(days)}d ${String(hours % 24)}h`
}

// ---------------------------------------------------------------- the list

/** A Workstream as the list holds it (docs/specs/log.md, "The list"): a few of its view's fields. */
export type ListRow = Pick<WorkstreamView, 'id' | 'title' | 'state' | 'harness' | 'question' | 'request' | 'changedAt'> & {
  /** Its line (docs/specs/log.md, "Sub-streams"): absent on a row written before the tree. */
  readonly parent?: string | null
  readonly depth?: number
  /** What lies under it, at every depth: the sub-streams, those live, those waiting for the person. */
  readonly below?: { readonly count: number; readonly live: number; readonly waiting: number }
  /** A delegate's state (docs/specs/log.md, "The Workstream view"): `working`, `waiting`, `idle`, `failed`, `cancelled`; an earlier delegate's may say `completed`. */
  readonly delegation?: string
  /** A native sub-stream's state (docs/specs/log.md, "Native sub-agents"): `working`, `waiting`, `idle`, `failed`, `cancelled`. */
  readonly subagent?: string | null
}

export interface Section {
  readonly label: string
  readonly workstreams: readonly ListRow[]
}

const DAY = 86_400_000

/**
 * The Workstreams by when they last changed: today, yesterday, the past week, then older. One with no
 * entry is left out, unless it is the one open, one of its parents (`line`), or something waits under it;
 * a search keeps the titles that contain it.
 */
export function sections(workstreams: readonly ListRow[], now: Date, search: string, current: string | null, line: readonly string[] = []): Section[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const wanted = search.trim().toLowerCase()
  const groups: { label: string; from: number }[] = [
    { label: 'Today', from: midnight },
    { label: 'Yesterday', from: midnight - DAY },
    { label: 'Previous 7 days', from: midnight - 7 * DAY },
    { label: 'Older', from: -Infinity },
  ]
  const out = groups.map((g) => ({ label: g.label, workstreams: [] as ListRow[] }))
  for (const w of workstreams) {
    if (w.state === 'none' && w.id !== current && !line.includes(w.id) && !w.question && !w.request && !w.below?.waiting) continue
    if (wanted !== '' && !w.title.toLowerCase().includes(wanted)) continue
    const at = w.changedAt ? Date.parse(w.changedAt) : now.getTime()
    out[groups.findIndex((g) => at >= g.from)]!.workstreams.push(w)
  }
  return out.filter((s) => s.workstreams.length > 0)
}

const changed = (w: ListRow): number => (w.changedAt ? Date.parse(w.changedAt) : 0)

/**
 * Rows read by different ways — the list's stream, its older pages, a search — as one list: each
 * Workstream once, its most recently changed row (the first given when they tie), newest first.
 */
export function merged(...lists: readonly (readonly ListRow[])[]): ListRow[] {
  const byId = new Map<string, ListRow>()
  for (const list of lists)
    for (const row of list) {
      const known = byId.get(row.id)
      if (!known || changed(row) > changed(known)) byId.set(row.id, row)
    }
  return [...byId.values()].sort((a, b) => changed(b) - changed(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** A matching line as a row shows it: what comes before the text, the text, what follows. */
export interface Excerpt {
  readonly before: string
  readonly text: string
  readonly after: string
}

/**
 * A search's matching line under a row's title (docs/specs/assistant-ui.md, "Sidebar"): from the word before the
 * text, so that a narrow row shows it, the text apart to be marked. The line whole when the text is not in it.
 */
export function excerpt(line: string, text: string, lead = 16): Excerpt {
  const found = text === '' ? null : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(line)
  if (!found) return { before: line, text: '', after: '' }
  let start = Math.max(0, found.index - lead)
  const space = start > 0 ? line.indexOf(' ', start) : -1
  if (space >= 0 && space < found.index) start = space + 1
  const end = found.index + found[0].length
  return { before: `${start > 0 ? '…' : ''}${line.slice(start, found.index)}`, text: found[0], after: line.slice(end) }
}

// ---------------------------------------------------------------- messages

/** A `user` element's text blocks. */
const textOf = (user: ViewObject | undefined): string =>
  list(user?.object.content).map((b) => json(b)).filter((b) => b?.type === 'text').map((b) => text(b!.text)).join('\n')

export function messagesOf(state: ThreadState, view?: WorkstreamView): ThreadMessageLike[] {
  const elements = ofKind(state, 'element').sort(byPosition)
  const placed: { position: string; messages: ThreadMessageLike[] }[] = []
  // An approval goes on the tool line it names, when this Workstream holds it.
  const tools = new Set(elements.filter((e) => e.object.type === 'tool').map((e) => text(e.object.toolCallId)))
  const gates = new Map(elements.filter((e) => isGate(e) && tools.has(text(e.object.toolCallId))).map((e) => [text(e.object.toolCallId), e]))
  for (const turn of turnsOf(state)) {
    const own = elements.filter((e) => e.object.turn === turn.id)
    const prompt = own.find((e) => (e.object.type === 'user' && e.object.steered !== true) || e.object.type === 'report')
    const custom = { turnStatus: status(turn), turn: turn.id }
    const pending = own.some((e) => isAsked(e) && e.object.status === 'pending')
    const interrupted = own.some((e) => e.object.type === 'elicitation' && e.object.status === 'pending' && ['flow', 'list'].includes(formOf(e).shape))
    // The response, cut at each message of the person's sent into the turn; what another wrote — its prompt
    // included — is a line of the response at its place (docs/specs/assistant-ui.md, "Messages").
    const responses: { said: ViewObject | null; parts: ViewObject[] }[] = [{ said: null, parts: [] }]
    for (const e of own) {
      if (received(e)) responses.at(-1)!.parts.push(e)
      else if (e.object.steered === true) responses.push({ said: e, parts: [] })
      else if (e.object.type !== 'user') responses.at(-1)!.parts.push(e)
    }
    // The person's message opens its turn. None: a native sub-agent's turn answers no prompt of Agora's, its response alone.
    const opens = prompt === undefined ? turn.object.native !== true : !received(prompt)
    const opening: ThreadMessageLike = {
      id: `${turn.id}:user`,
      role: 'user',
      content: [{ type: 'text', text: textOf(prompt) }],
      attachments: attachmentsOf(list(prompt?.object.content), prompt?.object),
      metadata: { custom },
    }
    placed.push({
      position: text(turn.object.requestPosition),
      messages: [
        ...(opens ? [opening] : []),
        ...responses.flatMap(({ said, parts }, i): ThreadMessageLike[] => {
          const at = said ? `:${text(said.object.firstPosition)}` : ''
          const last = i === responses.length - 1
          return [
            ...(said
              ? [
                  {
                    id: `${turn.id}:user${at}`,
                    role: 'user' as const,
                    content: [{ type: 'text' as const, text: textOf(said) }],
                    attachments: attachmentsOf(list(said.object.content), said.object),
                    metadata: { custom: { turn: turn.id, steered: true } },
                  },
                ]
              : []),
            ...(last || parts.length > 0
              ? [
                  {
                    id: `${turn.id}:assistant${at}`,
                    role: 'assistant' as const,
                    content: partsOf(parts, gates),
                    status: last ? assistantStatus(turn, pending, interrupted) : ({ type: 'complete', reason: 'stop' } as const),
                    metadata: { custom },
                  },
                ]
              : []),
          ]
        }),
      ],
    })
  }
  for (const question of elements.filter((e) => e.object.type === 'question')) {
    if (isGate(question) && gates.get(text(question.object.toolCallId)) === question) continue
    placed.push({ position: text(question.object.position), messages: [isMergeCard(question) ? mergeMessage(question) : isGate(question) ? gateMessage(question) : questionMessage(question)] })
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
  const messages = placed.sort((a, b) => (after(a.position, b.position) ? 1 : after(b.position, a.position) ? -1 : 0)).flatMap((p) => p.messages)
  // The messages waiting for the Session of the execution they start, where their turns will be
  // (docs/specs/assistant-ui.md, "Sending").
  const starting = view ? startingOf(state, view) : []
  if (starting.length === 0) return messages
  const custom = { turnStatus: 'pending', harness: view!.harness }
  return [
    ...messages,
    ...starting.map((e): ThreadMessageLike => ({ id: `${e.id}:user`, role: 'user', content: [{ type: 'text', text: textOf(e) }], attachments: attachmentsOf(list(e.object.content), e.object), metadata: { custom } })),
    { id: 'starting:assistant', role: 'assistant', content: [], status: { type: 'running' }, metadata: { custom } },
  ]
}

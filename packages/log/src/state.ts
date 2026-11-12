import { idKey } from './acp.ts'
import { identity, object, schemaValue, encode } from './json.ts'
import { commandsOf, configuring, settingsOf, settled } from './settings.ts'
import type { Entry } from './store.ts'
import { CATCH_UP_META, dispatched, isCatchUp, lacking, lastAnchor, noAnchors, noteAnchor } from './catch-up.ts'
import { DELEGATION_META, FROM_META, REPORT_META } from './marks.ts'

const OPENING_METHODS = ['session/new', 'session/resume', 'session/load']
/** The ACP extension that gives a running turn a message (docs/specs/log.md, "Messages during a turn"). */
export const STEERING = '_session/steering'

export type TurnStatus = 'saved' | 'in_progress' | 'done' | 'cancelled' | 'failed' | 'uncertain'
export interface Turn {
  id: string
  session: string | null
  execution: string
  requestId: unknown
  requestPosition: string
  startedAt?: string
  status: TurnStatus
  dispatching: boolean
  connection?: string
  answered: boolean
  stopReason?: unknown
  failure?: unknown
  /** A native sub-agent's turn (docs/specs/log.md, "Native sub-agents"): it answers no prompt of Agora's. */
  native?: true
}
export interface Execution {
  id: string
  claimName: string
  body: Record<string, unknown>
  uid?: string
  instance?: string
  connection?: string
  session: string | null
  acpId: string | null
  stopped: boolean
  ended: boolean
  lost: boolean
  failed?: boolean
  clean: boolean
  initialized: boolean
  /** The open Session's `configOptions`, as it last gave them (docs/specs/log.md, "Sessions"). */
  settings: unknown[] | null
  /** The settings this Session was asked to change, by id, in order. */
  configSent: string[]
  /** The open Session's last `availableCommands`. */
  commands: unknown[]
  /** The open Session's last `usage_update`: the context's tokens in use and its size. */
  usage: { used: number; size: number } | null
  /** Its own profiles (docs/specs/credentials.md): its Create's, then its last Scope's. */
  profiles: string[]
  /** What its agent accepts in a prompt beyond text and resource links, once it has answered `initialize`. */
  promptCapabilities: PromptCapabilities | null
  /** Its agent takes a message into a running turn: its `initialize` answer's `_meta.steering.supported`. */
  steering: boolean
  /** The ACP session a `session/resume` or a `session/load` not yet answered names: what it replays is that session's. */
  openingAcp: string | null
  /** A `session/prompt` of its own was written: it took a prompt (docs/specs/log.md, "Messages during a turn"). */
  prompted: boolean
}
/**
 * A sub-agent its harness started of its own (docs/specs/log.md, "Native sub-agents"): announced on its parent's
 * stream, then speaking under an ACP session id of its own. Its lines stay in its host's log.
 */
export interface Child {
  acpId: string
  /** Its sub-stream: the name-based UUID of its host and its ACP session id. */
  workstream: string
  /** The Workstream of the session that announced it: its host, or another sub-agent's sub-stream. */
  parent: string
  execution: string
  session: string | null
  /** Its last `subagent_update` title and description; its own last `session_info_update` title. */
  title: string | null
  description: string | null
  ownTitle: string | null
  /** Its last `capabilities` hold `cancel`. */
  cancel: boolean
  /** Its last state is `requires_action`. */
  waiting: boolean
  turns: Turn[]
  /** The position of the line that announced it. */
  announcedAt: string
  /** Beyond the bounds: known, so that its lines are not its host's, and given no sub-stream. */
  unlisted?: true
}
/** How many native sub-streams a Workstream hosts, and how deep below it: an adapter's own bounds are not Agora's to trust. */
export const MAX_SUBAGENTS = 64
export const MAX_SUBAGENT_DEPTH = 5
/** A native sub-stream's id (docs/specs/log.md, "Native sub-agents", "Announced"). */
export const childWorkstream = (host: string, acpId: string): string => identity(host, acpId, 'subagent')
/** A native sub-stream's state: `working`, `waiting`, else its last turn's. */
export function subagentOf(child: Child): 'working' | 'waiting' | 'idle' | 'failed' | 'cancelled' {
  const turn = child.turns.at(-1)
  if (!turn || turn.status === 'done') return 'idle'
  if (turn.status === 'in_progress') return child.waiting ? 'waiting' : 'working'
  return turn.status === 'cancelled' ? 'cancelled' : 'failed'
}
/**
 * The sub-agent a received line announces, when it does (docs/specs/log.md, "Native sub-agents", "Announced"): a
 * `subagent_update` on a session known in that execution — its Session's own, the one its opening replays, or a
 * sub-agent's already announced — naming an ACP session not known there. Its id, and the Workstream that announces it.
 */
export function announcement(state: State, execution: Execution | undefined, line: unknown): { acpId: string; parent: string; listed: boolean } | null {
  const message = object(line)
  const params = object(message?.params)
  const update = message?.method === 'session/update' ? object(params?.update) : null
  const sid = params?.sessionId
  if (!execution || update?.sessionUpdate !== 'subagent_update' || typeof update.sessionId !== 'string' || typeof sid !== 'string') return null
  if (state.children.has(update.sessionId) || update.sessionId === execution.acpId || update.sessionId === execution.openingAcp) return null
  const announcer = state.children.get(sid)
  const parent = sid === execution.acpId || sid === execution.openingAcp ? state.workstream : announcer?.workstream
  if (parent === undefined) return null
  // Its depth below its host: one more than the sub-agent that announced it.
  let depth = 1
  for (let above = announcer; above !== undefined; above = [...state.children.values()].find((c) => c.workstream === above!.parent)) depth++
  const listed = announcer?.unlisted !== true && depth <= MAX_SUBAGENT_DEPTH && [...state.children.values()].filter((c) => !c.unlisted).length < MAX_SUBAGENTS
  return { acpId: update.sessionId, parent, listed }
}
/** Whether a sub-agent of an execution has a turn in progress (docs/specs/log.md, "Native sub-agents", "Messages during a turn"). */
export const childWorking = (state: State, execution: string): boolean =>
  [...state.children.values()].some((c) => c.execution === execution && c.turns.at(-1)?.status === 'in_progress')

export interface PromptCapabilities {
  image: boolean
  audio: boolean
  embeddedContext: boolean
}
/** Whether an agent accepts each block of a prompt (docs/specs/log.md, "Commands"): text and links always. */
export function acceptsPrompt(caps: PromptCapabilities | null, prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return true
  return prompt.every((b) => {
    const type = object(b)?.type
    if (type === 'image') return caps?.image === true
    if (type === 'audio') return caps?.audio === true
    if (type === 'resource') return caps?.embeddedContext === true
    return true
  })
}
/** An `initialize` answer's prompt capabilities: each true only when the agent says so. */
export function promptCapabilitiesOf(result: unknown): PromptCapabilities {
  const caps = object(object(object(result)?.agentCapabilities)?.promptCapabilities)
  return { image: caps?.image === true, audio: caps?.audio === true, embeddedContext: caps?.embeddedContext === true }
}
export interface State {
  workstream: string
  executions: Map<string, Execution>
  requests: Map<string, Entry>
  requestPositions: Map<string, Entry>
  answers: Set<string>
  attempts: Set<string>
  sent: Set<string>
  /** When each line's write was confirmed (`acp.sent`), by the line's position. */
  sentAt: Map<string, string>
  /** Outgoing lines never attempted nor failed, in position order. */
  outbox: Map<string, Entry>
  /** Outgoing requests without a valid answer, by position. */
  unanswered: Set<string>
  /** The first valid answer to each request, by the request's position. */
  answeredBy: Map<string, string>
  failures: Set<string>
  /** Requests failed for want of an answer in time (`response_timeout`). */
  timedOut: Set<string>
  turns: Map<string, Turn>
  active: Turn | null
  current: Execution | null
  permissions: Map<string, Entry>
  /** The pending question: its Ask (docs/specs/log.md, "Commands"). */
  question: Entry | null
  /** Each approval's wait (docs/specs/delegation.md, "Approval"): from its Ask to its end, open while pending. */
  waits: { from: string; to: string | null }[]
  /** The messages waiting, oldest first: their Writes (docs/specs/log.md, "Messages during a turn"). */
  waiting: Entry[]
  /** The position of the `_session/steering` line unanswered, or null. */
  steering: string | null
  /** The running turn takes no more messages: a `session/cancel` was written, or a `_session/steering` did not end `injected`. */
  unsteerable: boolean
  /** A `session/cancel` was written, and no Write has been accepted since: the messages waiting stay. */
  held: boolean
  /** The tool calls of the running turn still open. */
  tools: Set<string>
  /** The native sub-agents announced in this Workstream's executions, by ACP session id (docs/specs/log.md, "Native sub-agents"). */
  children: Map<string, Child>
}

/** Whether a question's Ask is one of Agora's approvals (docs/specs/delegation.md, "Approval"). */
export const isApproval = (ask: Entry | null): boolean => ask !== null && object(ask.content.body)?.kind === 'approval'
/** Whether a question's Ask is a merge card (docs/specs/merge.md). */
export const isMerge = (ask: Entry | null): boolean => ask !== null && object(ask.content.body)?.kind === 'merge'

/** How long the approvals asked since `since` waited, those still pending counted until `now` (ms). */
export function waited(state: State, since: string, now: number): number {
  const start = Date.parse(since)
  return state.waits.filter((w) => Date.parse(w.from) >= start).reduce((sum, w) => sum + ((w.to === null ? now : Date.parse(w.to)) - Date.parse(w.from)), 0)
}
/**
 * A delegate's state (docs/specs/delegation.md, "A delegation"): `working` while its Session opens, a turn runs or a
 * message waits; else as its last turn ended; `failed` or `cancelled` when its execution failed, was lost or was stopped.
 */
export function delegationOf(state: State): 'working' | 'idle' | 'failed' | 'cancelled' {
  const e = state.current
  if (e?.failed || e?.lost) return 'failed'
  if (e?.stopped) return 'cancelled'
  if (e?.ended && !e.session) return 'failed'
  if (state.active || (state.waiting.length > 0 && !state.held) || (e && !e.ended && !e.session)) return 'working'
  const turn = [...state.turns.values()].at(-1)
  if (!turn) return e?.ended || (e?.session && settled(state, e)) ? 'idle' : 'working'
  return turn.status === 'done' ? 'idle' : turn.status === 'cancelled' ? 'cancelled' : 'failed'
}

/** A message's blocks as its element holds them, and who wrote it, Agora's line left out (docs/specs/log.md, "Elements"). */
function said(prompt: unknown): { content: unknown; from?: unknown; as?: unknown } {
  if (!Array.isArray(prompt)) return { content: prompt }
  const blocks = (prompt as unknown[]).filter((b) => !isCatchUp(b))
  const mark = object(object(object(blocks[0])?._meta)?.[FROM_META])
  if (mark !== null) return { content: blocks.slice(1), from: mark.workstream, as: mark.as }
  const earlier = blocks.map((b) => object(object(b)?._meta)?.[DELEGATION_META]).find((m) => m !== undefined)
  return earlier === undefined ? { content: blocks } : { content: blocks, from: object(earlier)?.caller ?? earlier }
}

/** The profiles a Create or a Scope recorded. */
function profilesIn(body: unknown): string[] {
  const profiles = object(body)?.profiles
  return Array.isArray(profiles) ? profiles.map(String) : []
}

/** A sub-agent's turn opens at a line of its own: its `requestPosition` that line's (docs/specs/log.md, "Native sub-agents", "Its turns"). */
function openChild(child: Child, entry: Entry): void {
  child.waiting = false
  child.turns.push({
    id: identity(child.workstream, entry.position, 'turn'),
    session: child.session,
    execution: child.execution,
    requestId: null,
    requestPosition: entry.position,
    startedAt: entry.time,
    status: 'in_progress',
    dispatching: true,
    answered: false,
    native: true,
  })
}
/** Its turn in progress ends: by what it said, or with its host's Session or execution. */
function endChild(child: Child, status: TurnStatus, stopReason?: unknown, failure?: unknown): void {
  const turn = child.turns.at(-1)
  if (turn?.status !== 'in_progress') return
  turn.status = status
  turn.answered = true
  if (stopReason !== undefined) turn.stopReason = stopReason
  if (failure !== undefined) turn.failure = failure
  child.waiting = false
}

export function fold(entries: readonly Entry[], initial?: State): State {
  const state: State = initial ?? {
    workstream: entries[0]?.workstream ?? '',
    executions: new Map(),
    requests: new Map(),
    requestPositions: new Map(),
    answers: new Set(),
    attempts: new Set(),
    sent: new Set(),
    sentAt: new Map(),
    outbox: new Map(),
    unanswered: new Set(),
    answeredBy: new Map(),
    failures: new Set(),
    timedOut: new Set(),
    turns: new Map(),
    active: null,
    current: null,
    permissions: new Map(),
    question: null,
    waits: [],
    waiting: [],
    steering: null,
    unsteerable: false,
    held: false,
    tools: new Set(),
    children: new Map(),
  }
  const turnsByRequest = new Map<string, Turn>([...state.turns.values()].map((turn) => [turn.requestPosition, turn]))
  for (const entry of entries) {
    const content = entry.content
    if (entry.kind === 'command' && content.kind === 'Create' && entry.execution) {
      const execution: Execution = {
        id: entry.execution,
        claimName: String(content.claimName),
        body: object(content.body) ?? {},
        session: null,
        acpId: null,
        stopped: false,
        ended: false,
        lost: false,
        clean: false,
        initialized: false,
        settings: null,
        configSent: [],
        commands: [],
        usage: null,
        profiles: profilesIn(content.body),
        promptCapabilities: null,
        steering: false,
        openingAcp: null,
        prompted: false,
      }
      state.executions.set(execution.id, execution)
      state.current = execution
    }
    const execution = entry.execution ? state.executions.get(entry.execution) : undefined
    if (entry.kind === 'command' && content.kind === 'Ask') {
      if (isApproval(entry)) state.waits.push({ from: entry.time, to: null })
      state.question = entry
    }
    // An approval ends answered, refused by a Write, or expired (docs/specs/delegation.md, "Approval").
    const settles =
      (entry.kind === 'command' && content.kind === 'Answer') ||
      (entry.kind === 'command' && content.kind === 'Write' && content.waits !== true && isApproval(state.question)) ||
      (['question.expired', 'question.cancelled'].includes(entry.kind) && state.question !== null && String(object(content)?.question) === state.question.position)
    if (settles) {
      if (isApproval(state.question)) {
        const open = state.waits.at(-1)
        if (open && open.to === null) open.to = entry.time
      }
      state.question = null
    }
    if (entry.kind === 'command' && content.kind === 'Write') {
      state.held = false
      if (content.waits === true) state.waiting.push(entry)
    }
    if (entry.kind === 'command' && content.kind === 'Retract') state.waiting = state.waiting.filter((w) => w.position !== String(object(content.target)?.message))
    if (entry.kind === 'command' && content.kind === 'Stop' && execution) execution.stopped = true
    if (entry.kind === 'command' && content.kind === 'Scope' && execution) execution.profiles = profilesIn(content.body)
    if (entry.kind === 'execution.obtained' && execution) execution.uid = String(content.uid)
    if (entry.kind === 'execution.connected' && execution) {
      execution.instance = String(content.instance)
      execution.connection = String(content.connection)
      execution.clean = false
    }
    if (entry.kind === 'execution.break' && execution) {
      const current = execution.connection === content.connection
      if (current) {
        execution.clean = content.clean === true
        execution.connection = undefined
      }
      if (content.clean !== true)
        for (const turn of state.turns.values())
          if (
            turn.execution === execution.id &&
            turn.dispatching &&
            !turn.answered &&
            turn.status !== 'failed' &&
            (current || turn.connection === content.connection)
          )
            turn.status = 'uncertain'
    }
    if (['execution.ended', 'execution.lost', 'execution.failed'].includes(entry.kind) && execution) {
      if (entry.kind === 'execution.ended') execution.ended = true
      if (entry.kind === 'execution.lost') execution.lost = true
      if (entry.kind === 'execution.failed') execution.failed = true
      execution.connection = undefined
      for (const turn of state.turns.values())
        if (turn.execution === execution.id && !turn.answered) turn.status = 'failed'
      // A sub-agent's turn ends with its host's execution, as any turn (docs/specs/log.md, "Native sub-agents").
      for (const child of state.children.values()) if (child.execution === execution.id) endChild(child, 'failed', undefined, entry.kind.slice('execution.'.length))
      if (state.steering !== null && state.requestPositions.get(state.steering)?.execution === execution.id) state.steering = null
      state.tools.clear()
      // Given back (docs/specs/log.md, "Messages during a turn"): its Create's message, the execution having taken no prompt.
      if (!execution.prompted) state.waiting = state.waiting.filter((w) => w.content.first !== execution.id)
    }
    if (
      entry.kind === 'session.ended' ||
      ['execution.ended', 'execution.lost', 'execution.failed'].includes(entry.kind)
    )
      for (const [key, permission] of state.permissions)
        if (
          entry.kind === 'session.ended'
            ? permission.session === entry.session
            : permission.execution === entry.execution
        )
          state.permissions.delete(key)
    if (entry.kind === 'session.ended') for (const child of state.children.values()) if (child.session === entry.session) endChild(child, 'failed', undefined, 'session_ended')
    if (entry.kind === 'session.opened' && execution) {
      execution.session = entry.session
      execution.acpId = String(content.acpId)
      execution.openingAcp = null
    }
    if (entry.kind === 'acp') {
      const key = `${entry.direction}:${idKey(entry.rpc_id)}`
      if (entry.direction === 'out') state.outbox.set(entry.position, entry)
      if (entry.rpc_kind === 'request' && entry.direction === 'out') state.unanswered.add(entry.position)
      if (entry.rpc_kind === 'request') {
        state.requests.set(key, entry)
        state.requestPositions.set(entry.position, entry)
        if (entry.method === 'session/request_permission' && entry.direction === 'in') state.permissions.set(key, entry)
        if (entry.method === 'session/set_config_option' && entry.direction === 'out' && execution && entry.session === execution.session) {
          const id = object(content.params)?.configId
          if (typeof id === 'string') execution.configSent.push(id)
        }
        if (entry.method === 'session/prompt' && entry.direction === 'out' && entry.execution) {
          const turn: Turn = {
            id: identity(entry.session ?? entry.execution, idKey(entry.rpc_id), 'turn'),
            session: entry.session,
            execution: entry.execution,
            requestId: entry.rpc_id,
            requestPosition: entry.position,
            startedAt: entry.time,
            status: 'saved',
            dispatching: false,
            answered: false,
          }
          state.turns.set(turn.id, turn)
          turnsByRequest.set(entry.position, turn)
          if (execution) execution.prompted = true
          // A message that waited has gone; the new turn takes messages, its tools to come.
          state.waiting = state.waiting.filter((w) => w.command !== entry.command)
          state.unsteerable = false
          state.tools.clear()
        }
        if (entry.method === STEERING && entry.direction === 'out') state.steering = entry.position
        if (['session/resume', 'session/load'].includes(entry.method ?? '') && entry.direction === 'out' && execution) {
          const opening = object(content.params)?.sessionId
          execution.openingAcp = typeof opening === 'string' ? opening : null
        }
      } else if (entry.rpc_kind === 'response' || entry.rpc_kind === 'error') {
        const requestKey = `${entry.direction === 'in' ? 'out' : 'in'}:${idKey(entry.rpc_id)}`
        const request = entry.request_position
          ? state.requestPositions.get(entry.request_position)
          : state.requests.get(requestKey)
        if (request && request.execution === entry.execution && !state.answers.has(request.position)) {
          state.answers.add(request.position)
          state.answeredBy.set(request.position, entry.position)
          state.unanswered.delete(request.position)
          if (state.permissions.get(requestKey)?.position === request.position) state.permissions.delete(requestKey)
          if (request.method === 'initialize' && entry.rpc_kind === 'response' && execution) {
            execution.initialized = true
            execution.promptCapabilities = promptCapabilitiesOf(content.result)
            execution.steering = object(object(object(content.result)?._meta)?.steering)?.supported === true
          }
          if (request.method === STEERING) {
            if (state.steering === request.position) state.steering = null
            if (entry.rpc_kind === 'response' && object(content.result)?.outcome === 'injected') state.waiting = state.waiting.filter((w) => w.command !== request.command)
            else state.unsteerable = true
          }
          // A Session's settings: those its opening answer gives, then each answer to a change.
          if (entry.rpc_kind === 'response' && execution && entry.session) {
            const given = object(content.result)?.configOptions
            if (OPENING_METHODS.includes(request.method ?? '')) {
              execution.settings = Array.isArray(given) ? given : null
              execution.configSent = []
              execution.commands = []
              execution.usage = null
            } else if (request.method === 'session/set_config_option' && Array.isArray(given) && request.session === execution.session)
              execution.settings = given
          }
          const turn = turnsByRequest.get(request.position)
          if (turn) {
            turn.answered = true
            const result = object(content.result)
            turn.stopReason = result?.stopReason
            if (entry.rpc_kind === 'error') turn.failure = content.error
            else delete turn.failure
            turn.status =
              entry.rpc_kind === 'error' ? 'failed' : result?.stopReason === 'cancelled' ? 'cancelled' : 'done'
            state.tools.clear()
          }
        }
      }
      if (entry.method === 'session/cancel' && entry.direction === 'out' && !state.children.has(String(object(content.params)?.sessionId))) {
        state.unsteerable = true
        state.held = true
      }
      // Native sub-agents (docs/specs/log.md, "Native sub-agents"): announced, then what each says of its work.
      if (entry.direction === 'in' && execution && entry.rpc_kind !== 'response' && entry.rpc_kind !== 'error') {
        const params = object(content.params)
        const update = entry.method === 'session/update' ? object(params?.update) : null
        const sid = typeof params?.sessionId === 'string' ? params.sessionId : null
        // What a Session's opening replays before its answer gives no turn: the sub-agents it names are only known again.
        const replayed = execution.session === null
        if (update?.sessionUpdate === 'subagent_update' && typeof update.sessionId === 'string' && sid !== null) {
          let child = state.children.get(update.sessionId)
          const announced = announcement(state, execution, content)
          if (announced) {
            child = {
              acpId: announced.acpId,
              workstream: childWorkstream(state.workstream, announced.acpId),
              parent: announced.parent,
              execution: execution.id,
              session: execution.session,
              title: null,
              description: null,
              ownTitle: null,
              cancel: false,
              waiting: false,
              turns: [],
              announcedAt: entry.position,
              ...(announced.listed ? {} : { unlisted: true as const }),
            }
            state.children.set(child.acpId, child)
          }
          // Seen again in a later execution, at work: it is that execution's now, its Session's.
          if (child && !replayed && child.execution !== execution.id) {
            child.execution = execution.id
            child.session = execution.session
          }
          if (child && !replayed) {
            if (Object.hasOwn(update, 'title')) child.title = typeof update.title === 'string' && update.title.trim() !== '' ? update.title.trim() : null
            if (Object.hasOwn(update, 'description')) child.description = typeof update.description === 'string' && update.description.trim() !== '' ? update.description.trim() : null
            if (Object.hasOwn(update, 'capabilities')) child.cancel = object(object(update.capabilities)?.cancel) !== null
            const said = object(update.state)
            const working = said?.state === 'running' || said?.state === 'requires_action'
            const open = child.turns.at(-1)?.status === 'in_progress'
            // A turn opens with its first line, unless that line says it is done; after an `idle`, with the next working state.
            if (!open && (working || (child.turns.length === 0 && said?.state !== 'idle'))) openChild(child, entry)
            if (working) child.waiting = said?.state === 'requires_action'
            if (said?.state === 'idle') {
              const failure = object(said.error)?.message ?? said.error
              endChild(child, said.stopReason === 'cancelled' ? 'cancelled' : said.stopReason === 'error' ? 'failed' : 'done', said.stopReason, said.stopReason === 'error' ? failure : undefined)
            }
          }
        } else if (sid !== null && !replayed) {
          const child = state.children.get(sid)
          if (child && child.execution !== execution.id) {
            child.execution = execution.id
            child.session = execution.session
          }
          if (child && child.turns.length === 0) openChild(child, entry)
          if (child && update?.sessionUpdate === 'session_info_update' && Object.hasOwn(update, 'title')) child.ownTitle = typeof update.title === 'string' && update.title.trim() !== '' ? update.title.trim() : null
        }
      }
    }
    if (entry.kind === 'acp' && entry.direction === 'in' && entry.method === 'session/update' && execution && entry.session === execution.session && !state.children.has(String(object(content.params)?.sessionId))) {
      const update = object(object(content.params)?.update)
      if (update?.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) execution.settings = update.configOptions
      if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) execution.commands = update.availableCommands
      if (update?.sessionUpdate === 'usage_update') {
        const used = schemaValue(update.used),
          size = schemaValue(update.size)
        if (typeof used === 'number' && typeof size === 'number' && Number.isFinite(used) && used >= 0 && Number.isFinite(size) && size > 0)
          execution.usage = { used, size }
      }
      if ((update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') && typeof update.toolCallId === 'string') {
        if (update.status === 'completed' || update.status === 'failed') state.tools.delete(update.toolCallId)
        else if (update.sessionUpdate === 'tool_call' || update.status === 'pending' || update.status === 'in_progress') state.tools.add(update.toolCallId)
      }
    }
    if (entry.kind === 'acp.dispatching') {
      const position = String(content.requestPosition)
      state.attempts.add(position)
      state.outbox.delete(position)
      const turn = turnsByRequest.get(position)
      if (turn && !turn.answered) {
        turn.dispatching = true
        if (typeof content.connection === 'string') turn.connection = content.connection
        turn.status = 'in_progress'
        if (!turn.startedAt && typeof content.startedAt === 'string') turn.startedAt = content.startedAt
      }
    }
    if (entry.kind === 'acp.sent') {
      state.sent.add(String(content.requestPosition))
      state.sentAt.set(String(content.requestPosition), entry.time)
    }
    if (entry.kind === 'request.failed') {
      const position = String(content.requestPosition)
      state.failures.add(position)
      if (content.reason === 'response_timeout') state.timedOut.add(position)
      state.outbox.delete(position)
      if (state.steering === position) {
        state.steering = null
        state.unsteerable = true
      }
      const turn = turnsByRequest.get(position)
      if (turn && !turn.answered) {
        turn.failure = content.reason
        turn.status = turn.dispatching ? 'uncertain' : 'failed'
      }
    }
  }
  state.active =
    [...state.turns.values()].find((turn) => ['saved', 'in_progress', 'uncertain'].includes(turn.status)) ?? null
  return state
}
export interface ProjectedObject {
  kind: 'workstream' | 'turn' | 'element' | 'notice'
  id: string
  object: Record<string, unknown>
  first_position: string
  last_position: string
  /** The Workstream whose thread holds it, when not the one folded: a native sub-stream's (docs/specs/log.md, "Native sub-agents"). */
  workstream?: string
}
/**
 * The core projector, incremental (docs/specs/log.md, "Views"): `apply` folds further entries and
 * returns the objects they changed. Folding the same entries from the start gives the same objects.
 */
export class CoreProjection {
  readonly objects = new Map<string, ProjectedObject>()
  position = '0'
  private folded: State | undefined
  private readonly ranks = new Map<string, number>()
  private readonly runs = new Map<string, { discriminator: string; id: string }>()
  private readonly turnCodes = new Map<string, string>()
  /** Each waiting message's element, by its Write's command (docs/specs/log.md, "Elements"). */
  private readonly waitingElements = new Map<string, string>()
  /** The Workstream view's title sources (docs/specs/log.md, "The Workstream view"). */
  private firstWrite: string | null = null
  /** The approval pending, as an element's id: what a Write refuses (docs/specs/delegation.md, "Approval"). */
  private pendingQuestion: string | null = null
  private agentTitle: string | null = null
  /** The Workstream is a delegate's (docs/specs/delegation.md): its view says how it stands. */
  private delegate = false
  /** The anchor each ended execution names, and the Sessions that have ended. */
  private readonly anchors = new Map<string, string>()
  private readonly endedSessions = new Set<string>()
  /** The Workstream's anchors, for what a Create would restore (docs/specs/log.md, "Continuing"). */
  private readonly known = noAnchors()
  /** What the view last showed of the settings, to put it only when that changes. */
  private settingsCode = ''
  /** What was last put of each native sub-agent — its turns, its view, its line in its parent's thread —, and the turn that announced it. */
  private readonly childCodes = new Map<string, string>()
  private readonly announcedIn = new Map<string, string | undefined>()
  apply(entries: readonly Entry[]): Set<string> {
    const changed = new Set<string>()
    const objects = this.objects,
      ranks = this.ranks,
      runs = this.runs
    const put = (kind: ProjectedObject['kind'], id: string, value: Record<string, unknown>, position: string, target?: string) => {
      const previous = objects.get(id)
      const workstream = target ?? previous?.workstream
      objects.set(id, {
        kind,
        id,
        // Not re-encoded here: a long text would cost its whole size at every chunk. It is encoded
        // once per projection run, when written.
        object: { ...value, id, firstPosition: previous?.first_position ?? position, lastPosition: position },
        first_position: previous?.first_position ?? position,
        last_position: position,
        ...(workstream !== undefined ? { workstream } : {}),
      })
      changed.add(id)
    }
    /** A message no longer waits: its element keeps its position and its status, not its blocks. */
    const left = (id: string | undefined, status: 'sent' | 'retracted', position: string) => {
      const previous = id === undefined ? undefined : objects.get(id)
      if (id !== undefined && previous?.object.status === 'waiting') put('element', id, { type: 'waiting', position: previous.object.position, status }, position)
    }
    for (const entry of entries) {
      const state = fold([entry], this.folded),
        active = state.active
      this.folded = state
      this.position = entry.position
      // Only a turn without its answer, or the one this entry answers, can change.
      for (const turn of state.turns.values()) {
        if (turn.answered && this.turnCodes.has(turn.id) && turn.requestPosition !== entry.request_position) continue
        const code = encode({ ...turn, id: turn.id })
        if (this.turnCodes.get(turn.id) === code) continue
        this.turnCodes.set(turn.id, code)
        put('turn', turn.id, { ...turn }, entry.position)
      }
      let titled = false
      if (entry.kind === 'command' && entry.content.kind === 'Write' && this.firstWrite === null) {
        const written = said(object(entry.content.body)?.prompt).content
        const blocks = Array.isArray(written) ? (written as unknown[]) : []
        const text = blocks.map((b) => object(b)).find((b) => b?.type === 'text' && typeof b.text === 'string')?.text as string | undefined
        const line = text?.split('\n').map((l) => l.trim()).find((l) => l !== '')
        if (line) this.firstWrite = line.slice(0, 80)
      }
      // A message that waits (docs/specs/log.md, "Messages during a turn"): its Write, then its line's or its Retract.
      if (entry.kind === 'command' && entry.content.kind === 'Write' && entry.content.waits === true) {
        const id = identity(entry.workstream, entry.position, 'waiting')
        this.waitingElements.set(String(entry.command), id)
        const first = typeof entry.content.first === 'string' ? { first: entry.content.first } : {}
        put('element', id, { type: 'waiting', position: entry.position, status: 'waiting', ...first, ...said(object(entry.content.body)?.prompt) }, entry.position)
      }
      // A Create's message given back (docs/specs/log.md, "Messages during a turn"): it keeps its blocks.
      if (['execution.ended', 'execution.lost', 'execution.failed'].includes(entry.kind) && entry.execution && state.executions.get(entry.execution)?.prompted === false)
        for (const item of [...objects.values()])
          if (item.object.type === 'waiting' && item.object.status === 'waiting' && item.object.first === entry.execution)
            put('element', item.id, { ...item.object, status: 'returned' }, entry.position)
      if (entry.kind === 'command' && entry.content.kind === 'Retract')
        left(identity(entry.workstream, String(object(entry.content.target)?.message), 'waiting'), 'retracted', entry.position)
      // A question to the person (docs/specs/log.md, "Elements"): its Ask, then its Answer.
      if (entry.kind === 'command' && entry.content.kind === 'Ask') {
        const body = object(entry.content.body) ?? {}
        const approval = body.kind === 'approval'
        const merge = body.kind === 'merge'
        put(
          'element',
          identity(entry.workstream, entry.position, 'question'),
          {
            type: 'question',
            position: entry.position,
            title: body.title,
            text: body.text,
            options: body.options,
            note: body.note === true,
            ...(approval ? { kind: 'approval', toolCallId: body.toolCallId ?? null, expiresAt: body.expiresAt } : {}),
            ...(merge ? { kind: 'merge', repo: body.repo, number: schemaValue(body.number), url: body.url } : {}),
            status: 'pending',
          },
          entry.position,
        )
        this.pendingQuestion = approval ? identity(entry.workstream, entry.position, 'question') : null
      }
      // An approval refused by a Write: its text the answer; no turn (docs/specs/delegation.md, "Approval").
      if (entry.kind === 'command' && entry.content.kind === 'Write' && entry.content.waits !== true && this.pendingQuestion !== null) {
        const id = this.pendingQuestion
        const blocks = object(entry.content.body)?.prompt
        const text = (Array.isArray(blocks) ? blocks : []).map((b) => object(b)).filter((b) => b?.type === 'text').map((b) => String(b!.text)).join('\n')
        put('element', id, { ...objects.get(id)?.object, status: 'refused', answer: { note: text } }, entry.position)
        this.pendingQuestion = null
      }
      if (entry.kind === 'question.expired') {
        const id = identity(entry.workstream, String(object(entry.content)?.question), 'question')
        if (objects.get(id)?.object.status === 'pending') put('element', id, { ...objects.get(id)?.object, status: 'expired' }, entry.position)
        this.pendingQuestion = null
      }
      // A merge card cancelled by the person's message, then its outcome (docs/specs/merge.md).
      if (entry.kind === 'question.cancelled') {
        const id = identity(entry.workstream, String(object(entry.content)?.question), 'question')
        if (objects.get(id)?.object.status === 'pending') put('element', id, { ...objects.get(id)?.object, status: 'cancelled' }, entry.position)
      }
      if (entry.kind === 'merge.merged' || entry.kind === 'merge.refused') {
        const id = identity(entry.workstream, String(object(entry.content)?.question), 'question')
        const outcome = entry.kind === 'merge.merged' ? { merged: true, sha: String(object(entry.content)?.sha ?? '') } : { merged: false, reason: String(object(entry.content)?.reason ?? '') }
        if (objects.has(id)) put('element', id, { ...objects.get(id)?.object, outcome }, entry.position)
      }
      if (entry.kind === 'command' && entry.content.kind === 'Answer') {
        const id = identity(entry.workstream, String(object(entry.content.target)?.question), 'question')
        const body = object(entry.content.body) ?? {}
        put(
          'element',
          id,
          { ...objects.get(id)?.object, status: 'answered', answer: { optionId: body.optionId, ...(typeof body.note === 'string' ? { note: body.note } : {}) } },
          entry.position,
        )
        this.pendingQuestion = null
      }
      if (entry.kind === 'acp' && entry.method === 'session/update') {
        const update = object(object(entry.content.params)?.update)
        // An agent titling itself with the first thing it read: Agora's line is not what it works on.
        if (update?.sessionUpdate === 'session_info_update' && Object.hasOwn(update, 'title') && !state.children.has(String(object(entry.content.params)?.sessionId)) && !(typeof update.title === 'string' && /^\s*From (your delegator\b|your delegate\b|Agora,)/.test(update.title))) {
          this.agentTitle = typeof update.title === 'string' && update.title.trim() !== '' ? update.title.trim() : null
          titled = true
        }
      }
      if (entry.kind === 'execution.ended' && entry.execution && typeof entry.content.anchor === 'string') this.anchors.set(entry.execution, entry.content.anchor)
      if (entry.kind === 'delegation.started') this.delegate = true
      noteAnchor(this.known, entry, state)
      if (entry.kind === 'session.ended' && entry.session) this.endedSessions.add(entry.session)
      // Settings, commands, usage and prompt capabilities change with ACP lines too: the view is put when what it shows of them changed.
      const execution0 = state.current
      const settingsCode = execution0
        ? encode({ s: execution0.settings, c: execution0.commands, u: execution0.usage, k: configuring(state, execution0), o: settled(state, execution0), p: execution0.promptCapabilities })
        : ''
      const settingsChanged = settingsCode !== this.settingsCode
      this.settingsCode = settingsCode
      if (
        titled ||
        settingsChanged ||
        entry.kind === 'command' ||
        entry.kind === 'anchor.received' ||
        (entry.kind === 'acp.dispatching' && state.requestPositions.get(String(entry.content.requestPosition))?.method === 'session/prompt') ||
        // A delegate's: its start, and each turn's end — its answer or its failure.
        entry.kind === 'delegation.started' ||
        entry.kind === 'delegation.continued' ||
        (this.delegate && ((entry.kind === 'acp' && entry.direction === 'in' && (entry.correlated_method === 'session/prompt' || entry.correlated_method === STEERING)) || entry.kind === 'request.failed')) ||
        entry.kind.startsWith('execution.') ||
        entry.kind.startsWith('session.')
      ) {
        const execution = state.current
        const session = execution?.session && !this.endedSessions.has(execution.session) ? execution.session : null
        // What a Create would give the agent: per harness, the anchor it restores and the exchanges it lacks.
        const continuation: Record<string, { anchor: string; exchanges: number }> = {}
        for (const harness of [...new Set([...this.known.of.values()].map((a) => a.harness))].sort()) {
          const anchor = lastAnchor(this.known, state, harness)
          if (anchor !== null) continuation[harness] = { anchor, exchanges: lacking(this.known, state, anchor).length }
        }
        put(
          'workstream',
          entry.workstream,
          {
            execution: execution?.id ?? null,
            session,
            stopped: execution?.stopped ?? false,
            ended: execution?.ended ?? false,
            lost: execution?.lost ?? false,
            ...(execution?.failed ? { failed: true } : {}),
            unavailable:
              execution === null || execution.ended || execution.lost || execution.failed === true || !session || !execution.connection,
            title: this.agentTitle ?? this.firstWrite ?? 'New workstream',
            state: workstreamState(execution, session, execution !== null && settled(state, execution)),
            settings: execution && execution.settings !== null ? settingsOf(execution.settings) : null,
            commands: execution ? commandsOf(execution.commands) : [],
            configuring: execution !== null && session !== null && configuring(state, execution),
            usage: execution !== null && session !== null ? execution.usage : null,
            profiles: execution?.profiles ?? [],
            promptCapabilities: execution?.promptCapabilities ?? null,
            pool: typeof execution?.body.pool === 'string' ? execution.body.pool : null,
            harness: typeof execution?.body.harness === 'string' ? execution.body.harness : null,
            anchor: (execution && this.anchors.get(execution.id)) ?? null,
            exchanges: dispatched(state).length,
            question: state.question?.position ?? null,
            ...(this.delegate ? { delegation: delegationOf(state) } : {}),
            continuation,
            changedAt: entry.time,
          },
          entry.position,
        )
      }
      const notice =
        entry.kind === 'session.opened'
          ? {
              origin: entry.content.origin ?? 'new',
              harness: entry.content.harness ?? null,
              ...(entry.content.catchUp !== undefined ? { catchUp: entry.content.catchUp, omitted: entry.content.omitted ?? 0 } : {}),
            }
          : entry.kind === 'session.ended' ||
              entry.kind === 'request.failed' ||
              (entry.kind === 'execution.break' && entry.content.clean !== true) ||
              ['execution.lost', 'execution.failed', 'execution.ended'].includes(entry.kind)
            ? { reason: entry.content.reason ?? 'transport_error' }
            : null
      if (notice)
        put(
          'notice',
          identity(entry.workstream, entry.position, 'notice'),
          { type: entry.kind, ...notice, execution: entry.execution, session: entry.session },
          entry.position,
        )
      if (
        entry.kind === 'session.ended' ||
        ['execution.ended', 'execution.lost', 'execution.failed'].includes(entry.kind)
      )
        for (const item of objects.values())
          if (
            item.object.type === 'permission' &&
            item.object.status === 'pending' &&
            (entry.kind === 'session.ended'
              ? item.object.session === entry.session
              : item.object.execution === entry.execution)
          )
            put('element', item.id, { ...item.object, status: 'cancelled' }, entry.position)
      /**
       * A native sub-agent as its sub-stream shows it (docs/specs/log.md, "Native sub-agents"): its turns, its view, and
       * its line in its parent's thread, each put when it changed.
       */
      const putChild = (child: Child) => {
        if (child.unlisted) return
        const code = (key: string, value: unknown): boolean => {
          const encoded = encode(value)
          if (this.childCodes.get(key) === encoded) return false
          this.childCodes.set(key, encoded)
          return true
        }
        for (const turn of child.turns) if (code(turn.id, turn)) put('turn', turn.id, { ...turn }, entry.position, child.workstream)
        const title = child.ownTitle ?? child.title ?? 'Sub-agent'
        const subagent = subagentOf(child)
        const harness = state.executions.get(child.execution)?.body.harness
        const view = {
          execution: null,
          session: null,
          stopped: false,
          ended: false,
          lost: false,
          unavailable: true,
          title,
          state: 'native',
          settings: null,
          commands: [],
          configuring: false,
          usage: null,
          profiles: [],
          promptCapabilities: null,
          pool: null,
          harness: typeof harness === 'string' ? harness : null,
          anchor: null,
          exchanges: child.turns.length,
          question: null,
          native: { host: entry.workstream, description: child.description, cancel: child.cancel },
          subagent,
          continuation: {},
        }
        if (code(`view:${child.workstream}`, view)) put('workstream', child.workstream, { ...view, changedAt: entry.time }, entry.position, child.workstream)
        // Its line is of the turn its parent was in when it was first shown: its host's, or the announcing sub-agent's.
        if (!this.announcedIn.has(child.acpId)) {
          const above = [...state.children.values()].find((c) => c.workstream === child.parent)
          const turn = above ? above.turns.at(-1) : (active ?? [...state.turns.values()].reverse().find((t) => t.session === child.session))
          this.announcedIn.set(child.acpId, turn?.id)
          // What its parent says after it is a text of its own, below its line.
          if (turn) runs.delete(turn.id)
        }
        const line = { type: 'subagent', turn: this.announcedIn.get(child.acpId), session: child.session, workstream: child.workstream, title, description: child.description, state: subagent, cancel: child.cancel }
        // In its parent's thread: its host's, or the sub-stream of the sub-agent that announced it.
        if (code(`line:${child.workstream}`, line)) put('element', identity(child.workstream, 'subagent'), line, entry.position, child.parent === entry.workstream ? undefined : child.parent)
      }
      // Their host's Session or execution ending ends their turns too.
      if (entry.kind === 'session.ended' || ['execution.ended', 'execution.lost', 'execution.failed'].includes(entry.kind))
        for (const child of state.children.values()) if (this.announcedIn.has(child.acpId)) putChild(child)
      if (entry.kind !== 'acp') continue
      const request =
        entry.rpc_kind === 'request'
          ? entry
          : entry.request_position
            ? state.requestPositions.get(entry.request_position)
            : state.requests.get(`${entry.direction === 'in' ? 'out' : 'in'}:${idKey(entry.rpc_id)}`)
      const hostTurn =
        entry.method === 'session/prompt'
          ? [...state.turns.values()].find((t) => t.requestPosition === entry.position)
          : (active ?? [...state.turns.values()].reverse().find((t) => t.session === entry.session))
      const params = object(entry.content.params),
        update = object(params?.update)
      const type = update?.sessionUpdate
      // Whose line it is (docs/specs/log.md, "Native sub-agents"): a sub-agent's when it names its ACP session, or answers a request of its.
      const named = entry.rpc_kind === 'response' || entry.rpc_kind === 'error' ? object(request?.content.params)?.sessionId : params?.sessionId
      const child = (typeof named === 'string' ? state.children.get(named) : undefined) ?? null
      // What a Session's opening replays before its answer gives no object in a sub-stream.
      const replayed = entry.session === null
      if (entry.direction === 'in' && type === 'subagent_update' && typeof update?.sessionId === 'string' && state.children.has(update.sessionId)) {
        const announced = state.children.get(update.sessionId)!
        if (!replayed) putChild(announced)
        continue
      }
      // Among sessions, what one tells another: a sub-agent's task opens its turn; the rest is in each one's own text.
      if (entry.direction === 'in' && type === 'session_message' && (child !== null || [update?.senderSessionId, update?.recipientSessionId].some((id) => typeof id === 'string' && state.children.has(id)))) {
        if (child !== null && !replayed && !child.unlisted && update?.recipientSessionId === child.acpId) {
          putChild(child)
          put(
            'element',
            identity(child.workstream, entry.position, 'prompt'),
            { type: 'user', turn: child.turns.at(-1)?.id, session: entry.session, content: Array.isArray(update.content) ? update.content : [], from: child.parent, as: 'parent' },
            entry.position,
            child.workstream,
          )
        }
        continue
      }
      if (child !== null) {
        if (replayed || child.unlisted) continue
        putChild(child)
        // Its settings, its commands, its usage and its title are no element: its view has its title.
        if (entry.method === 'session/update' && ['config_option_update', 'available_commands_update', 'usage_update', 'session_info_update'].includes(String(type))) continue
      }
      /** Where a line's objects go, and what stands for its Session in their identities: a sub-agent's sub-stream, or the Session. */
      const target = child?.workstream
      const scoped = child?.workstream ?? entry.session ?? entry.execution!
      const turn = child ? child.turns.at(-1) : hostTurn
      if (entry.method === 'session/prompt' && entry.direction === 'out') {
        left(this.waitingElements.get(String(entry.command)), 'sent', entry.position)
        // The user's blocks only: Agora's catch-up is named, not shown (docs/specs/log.md, "Elements").
        const blocks = Array.isArray(params?.prompt) ? (params.prompt as unknown[]) : null
        const catchUp = blocks?.map((b) => object(object(b)?._meta)?.[CATCH_UP_META]).find((m) => m !== undefined)
        // An earlier delegation's report of Agora's (docs/specs/log.md, "Elements").
        const report = blocks?.map((b) => object(object(b)?._meta)?.[REPORT_META]).find((m) => m !== undefined)
        put(
          'element',
          identity(entry.session ?? entry.execution!, entry.position, 'prompt'),
          report !== undefined
            ? {
                type: 'report',
                turn: turn?.id,
                session: entry.session,
                text: (blocks ?? []).map((b) => object(b)).filter((b) => b?.type === 'text').map((b) => String(b!.text)).join('\n'),
                delegates: Array.isArray(object(report)?.delegates) ? object(report)!.delegates : [],
              }
            : {
                type: 'user',
                turn: turn?.id,
                session: entry.session,
                ...said(params?.prompt),
                ...(catchUp !== undefined ? { catchUp } : {}),
              },
          entry.position,
        )
      } else if (
        entry.method === 'session/update' &&
        update &&
        ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(String(type))
      ) {
        const scope = turn?.id ?? scoped
        const discriminator = `${String(type)}:${String(update.messageId ?? '')}`
        let run = runs.get(scope)
        if (!run || run.discriminator !== discriminator) {
          const rank = (ranks.get(scope) ?? 0) + 1
          ranks.set(scope, rank)
          run = { discriminator, id: identity(scope, String(rank), 'chunk') }
          runs.set(scope, run)
        }
        const previous = objects.get(run.id)
        const content = object(update.content)
        const chunks = Array.isArray(previous?.object.chunks) ? previous.object.chunks : []
        put(
          'element',
          run.id,
          {
            type,
            turn: turn?.id,
            session: entry.session,
            chunks: [...chunks, update.content],
            text: String(previous?.object.text ?? '') + (content?.type === 'text' ? String(content.text) : ''),
          },
          entry.position,
          target,
        )
      } else if (
        entry.method === 'session/update' &&
        update &&
        ['tool_call', 'tool_call_update'].includes(String(type)) &&
        typeof update.toolCallId === 'string'
      ) {
        const id = identity(scoped, update.toolCallId, 'tool')
        put(
          'element',
          id,
          { ...objects.get(id)?.object, ...update, type: 'tool', turn: turn?.id, session: entry.session },
          entry.position,
          target,
        )
        if (turn) runs.delete(turn.id)
      } else if (entry.method === 'session/update' && type === 'plan') {
        const scope = turn?.id ?? scoped
        put(
          'element',
          identity(scope, 'plan'),
          { type: 'plan', turn: turn?.id, session: entry.session, entries: update?.entries },
          entry.position,
          target,
        )
        runs.delete(scope)
      } else if (entry.method === 'session/request_permission') {
        put(
          'element',
          identity(scoped, entry.position, 'permission'),
          {
            type: 'permission',
            execution: entry.execution,
            turn: turn?.id,
            session: entry.session,
            requestId: entry.rpc_id,
            requestPosition: entry.position,
            params: entry.content.params,
            status: 'pending',
          },
          entry.position,
          target,
        )
      } else if (
        request?.method === 'session/request_permission' &&
        entry.direction === 'out' &&
        ['response', 'error'].includes(entry.rpc_kind ?? '')
      ) {
        const id = identity(child?.workstream ?? request.session ?? entry.execution!, request.position, 'permission')
        put(
          'element',
          id,
          { ...objects.get(id)?.object, status: 'answered', answer: entry.content.result ?? entry.content.error },
          entry.position,
        )
      } else if ((entry.method ?? entry.correlated_method) === STEERING) {
        // No element of its own. An `injected` answer sets the message in its turn, where the agent's text goes on after it.
        if (entry.direction === 'in' && entry.rpc_kind === 'response' && request && state.answeredBy.get(request.position) === entry.position && object(entry.content.result)?.outcome === 'injected') {
          left(this.waitingElements.get(String(request.command)), 'sent', entry.position)
          put(
            'element',
            identity(request.session ?? entry.execution!, request.position, 'prompt'),
            { type: 'user', steered: true, turn: turn?.id, session: request.session, ...said(object(request.content.params)?.prompt) },
            entry.position,
          )
          if (turn) runs.delete(turn.id)
        }
      } else if (
        !['initialize', 'session/prompt', 'session/new', 'session/resume', 'session/load', 'session/cancel'].includes(
          entry.method ?? entry.correlated_method ?? '',
        )
      ) {
        put(
          'element',
          identity(entry.workstream, entry.position, 'generic'),
          { type: 'acp', session: entry.session, turn: turn?.id, line: entry.content },
          entry.position,
          target,
        )
        if (turn) runs.delete(turn.id)
      }
    }
    return changed
  }
}

/** docs/specs/log.md, "The Workstream view": the first state that applies. */
function workstreamState(execution: Execution | null, session: string | null, opened: boolean): string {
  if (!execution) return 'none'
  if (execution.ended) return 'ended'
  if (execution.failed) return 'failed'
  if (execution.lost) return 'lost'
  if (execution.stopped) return 'stopped'
  // Ready once its opening settings are settled (docs/specs/log.md, "Sessions").
  if (session && execution.connection) return opened ? 'ready' : 'starting'
  if (session) return 'interrupted'
  return 'starting'
}

export function project(entries: readonly Entry[]): ProjectedObject[] {
  const projection = new CoreProjection()
  projection.apply(entries)
  return [...projection.objects.values()].sort((a, b) => a.id.localeCompare(b.id))
}

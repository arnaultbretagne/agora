import { idKey } from './acp.ts'
import { identity, object, schemaValue, encode } from './json.ts'
import { commandsOf, configuring, settingsOf, settled } from './settings.ts'
import type { Entry } from './store.ts'

const OPENING_METHODS = ['session/new', 'session/resume', 'session/load']

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
  /** Its own profiles (docs/specs/credentials.md): its Create's, then its last Scope's. */
  profiles: string[]
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
}
/** The profiles a Create or a Scope recorded. */
function profilesIn(body: unknown): string[] {
  const profiles = object(body)?.profiles
  return Array.isArray(profiles) ? profiles.map(String) : []
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
        profiles: profilesIn(content.body),
      }
      state.executions.set(execution.id, execution)
      state.current = execution
    }
    const execution = entry.execution ? state.executions.get(entry.execution) : undefined
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
    if (entry.kind === 'session.opened' && execution) {
      execution.session = entry.session
      execution.acpId = String(content.acpId)
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
          if (request.method === 'initialize' && entry.rpc_kind === 'response' && execution)
            execution.initialized = true
          // A Session's settings: those its opening answer gives, then each answer to a change.
          if (entry.rpc_kind === 'response' && execution && entry.session) {
            const given = object(content.result)?.configOptions
            if (OPENING_METHODS.includes(request.method ?? '')) {
              execution.settings = Array.isArray(given) ? given : null
              execution.configSent = []
              execution.commands = []
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
          }
        }
      }
    }
    if (entry.kind === 'acp' && entry.direction === 'in' && entry.method === 'session/update' && execution && entry.session === execution.session) {
      const update = object(object(content.params)?.update)
      if (update?.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) execution.settings = update.configOptions
      if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) execution.commands = update.availableCommands
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
  /** The Workstream view's title sources (docs/specs/log.md, "The Workstream view"). */
  private firstWrite: string | null = null
  private agentTitle: string | null = null
  /** The anchor each ended execution names, and the Sessions that have ended. */
  private readonly anchors = new Map<string, string>()
  private readonly endedSessions = new Set<string>()
  /** What the view last showed of the settings, to put it only when that changes. */
  private settingsCode = ''
  apply(entries: readonly Entry[]): Set<string> {
    const changed = new Set<string>()
    const objects = this.objects,
      ranks = this.ranks,
      runs = this.runs
    const put = (kind: ProjectedObject['kind'], id: string, value: Record<string, unknown>, position: string) => {
      const previous = objects.get(id)
      objects.set(id, {
        kind,
        id,
        // Not re-encoded here: a long text would cost its whole size at every chunk. It is encoded
        // once per projection run, when written.
        object: { ...value, id, firstPosition: previous?.first_position ?? position, lastPosition: position },
        first_position: previous?.first_position ?? position,
        last_position: position,
      })
      changed.add(id)
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
        const blocks = Array.isArray(object(entry.content.body)?.prompt) ? (object(entry.content.body)!.prompt as unknown[]) : []
        const text = blocks.map((b) => object(b)).find((b) => b?.type === 'text' && typeof b.text === 'string')?.text as string | undefined
        const line = text?.split('\n').map((l) => l.trim()).find((l) => l !== '')
        if (line) this.firstWrite = line.slice(0, 80)
      }
      if (entry.kind === 'acp' && entry.method === 'session/update') {
        const update = object(object(entry.content.params)?.update)
        if (update?.sessionUpdate === 'session_info_update' && Object.hasOwn(update, 'title')) {
          this.agentTitle = typeof update.title === 'string' && update.title.trim() !== '' ? update.title.trim() : null
          titled = true
        }
      }
      if (entry.kind === 'execution.ended' && entry.execution && typeof entry.content.anchor === 'string') this.anchors.set(entry.execution, entry.content.anchor)
      if (entry.kind === 'session.ended' && entry.session) this.endedSessions.add(entry.session)
      // Settings and commands change with ACP lines too: the view is put when what it shows of them changed.
      const execution0 = state.current
      const settingsCode = execution0
        ? encode({ s: execution0.settings, c: execution0.commands, k: configuring(state, execution0), o: settled(state, execution0) })
        : ''
      const settingsChanged = settingsCode !== this.settingsCode
      this.settingsCode = settingsCode
      if (titled || settingsChanged || entry.kind === 'command' || entry.kind.startsWith('execution.') || entry.kind.startsWith('session.')) {
        const execution = state.current
        const session = execution?.session && !this.endedSessions.has(execution.session) ? execution.session : null
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
            profiles: execution?.profiles ?? [],
            pool: typeof execution?.body.pool === 'string' ? execution.body.pool : null,
            harness: typeof execution?.body.harness === 'string' ? execution.body.harness : null,
            anchor: (execution && this.anchors.get(execution.id)) ?? null,
            changedAt: entry.time,
          },
          entry.position,
        )
      }
      const notice =
        entry.kind === 'session.opened'
          ? { origin: entry.content.origin ?? 'new', harness: entry.content.harness ?? null }
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
      if (entry.kind !== 'acp') continue
      const request =
        entry.rpc_kind === 'request'
          ? entry
          : entry.request_position
            ? state.requestPositions.get(entry.request_position)
            : state.requests.get(`${entry.direction === 'in' ? 'out' : 'in'}:${idKey(entry.rpc_id)}`)
      const turn =
        entry.method === 'session/prompt'
          ? [...state.turns.values()].find((t) => t.requestPosition === entry.position)
          : (active ?? [...state.turns.values()].reverse().find((t) => t.session === entry.session))
      const params = object(entry.content.params),
        update = object(params?.update)
      const type = update?.sessionUpdate
      if (entry.method === 'session/prompt' && entry.direction === 'out') {
        put(
          'element',
          identity(entry.session ?? entry.execution!, entry.position, 'prompt'),
          { type: 'user', turn: turn?.id, session: entry.session, content: params?.prompt },
          entry.position,
        )
      } else if (
        entry.method === 'session/update' &&
        update &&
        ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(String(type))
      ) {
        const scope = turn?.id ?? entry.session ?? entry.execution!
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
        )
      } else if (
        entry.method === 'session/update' &&
        update &&
        ['tool_call', 'tool_call_update'].includes(String(type)) &&
        typeof update.toolCallId === 'string'
      ) {
        const id = identity(entry.session ?? entry.execution!, update.toolCallId, 'tool')
        put(
          'element',
          id,
          { ...objects.get(id)?.object, ...update, type: 'tool', turn: turn?.id, session: entry.session },
          entry.position,
        )
        if (turn) runs.delete(turn.id)
      } else if (entry.method === 'session/update' && type === 'plan') {
        const scope = turn?.id ?? entry.session ?? entry.execution!
        put(
          'element',
          identity(scope, 'plan'),
          { type: 'plan', turn: turn?.id, session: entry.session, entries: update?.entries },
          entry.position,
        )
        runs.delete(scope)
      } else if (entry.method === 'session/request_permission') {
        put(
          'element',
          identity(entry.session ?? entry.execution!, entry.position, 'permission'),
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
        )
      } else if (
        request?.method === 'session/request_permission' &&
        entry.direction === 'out' &&
        ['response', 'error'].includes(entry.rpc_kind ?? '')
      ) {
        const id = identity(request.session ?? entry.execution!, request.position, 'permission')
        put(
          'element',
          id,
          { ...objects.get(id)?.object, status: 'answered', answer: entry.content.result ?? entry.content.error },
          entry.position,
        )
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

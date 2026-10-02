import { idKey } from './acp.ts'
import { identity, object, schemaValue, encode, decode } from './json.ts'
import type { Entry } from './store.ts'

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
  failures: Set<string>
  turns: Map<string, Turn>
  active: Turn | null
  current: Execution | null
  permissions: Map<string, Entry>
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
    failures: new Set(),
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
      }
      state.executions.set(execution.id, execution)
      state.current = execution
    }
    const execution = entry.execution ? state.executions.get(entry.execution) : undefined
    if (entry.kind === 'command' && content.kind === 'Stop' && execution) execution.stopped = true
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
          state.unanswered.delete(request.position)
          if (state.permissions.get(requestKey)?.position === request.position) state.permissions.delete(requestKey)
          if (request.method === 'initialize' && entry.rpc_kind === 'response' && execution)
            execution.initialized = true
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
        object: decode(
          encode({ ...value, id, firstPosition: previous?.first_position ?? position, lastPosition: position }),
        ) as Record<string, unknown>,
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
      if (entry.kind === 'command' || entry.kind.startsWith('execution.') || entry.kind === 'session.opened') {
        const execution = state.current
        put(
          'workstream',
          entry.workstream,
          {
            execution: execution?.id ?? null,
            session: execution?.session ?? null,
            stopped: execution?.stopped ?? false,
            ended: execution?.ended ?? false,
            lost: execution?.lost ?? false,
            ...(execution?.failed ? { failed: true } : {}),
            unavailable:
              execution === null || execution.ended || execution.lost || execution.failed === true || !execution.session || !execution.connection,
            title: 'Workstream',
          },
          entry.position,
        )
      }
      if (
        entry.kind === 'request.failed' ||
        (entry.kind === 'execution.break' && entry.content.clean !== true) ||
        ['execution.lost', 'execution.failed', 'execution.ended'].includes(entry.kind)
      ) {
        put(
          'notice',
          identity(entry.workstream, entry.position, 'notice'),
          {
            type: entry.kind,
            reason: entry.content.reason ?? 'transport_error',
            execution: entry.execution,
            session: entry.session,
          },
          entry.position,
        )
      }
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

export function project(entries: readonly Entry[]): ProjectedObject[] {
  const projection = new CoreProjection()
  projection.apply(entries)
  return [...projection.objects.values()].sort((a, b) => a.id.localeCompare(b.id))
}
/** The external assistant-ui store consumes this mapping, including explicit actions on uncertainty. */
export function runtimeState(objects: readonly ProjectedObject[], snapshotComplete = true) {
  const turns = objects.filter((o) => o.kind === 'turn')
  const active = turns.find((o) => ['saved', 'in_progress', 'uncertain'].includes(String(o.object.status)))
  const view = objects.find((o) => o.kind === 'workstream')?.object
  const reason = !snapshotComplete
    ? 'snapshot_incomplete'
    : view?.stopped
      ? 'stopped'
      : active
        ? String(active.object.status)
        : !view || view.unavailable
          ? 'unavailable'
          : null
  return {
    isRunning: active?.object.status === 'saved' || active?.object.status === 'in_progress',
    isSendDisabled: reason !== null,
    reason,
    cancelTurn: active?.id ?? null,
    canStop: !!view?.execution && !view?.stopped && !view?.ended && !view?.lost,
  }
}

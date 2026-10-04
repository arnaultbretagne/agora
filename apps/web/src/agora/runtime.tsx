// The connection point (docs/specs/assistant-ui.md, "The connection point: useExternalStoreRuntime"):
// the objects become messages, the user's actions become commands, and what the screen offers follows
// the Workstream's state. A refused command shows its reason; its effect, if any, comes from the thread.
//
// Sending with no execution running starts one first (docs/specs/assistant-ui.md, "Sending"): a new
// Workstream is created on its first message, never before; the message waits, shown, until its
// Session is open, then is written.
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Answer, Api, CommandKind, Pool } from './api.ts'
import { useThread, useWorkstreams } from './hooks.ts'
import type { Json, ThreadState } from './objects.ts'
import type { Connection } from './stream.ts'
import {
  accessGranted,
  composerOf,
  firstMessageStep,
  messagesOf,
  poolOffered,
  poolSettings,
  startBody,
  withAccess,
  workstreamOf,
  type AccessEntry,
  type AgentCommand,
  type Composer,
  type Setting,
  type WorkstreamView,
} from './view.ts'

/** A first message waiting for the Session its Create opens. */
export interface Pending {
  readonly workstream: string
  readonly execution: string
  readonly text: string
  readonly harness: string
}

export interface Agora {
  readonly api: Api
  readonly id: string | null
  readonly state: ThreadState
  readonly view: WorkstreamView
  readonly composer: Composer
  readonly connection: Connection
  readonly workstreams: readonly WorkstreamView[]
  readonly pools: readonly Pool[] | null
  /** The pool a new execution starts in. */
  readonly pool: string | null
  readonly pending: Pending | null
  /** The settings the model picker offers: the open Session's, or, when sending starts one, its pool's. */
  readonly settings: readonly Setting[] | null
  /** The values picked for the execution a message will start. */
  readonly chosen: Readonly<Record<string, string>>
  /** The commands `/` lists: the Session's, or its pool's. */
  readonly commands: readonly AgentCommand[]
  /** Picks a setting: kept for the next Create, or sent at once (Configure) to the open Session. */
  chooseSetting(id: string, value: string): void
  /** The profiles the access picker offers (docs/specs/assistant-ui.md, "Access"). */
  readonly offered: readonly string[]
  /** The access shown: picked for the next Create, sent and not yet in the view, or the execution's own. */
  readonly access: readonly string[]
  /** Gives an entry a choice: kept for the next Create, or sent at once (Scope) with the whole set. */
  chooseAccess(entries: readonly AccessEntry[], entry: AccessEntry, profile: string | null): void
  /** The reason of the last command refused, until the next one. */
  readonly refusal: string | null
  /** A message given back to the composer after its execution failed to start. */
  readonly returned: string | null
  choosePool(pool: string): void
  send(kind: CommandKind, target: Json, body: Json): Promise<Answer>
  answer(permission: string, optionId: string): Promise<void>
  open(id: string | null): void
  takeReturned(): void
}

const AgoraContext = createContext<Agora | null>(null)

export function useAgora(): Agora {
  const agora = useContext(AgoraContext)
  if (agora === null) throw new Error('useAgora outside AgoraProvider')
  return agora
}

const REFUSALS: Record<string, string> = {
  turn_active: 'A turn is already running.',
  turn_uncertain: 'The last turn is uncertain: cancel it or stop the execution.',
  permission_pending: 'Answer the permission request first.',
  execution_active: 'An execution is already running.',
  quota: 'Too many sandboxes are running; try again once one has ended.',
  disconnected: 'The sandbox is not connected.',
  stopped: 'The execution is stopped.',
  unreachable: 'The server cannot be reached.',
  unknown_pool: 'This harness is no longer available.',
  profile_not_offered: 'This access is no longer offered.',
  unknown_profile: 'This access is not known.',
  startup: 'The sandbox could not start. Your message is back in the composer.',
}

export const refusalText = (reason: string): string => REFUSALS[reason] ?? `Refused (${reason}).`

const POOL_KEY = 'agora:pool'
const storedPool = (): string | null => {
  try {
    return localStorage.getItem(POOL_KEY)
  } catch {
    return null
  }
}

export function AgoraProvider({ api, id, onOpen, children }: { api: Api; id: string | null; onOpen: (id: string | null) => void; children: ReactNode }) {
  const { workstreams, reload } = useWorkstreams(api)
  const { state, connection } = useThread(api, id)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pools, setPools] = useState<Pool[] | null>(null)
  // The pool picked in this Workstream, or in the draft; a draft starts from the one picked last.
  const [picked, setPicked] = useState<{ for: string | null; pool: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  // Settings picked before a Create, for the Workstream and pool they were picked in.
  const [chosenFor, setChosenFor] = useState<{ for: string | null; pool: string | null; values: Record<string, string> }>({ for: null, pool: null, values: {} })
  const [returned, setReturned] = useState<string | null>(null)
  // The access picked: for the next Create of this Workstream or draft (no execution), or sent to its
  // execution and shown until the view has it.
  const [pickedAccess, setPickedAccess] = useState<{ for: string | null; execution: string | null; profiles: readonly string[] } | null>(null)
  const [offered, setOffered] = useState<string[]>([])
  const view = useMemo(() => workstreamOf(state, id ?? ''), [state, id])
  // A draft has no thread to wait for: sending is offered at once, and starts everything.
  const composer = useMemo<Composer>(
    () => (id === null ? { open: true, create: true, reason: null, running: false, cancellable: null, uncertain: null, pendingPermission: null } : composerOf(state, view)),
    [state, view, id],
  )

  useEffect(() => {
    void api.offered().then(setOffered, () => setOffered([]))
  }, [api])
  // The catalogue, read again on each move: what a draft offers follows the Sessions just opened.
  useEffect(() => {
    void api.pools().then(setPools, () => setPools((p) => p ?? []))
  }, [api, id])
  // The pool offered: the one picked here; else the Workstream's own, so that it continues from its
  // anchor; else, in a draft, the one picked last; else the first.
  const pool = useMemo(
    () => poolOffered(pools ?? [], picked?.for === id ? picked.pool : null, id !== null ? view.pool : null, storedPool()),
    [pools, picked, view.pool, id],
  )
  const choosePool = useCallback(
    (next: string) => {
      setPicked({ for: id, pool: next })
      try {
        localStorage.setItem(POOL_KEY, next)
      } catch {
        // Remembered for this page only.
      }
    },
    [id],
  )
  const harnessOf = useCallback((name: string) => pools?.find((p) => p.name === name)?.harness ?? name, [pools])
  const chosen = useMemo(() => (chosenFor.for === id && chosenFor.pool === pool ? chosenFor.values : {}), [chosenFor, id, pool])
  const settings = useMemo(
    () => (composer.create ? poolSettings(pools?.find((p) => p.name === pool)) : (view.settings ?? null)),
    [composer.create, pools, pool, view.settings],
  )
  const commands = useMemo(
    () => (composer.create ? (pools?.find((p) => p.name === pool)?.commands ?? []) : (view.commands ?? [])),
    [composer.create, pools, pool, view.commands],
  )
  const accessKey = composer.create ? null : view.execution
  const access = useMemo(
    () => accessGranted(pickedAccess !== null && pickedAccess.for === id && pickedAccess.execution === accessKey ? pickedAccess.profiles : null, view),
    [pickedAccess, id, accessKey, view],
  )
  // A Scope shown until the view has it: then the view's own again.
  useEffect(() => {
    if (pickedAccess === null || pickedAccess.execution === null || pickedAccess.execution !== view.execution) return
    const own = view.profiles ?? []
    if (own.length === pickedAccess.profiles.length && own.every((p) => pickedAccess.profiles.includes(p))) setPickedAccess(null)
  }, [pickedAccess, view.execution, view.profiles])

  const send = useCallback(
    async (kind: CommandKind, target: Json, body: Json, workstream: string | null = id): Promise<Answer> => {
      setRefusal(null)
      if (workstream === null) return { accepted: false, reason: 'no_workstream' }
      const answer = await api.command(workstream, kind, target, body)
      if (!answer.accepted) setRefusal(refusalText(answer.reason ?? 'unavailable'))
      reload()
      return answer
    },
    [api, id, reload],
  )

  const answer = useCallback(
    async (permissionId: string, optionId: string) => {
      const permission = state.objects.get(permissionId)?.object
      if (!permission) return
      await send(
        'RespondPermission',
        { execution: permission.execution, session: permission.session, requestPosition: permission.requestPosition },
        { requestId: permission.requestId, outcome: { outcome: 'selected', optionId } },
      )
    },
    [state, send],
  )

  /** A message with no execution running: a Create first, the Write once its Session is open. */
  const start = useCallback(
    async (text: string) => {
      if (pool === null) return setRefusal('No harness is available.')
      let workstream = id
      if (workstream === null) {
        workstream = crypto.randomUUID()
        const created = await api.create(workstream)
        if (!created.accepted) return setRefusal(refusalText(created.reason ?? 'unavailable'))
      }
      const created = await send('Create', {}, startBody(view, pool, id === null, chosen, access), workstream)
      if (!created.accepted || created.execution === undefined) {
        setReturned(text)
        if (id === null) onOpen(workstream)
        return
      }
      setPending({ workstream, execution: created.execution, text, harness: harnessOf(pool) })
      if (id === null) onOpen(workstream)
    },
    [api, id, pool, view, send, onOpen, harnessOf, chosen, access],
  )

  const chooseSetting = useCallback(
    (configId: string, value: string) => {
      if (composer.create) {
        setChosenFor((c) => ({ for: id, pool, values: { ...(c.for === id && c.pool === pool ? c.values : {}), [configId]: value } }))
        return
      }
      void send('Configure', { execution: view.execution, session: view.session }, { configId, value })
    },
    [composer.create, id, pool, send, view.execution, view.session],
  )

  const chooseAccess = useCallback(
    (entries: readonly AccessEntry[], entry: AccessEntry, profile: string | null) => {
      const profiles = withAccess(access, entries, entry, profile)
      setPickedAccess({ for: id, execution: accessKey, profiles })
      if (accessKey === null) return
      void send('Scope', { execution: accessKey }, { profiles }).then((answer) => {
        // Refused: back to what the execution has.
        if (!answer.accepted) setPickedAccess((p) => (p?.profiles === profiles ? null : p))
      })
    },
    [access, id, accessKey, send],
  )

  // The waiting message is written once its execution's Session is open, and given back if it failed.
  const writing = useRef(false)
  useEffect(() => {
    if (pending === null || pending.workstream !== id || writing.current) return
    const step = firstMessageStep(pending.execution, view, state.complete)
    if (step === 'wait') return
    if (step === 'give back') {
      setReturned(pending.text)
      setRefusal(refusalText('startup'))
      setPending(null)
      return
    }
    writing.current = true
    void send('Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text: pending.text }] }).finally(() => {
      writing.current = false
      setPending(null)
    })
  }, [pending, id, state.complete, view, send])

  const messages = useMemo(() => {
    const own = messagesOf(state)
    if (pending === null || pending.workstream !== id) return own
    const custom = { turnStatus: 'pending', harness: pending.harness }
    return [
      ...own,
      { id: 'pending:user', role: 'user', content: [{ type: 'text', text: pending.text }], metadata: { custom } },
      { id: 'pending:assistant', role: 'assistant', content: [], status: { type: 'running' }, metadata: { custom } },
    ] satisfies ThreadMessageLike[]
  }, [state, pending, id])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isRunning: composer.running || (pending !== null && pending.workstream === id),
    isSendDisabled: !composer.open || (pending !== null && pending.workstream === id),
    onNew: async (message) => {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      if (composer.create) return start(text)
      await send('Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text }] })
    },
    onCancel: async () => {
      if (composer.cancellable) await send('Cancel', { execution: view.execution, turn: composer.cancellable.id }, {})
    },
  })

  const open = useCallback(
    (next: string | null) => {
      setRefusal(null)
      onOpen(next)
    },
    [onOpen],
  )
  const takeReturned = useCallback(() => setReturned(null), [])

  const agora: Agora = {
    api,
    id,
    state,
    view,
    composer,
    connection,
    workstreams,
    pools,
    pool,
    pending: pending !== null && pending.workstream === id ? pending : null,
    settings,
    chosen,
    commands,
    chooseSetting,
    offered,
    access,
    chooseAccess,
    refusal,
    returned,
    choosePool,
    send: (kind, target, body) => send(kind, target, body),
    answer,
    open,
    takeReturned,
  }
  return (
    <AgoraContext.Provider value={agora}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </AgoraContext.Provider>
  )
}

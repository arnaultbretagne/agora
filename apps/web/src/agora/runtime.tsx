// The connection point (docs/specs/assistant-ui.md, "The connection point: useExternalStoreRuntime"):
// the objects become messages, the user's actions become commands, and what the screen offers follows
// the Workstream's state. A refused command shows its reason; its effect, if any, comes from the thread.
//
// Sending with no execution running starts one (docs/specs/assistant-ui.md, "Sending"): a new
// Workstream is created on its first message, never before; the Create carries the message, which the
// log holds and sends once its Session is open. The thread shows it from then on.
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type Attachment, type CompleteAttachment, type ThreadMessageLike } from '@assistant-ui/react'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Account, Answer, Api, CommandKind, Config, Pool } from './api.ts'
import { acceptOf, attachmentAdapter, composerAttachments, promptOf, type Block, type PromptCapabilities } from './attachments.ts'
import { useLine, useList, useThread, type ListFeed } from './hooks.ts'
import { registerWorker, tidy } from './push.ts'
import type { Json, ThreadState } from './objects.ts'
import type { Connection } from './stream.ts'
import {
  accessDefault,
  accessGranted,
  approvalAnswer,
  composerOf,
  delegatesOf,
  formFor,
  formOf,
  messagesOf,
  poolOffered,
  poolLimits,
  poolSettings,
  returnedOf,
  startBody,
  startingOf,
  waitingOf,
  withAccess,
  withRole,
  workstreamOf,
  type AccessEntry,
  type AccountLimits,
  type AgentCommand,
  type Composer,
  type FormAnswer,
  type Picks,
  type Role,
  type Setting,
  type ListRow,
  type Waiting,
  type WorkstreamView,
} from './view.ts'

/** A message as the composer holds it: its text and its attachments (docs/specs/assistant-ui.md, "Attachments"). */
export interface Draft {
  readonly text: string
  readonly attachments: readonly CompleteAttachment[]
}

/** A message given back to the composer of its Workstream, or of the draft (`for` null). */
interface Returned extends Draft {
  readonly for: string | null
}

export interface Agora {
  readonly api: Api
  readonly id: string | null
  readonly state: ThreadState
  readonly view: WorkstreamView
  readonly composer: Composer
  readonly connection: Connection
  /** The person's list (docs/specs/assistant-ui.md, "The exchanges"). */
  readonly list: ListFeed
  readonly pools: readonly Pool[] | null
  /** The pool a new execution starts in. */
  readonly pool: string | null
  /** A message waits for the Session of the execution it starts: the thread shows it (docs/specs/assistant-ui.md, "Sending"). */
  readonly starting: boolean
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
  /** Switches an entry on or off: kept for the next Create, or sent at once (Scope) with the whole set. */
  chooseAccess(entry: AccessEntry, on: boolean): void
  /** The roles the role picker offers (docs/specs/assistant-ui.md, "Roles"): none once the Workstream has had an execution. */
  readonly roles: readonly Role[]
  /** The role picked for the Workstream's first Create, or none. */
  readonly role: Role | null
  /** Picks a role by its name, or none: its card's values show where the person picked nothing. */
  chooseRole(role: string | null): void
  /** The reason of the last command refused in this Workstream, until its next one or until it is left. */
  readonly refusal: string | null
  /** What the agent accepts beyond text: the open or last execution's, or, when sending starts one, its pool's. */
  readonly promptCapabilities: PromptCapabilities | null
  /** The limits of the account the pool shown draws from; null before they are read or when it has none. */
  readonly limits: AccountLimits | null
  /** Reads the limits again; the server answers from what it read in the last minutes. */
  refreshLimits(): void
  choosePool(pool: string): void
  send(kind: CommandKind, target: Json, body: Json): Promise<Answer>
  /**
   * What became of the answer the next `resume` gives this form (docs/specs/assistant-ui.md, "Forms"): settled once the
   * log accepts it, rejected with the reason when it refuses it or cannot be reached. assistant-ui's `resume` returns
   * nothing: its outcome is read here.
   */
  answered(form: string): Promise<void>
  open(id: string | null): void
  /** Who the proxy says the person is. */
  readonly account: Account
  /** Cancel, for the open Workstream's turn in progress or uncertain. */
  readonly cancel: () => Promise<void>
  /** The open Workstream's parents, its root first; none for a root (docs/specs/assistant-ui.md, "Header"). */
  readonly line: readonly ListRow[]
  /** The rows of the delegates its lines name, read live (docs/specs/assistant-ui.md, "A tool's line"). */
  readonly delegates: readonly ListRow[]
  /** The messages handed to assistant-ui, which shows them a render later. */
  readonly messages: readonly ThreadMessageLike[]
  /** The messages waiting, oldest first (docs/specs/assistant-ui.md, "Messages during a turn"). */
  readonly waiting: readonly Waiting[]
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
  unknown_role: 'This role is no longer available.',
  role_set: 'This workstream already has its role.',
  prompt_unsupported: 'The agent does not take these attachments.',
  stale_message: 'This message has already gone.',
  invalid_elicitation_content: 'That answer does not fit the question.',
  stale_elicitation: 'This question is no longer waiting.',
  unavailable: 'Agora cannot take it now; try again.',
  startup: 'The sandbox could not start. Your message is back in the composer.',
}

export const refusalText = (reason: string): string => REFUSALS[reason] ?? `Refused (${reason}).`

/** An attachment the adapter has prepared (one given back), not a file still to prepare. */
const complete = (a: Attachment): a is CompleteAttachment => a.status.type === 'complete'

const NO_ROLES: readonly Role[] = []
const NOTHING: Readonly<Record<string, string>> = {}
/** No setting picked, anywhere. */
const UNCHOSEN: { for: string | null; pool: string | null; values: Record<string, string> } = { for: null, pool: null, values: {} }
const POOL_KEY = 'agora:pool'
const storedPool = (): string | null => {
  try {
    return localStorage.getItem(POOL_KEY)
  } catch {
    return null
  }
}

export function AgoraProvider({ api, id, onOpen, children }: { api: Api; id: string | null; onOpen: (id: string | null) => void; children: ReactNode }) {
  // Who the proxy says the person is (docs/specs/assistant-ui.md, "Accounts").
  const [account, setAccount] = useState<Account>({ email: null })
  const list = useList(api)
  const line = useLine(api, id)
  useEffect(() => {
    void api.account().then(setAccount, () => undefined)
  }, [api])
  // docs/specs/notifications.md, "The client": the service worker; at start and each time the client is shown, the
  // notifications whose card is answered closed and the badge set; a notification tapped opens its Workstream here.
  useEffect(() => {
    void registerWorker()
    void tidy(api)
    const shown = () => {
      if (document.visibilityState === 'visible') void tidy(api)
    }
    const opened = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; workstream?: unknown } | null
      if (data?.type === 'agora.open' && typeof data.workstream === 'string' && /^[0-9a-f-]{36}$/.test(data.workstream)) onOpen(data.workstream)
    }
    document.addEventListener('visibilitychange', shown)
    navigator.serviceWorker?.addEventListener('message', opened)
    return () => {
      document.removeEventListener('visibilitychange', shown)
      navigator.serviceWorker?.removeEventListener('message', opened)
    }
  }, [api, onOpen])
  const { state, connection } = useThread(api, id)
  // Its sub-streams' rows, read only once a line names a delegate.
  const delegating = useMemo(() => delegatesOf(state).length > 0, [state])
  const delegates = useList(api, id !== null && delegating, id)
  // The reason of the last command refused, with the Workstream it was sent in: shown only there.
  const [refusal, setRefusal] = useState<{ for: string | null; text: string } | null>(null)
  const refuse = useCallback((text: string, workstream: string | null) => setRefusal({ for: workstream, text }), [])
  const unrefuse = useCallback((workstream: string | null) => setRefusal((r) => (r?.for === workstream ? null : r)), [])
  // The Workstream the composer holds; a file refused is said there.
  const shownFor = useRef(id)
  const [pools, setPools] = useState<Pool[] | null>(null)
  // The pool picked in this Workstream, or in the draft; a draft starts from the one picked last.
  const [picked, setPicked] = useState<{ for: string | null; pool: string } | null>(null)
  // Settings picked before a Create, for the Workstream and pool they were picked in.
  const [chosenFor, setChosenFor] = useState(UNCHOSEN)
  // Put back into their Workstream's composer once that Workstream is shown, oldest first.
  const [returned, setReturned] = useState<readonly Returned[]>([])
  const giveBack = useCallback((message: Returned) => setReturned((r) => [...r, message]), [])
  // The access picked: for the next Create of this Workstream or draft (no execution), or sent to its
  // execution and shown until the view has it.
  const [pickedAccess, setPickedAccess] = useState<{ for: string | null; execution: string | null; profiles: readonly string[] } | null>(null)
  // The role picked for the first Create of this Workstream, or of the draft: never kept from one draft to the next.
  const [pickedRole, setPickedRole] = useState<{ for: string | null; role: string } | null>(null)
  // What Agora offers, read once the page opens: the access picker's profiles, and the roles.
  const [{ offered, roles: cards }, setConfig] = useState<Config>({ offered: [], roles: [] })
  const view = useMemo(() => workstreamOf(state, id ?? ''), [state, id])
  // A draft has no thread to wait for: sending is offered at once, and starts everything.
  const composer = useMemo<Composer>(() => {
    if (id === null) return { open: true, create: true, reason: null, running: false, cancellable: null, uncertain: null, pendingPermission: null, refuses: false, held: false, readOnly: false }
    return composerOf(state, view)
  }, [state, view, id])

  useEffect(() => {
    void api.config().then(setConfig, () => undefined)
  }, [api])
  // The catalogue, read again on each move: what a draft offers follows the Sessions just opened.
  useEffect(() => {
    void api.pools().then(setPools, () => setPools((p) => p ?? []))
  }, [api, id])
  // A role (docs/specs/assistant-ui.md, "Roles"): offered before the Workstream's first execution, and kept by it.
  const roles = composer.create && view.execution === null ? cards : NO_ROLES
  const role = useMemo(() => (pickedRole?.for === id ? (roles.find((r) => r.role === pickedRole.role) ?? null) : null), [pickedRole, id, roles])
  const chooseRole = useCallback((next: string | null) => setPickedRole(next === null ? null : { for: id, role: next }), [id])
  const accessKey = composer.create ? null : view.execution
  // What the person picked here themselves, then with the role's card under it: its values only where they picked nothing.
  const begin = useMemo(() => {
    const own: Picks = {
      pool: picked?.for === id ? picked.pool : null,
      settings: chosenFor.for === id && Object.keys(chosenFor.values).length > 0 ? chosenFor : null,
      access: pickedAccess !== null && pickedAccess.for === id && pickedAccess.execution === accessKey ? pickedAccess.profiles : null,
    }
    // The draft's own pool: the Workstream's, or one of its harness, so that it continues; else, in a draft, the one picked last; else the first.
    const start = poolOffered(pools ?? [], null, id !== null ? view.pool : null, storedPool(), id !== null ? view.harness : null)
    return { ...withRole(role, own, pools ?? [], offered, start), start }
  }, [role, picked, chosenFor, pickedAccess, accessKey, pools, offered, view.pool, view.harness, id])
  // The pool offered: the one picked here, or the role's; else the draft's own.
  const pool = begin.pool ?? begin.start
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
  // The accounts' limits: read once the page opens, again when they are looked at.
  const [accounts, setAccounts] = useState<Record<string, AccountLimits> | null>(null)
  const refreshLimits = useCallback(() => {
    void api.limits().then(setAccounts, () => setAccounts((a) => a ?? {}))
  }, [api])
  useEffect(refreshLimits, [refreshLimits])
  const limits = useMemo(() => poolLimits(pools?.find((p) => p.name === pool)?.baseProfiles, accounts), [pools, pool, accounts])
  // Picked for the execution a message will start: an open Session shows its own.
  const chosen = useMemo(() => (composer.create && begin.settings !== null && begin.settings.pool === pool ? begin.settings.values : NOTHING), [composer.create, begin.settings, pool])
  const settings = useMemo(
    () => (composer.create ? poolSettings(pools?.find((p) => p.name === pool)) : (view.settings ?? null)),
    [composer.create, pools, pool, view.settings],
  )
  const promptCapabilities = useMemo(
    () => (composer.create ? (pools?.find((p) => p.name === pool)?.promptCapabilities ?? null) : (view.promptCapabilities ?? null)),
    [composer.create, pools, pool, view.promptCapabilities],
  )
  // A file the agent cannot take is said at once, above the composer, and not attached.
  const attachments = useMemo(
    () =>
      promptCapabilities !== null && acceptOf(promptCapabilities) !== null
        ? attachmentAdapter(promptCapabilities, (name, why) => refuse(`${name} can't be attached: ${why}.`, shownFor.current))
        : undefined,
    // Kept while what the agent accepts stays the same: the composer's attachments are counted in it.
    [promptCapabilities?.image, promptCapabilities?.embeddedContext],
  )
  const commands = useMemo(
    () => (composer.create ? (pools?.find((p) => p.name === pool)?.commands ?? []) : (view.commands ?? [])),
    [composer.create, pools, pool, view.commands],
  )
  // Before any execution, the Internet when it is offered, and what a role's card adds.
  const access = useMemo(() => accessGranted(begin.access, view, accessDefault(offered)), [begin.access, view, offered])
  // A Scope shown until the view has it: then the view's own again.
  useEffect(() => {
    if (pickedAccess === null || pickedAccess.execution === null || pickedAccess.execution !== view.execution) return
    const own = view.profiles ?? []
    if (own.length === pickedAccess.profiles.length && own.every((p) => pickedAccess.profiles.includes(p))) setPickedAccess(null)
  }, [pickedAccess, view.execution, view.profiles])

  const send = useCallback(
    // `shown`: the Workstream on screen when the command goes to another — a native sub-stream's go to its host.
    async (kind: CommandKind, target: Json, body: Json, workstream: string | null = id, shown: string | null = workstream): Promise<Answer> => {
      unrefuse(shown)
      if (workstream === null) return { accepted: false, reason: 'no_workstream' }
      const answer = await api.command(workstream, kind, target, body)
      if (!answer.accepted) refuse(refusalText(answer.reason ?? 'unavailable'), shown)
      return answer
    },
    [api, id, refuse, unrefuse],
  )

  /**
   * A form answered (docs/specs/assistant-ui.md, "Forms"): RespondElicitation, accepted with its content or declined; a
   * native sub-stream's sent to its host.
   */
  const respondForm = useCallback(
    async (elementId: string, given: FormAnswer) => {
      const form = state.objects.get(elementId)?.object
      if (!form) throw new Error(refusalText('stale_elicitation'))
      const sent = await send(
        'RespondElicitation',
        { execution: form.execution, session: form.session, requestPosition: form.requestPosition },
        { requestId: form.requestId, ...given },
        view.native?.host ?? id,
        id,
      )
      // Refused or never delivered: the form waits still, and its box gives its controls back (docs/specs/assistant-ui.md, "Forms").
      if (!sent.accepted) throw new Error(refusalText(sent.reason ?? 'unavailable'))
    },
    [state, send, view.native, id],
  )
  /** The outcome of each form's answer given by `resume`, waited for by its box. */
  const outcomes = useRef(new Map<string, { resolve: () => void; reject: (error: Error) => void }>())
  const answered = useCallback((form: string) => new Promise<void>((resolve, reject) => void outcomes.current.set(form, { resolve, reject })), [])

  /**
   * An approval answered from its card (docs/specs/assistant-ui.md, "Answering"): assistant-ui's `respondToApproval` checks
   * it against the part's approval and hands it here. A permission goes to its agent; a form of one option or one text,
   * as its content; a question of Agora's — an approval, a merge card, a question with its note as the answer's text —
   * to the log.
   */
  const answer = useCallback(
    async ({ approvalId, approved, optionId, text }: { approvalId: string; approved: boolean; optionId?: string; text?: string }) => {
      const permission = state.objects.get(approvalId)
      if (permission?.object.type === 'elicitation') {
        await respondForm(approvalId, approvalAnswer(formOf(permission), { approved, ...(optionId !== undefined ? { optionId } : {}), ...(text !== undefined ? { text } : {}) }))
        return
      }
      if (!permission || optionId === undefined) return
      // A question to the person is answered to the log, not to an agent (docs/specs/log.md, "Commands").
      if (permission.object.type === 'question') {
        await send('Answer', { question: permission.object.position }, { optionId, ...(text ? { note: text } : {}) })
        return
      }
      // A native sub-stream's permission is answered through its host (docs/specs/log.md, "Native sub-agents").
      await send(
        'RespondPermission',
        { execution: permission.object.execution, session: permission.object.session, requestPosition: permission.object.requestPosition },
        { requestId: permission.object.requestId, outcome: { outcome: 'selected', optionId } },
        view.native?.host ?? id,
        id,
      )
    },
    [state, send, respondForm, view.native, id],
  )

  /** A form answered by its part's `resume` (docs/specs/assistant-ui.md, "Forms"): the tool call it names gives the form. */
  const resume = useCallback(
    ({ toolCallId, payload }: { toolCallId: string; payload: unknown }) => {
      const form = formFor(state, toolCallId)
      const given = payload as FormAnswer
      const outcome = form === null ? undefined : outcomes.current.get(form.id)
      if (form !== null) outcomes.current.delete(form.id)
      if (form === null || (given.action !== 'accept' && given.action !== 'decline')) {
        outcome?.reject(new Error(refusalText('stale_elicitation')))
        return
      }
      respondForm(form.id, given).then(
        () => outcome?.resolve(),
        (error: unknown) => outcome?.reject(error instanceof Error ? error : new Error(String(error))),
      )
    },
    [state, respondForm],
  )

  /** Cancel, for the turn in progress or uncertain: a native sub-stream's goes through its host, with that turn's execution. */
  const cancel = useCallback(async () => {
    const turn = composer.cancellable
    if (turn === null) return
    await send('Cancel', { execution: view.native ? turn.object.execution : view.execution, turn: turn.id }, {}, view.native?.host ?? id, id)
  }, [composer.cancellable, send, view.native, view.execution, id])

  /** A message with no execution running: a Create carrying it; the log sends it once its Session is open. */
  const start = useCallback(
    async (draft: Draft, prompt: readonly Block[]) => {
      if (pool === null) return refuse('No harness is available.', id)
      let workstream = id
      if (workstream === null) {
        workstream = crypto.randomUUID()
        const created = await api.create(workstream)
        if (!created.accepted) {
          refuse(refusalText(created.reason ?? 'unavailable'), id)
          return giveBack({ ...draft, for: id })
        }
      }
      const created = await send('Create', {}, { ...startBody(pool, chosen, access, role?.role ?? null), prompt: [...prompt] }, workstream)
      if (!created.accepted) giveBack({ ...draft, for: workstream })
      if (id !== null) return
      // The draft is this Workstream from here on. A refused Create is sent again as it was: what was picked goes
      // with it. Accepted, the harness, the model and the access picked stay the next draft's, as before; a role
      // is never kept from one draft to the next.
      const moved = <P extends { for: string | null }>(pick: P | null): P | null => (pick === null || pick.for !== null || created.accepted ? pick : { ...pick, for: workstream })
      setPicked(moved)
      setChosenFor((c) => moved(c) ?? UNCHOSEN)
      setPickedAccess(moved)
      setPickedRole((r) => (r === null || r.for !== null ? r : created.accepted ? null : { ...r, for: workstream }))
      onOpen(workstream)
    },
    [api, id, pool, send, onOpen, chosen, access, role, refuse, giveBack],
  )

  const chooseSetting = useCallback(
    (configId: string, value: string) => {
      if (composer.create) {
        // With what shows beside it, a role's included: the picker stays as the person left it.
        setChosenFor({ for: id, pool, values: { ...chosen, [configId]: value } })
        return
      }
      void send('Configure', { execution: view.execution, session: view.session }, { configId, value })
    },
    [composer.create, id, pool, chosen, send, view.execution, view.session],
  )

  const chooseAccess = useCallback(
    (entry: AccessEntry, on: boolean) => {
      const profiles = withAccess(access, offered, entry, on)
      setPickedAccess({ for: id, execution: accessKey, profiles })
      if (accessKey === null) return
      void send('Scope', { execution: accessKey }, { profiles }).then((answer) => {
        // Refused: back to what the execution has.
        if (!answer.accepted) setPickedAccess((p) => (p?.profiles === profiles ? null : p))
      })
    },
    [access, offered, id, accessKey, send],
  )

  // The messages the log gave back, their execution not having started (docs/specs/assistant-ui.md,
  // "Sending"): into this Workstream's composer with the reason, once per page.
  const handed = useRef(new Set<string>())
  useEffect(() => {
    if (id === null || !state.complete) return
    const back = returnedOf(state, view).filter((m) => !handed.current.has(m.id))
    if (back.length === 0) return
    for (const m of back) handed.current.add(m.id)
    refuse(refusalText('startup'), id)
    void (async () => {
      // An image the log keeps in R2 is read again; one that cannot be read comes back without it.
      for (const m of back) giveBack({ text: m.text, attachments: await composerAttachments(m.blocks).catch(() => []), for: id })
    })()
  }, [state, view, id, refuse, giveBack])

  const starting = useMemo(() => startingOf(state, view).length > 0, [state, view])
  const messages = useMemo(() => messagesOf(state, view), [state, view])

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      const draft = { text, attachments: message.attachments ?? [] }
      const prompt = promptOf(text, draft.attachments)
      attachments?.sent()
      if (composer.create) return start(draft, prompt)
      // During a turn it waits; refused, it comes back to the composer.
      const written = await send('Write', { execution: view.execution, session: view.session }, { prompt, mayWait: true })
      if (!written.accepted) giveBack({ ...draft, for: id })
    },
    [attachments, composer.create, start, send, id, view.execution, view.session, giveBack],
  )

  const waiting = useMemo(() => waitingOf(state, view), [state, view])
  // The log holds the messages (docs/specs/assistant-ui.md, "The connection point"): this lists them, sends and takes one back.
  const queue = useMemo(
    () => ({
      items: waiting.map((w) => ({ id: w.id, prompt: w.text, parts: [{ type: 'text' as const, text: w.text }] })),
      steerItems: [],
      enqueue: (message: AppendMessage) => void onNew(message),
      steer: (message: AppendMessage) => {
        void onNew(message)
        // assistant-ui keeps a message with attachments as a row of the thread until the thread shows it, or its send
        // rejects. Waiting, it has its place in the list: this takes it out of the thread.
        if (message.attachments?.length) throw new Error('waiting')
      },
      move: () => {},
      edit: () => {},
      remove: (item: string) => {
        const message = waiting.find((w) => w.id === item)
        if (message) void send('Retract', { message: message.position }, {})
      },
    }),
    [waiting, onNew, send],
  )

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    // While an approval waits, Send in place of Cancel: what is sent refuses it.
    isRunning: (composer.running && !composer.refuses) || starting,
    isSendDisabled: !composer.open,
    onNew,
    queue,
    adapters: { attachments },
    onCancel: cancel,
    onRespondToToolApproval: answer,
    onResumeToolCall: resume,
  })

  // A text typed and not sent stays with its Workstream, or the draft, its attachments with it
  // (docs/specs/assistant-ui.md, "Sending"): the composer is one for all of them, so moving puts this
  // one's away and shows the other's. Its text at once, before the screen is painted; its attachments
  // once the runtime has the Workstream's adapter — known with its view —, through which they are added
  // again; still waiting when the person moves on, they stay with it.
  const drafts = useRef(new Map<string | null, { text: string; attachments: readonly Attachment[] }>())
  const toRestore = useRef<readonly Attachment[]>([])
  useLayoutEffect(() => {
    if (shownFor.current === id) return
    const input = runtime.thread.composer
    const { text, attachments: held } = input.getState()
    drafts.current.set(shownFor.current, { text, attachments: [...held, ...toRestore.current] })
    shownFor.current = id
    const kept = drafts.current.get(id)
    drafts.current.delete(id)
    input.setText(kept?.text ?? '')
    // Emptied at once, a file still being prepared cancelled; what the adapter is told comes after.
    void input.clearAttachments().catch(() => {})
    toRestore.current = kept?.attachments ?? []
  }, [id, runtime])
  useEffect(() => {
    const restoring = toRestore.current
    if (restoring.length === 0 || attachments === undefined) return
    toRestore.current = []
    const input = runtime.thread.composer
    for (const a of restoring)
      void input.addAttachment(complete(a) ? { id: a.id, type: a.type, name: a.name, contentType: a.contentType, content: a.content } : a.file).catch(() => {})
  }, [id, runtime, attachments])
  // The messages given back: into their Workstream's composer, once that one is shown; several, one
  // after the other.
  useEffect(() => {
    const mine = returned.filter((r) => r.for === id)
    if (mine.length === 0) return
    const input = runtime.thread.composer
    input.setText(mine.map((r) => r.text).filter((t) => t !== '').join('\n\n'))
    for (const a of mine.flatMap((r) => r.attachments)) void input.addAttachment({ id: a.id, type: a.type, name: a.name, contentType: a.contentType, content: a.content }).catch(() => {})
    setReturned((r) => r.filter((m) => !mine.includes(m)))
  }, [returned, id, runtime])

  const open = useCallback(
    (next: string | null) => {
      // The reason said here goes with it; one said for another Workstream waits there.
      unrefuse(id)
      onOpen(next)
    },
    [onOpen, unrefuse, id],
  )

  const agora: Agora = {
    api,
    id,
    state,
    view,
    composer,
    connection,
    list,
    pools,
    pool,
    starting,
    settings,
    chosen,
    commands,
    chooseSetting,
    offered,
    access,
    chooseAccess,
    roles,
    role,
    chooseRole,
    refusal: refusal?.for === id ? refusal.text : null,
    promptCapabilities,
    limits,
    refreshLimits,
    choosePool,
    send: (kind, target, body) => send(kind, target, body),
    answered,
    cancel,
    open,
    account,
    line,
    delegates: delegates.rows,
    messages,
    waiting,
  }
  return (
    <AgoraContext.Provider value={agora}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </AgoraContext.Provider>
  )
}

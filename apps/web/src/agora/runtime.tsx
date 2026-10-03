// The connection point (docs/specs/assistant-ui.md, "The connection point: useExternalStoreRuntime"):
// the objects become messages, the user's actions become commands, and what the screen offers follows
// the Workstream's state. A refused command shows its reason; its effect, if any, comes from the thread.
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Answer, Api, CommandKind } from './api.ts'
import { useThread, useWorkstreams } from './hooks.ts'
import type { Json, ThreadState } from './objects.ts'
import type { Connection } from './stream.ts'
import { composerOf, messagesOf, workstreamOf, type Composer, type WorkstreamView } from './view.ts'

export interface Agora {
  readonly api: Api
  readonly id: string | null
  readonly state: ThreadState
  readonly view: WorkstreamView
  readonly composer: Composer
  readonly connection: Connection
  readonly workstreams: readonly WorkstreamView[]
  /** The reason of the last command refused, until the next one. */
  readonly refusal: string | null
  send(kind: CommandKind, target: Json, body: Json): Promise<Answer>
  open(id: string): void
  create(): Promise<void>
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
  quota: 'Too many executions are running; try again once one has ended.',
  disconnected: 'The sandbox is not connected.',
  stopped: 'The execution is stopped.',
  unreachable: 'The server cannot be reached.',
}

export const refusalText = (reason: string): string => REFUSALS[reason] ?? `Refused (${reason}).`

export function AgoraProvider({ api, id, onOpen, children }: { api: Api; id: string | null; onOpen: (id: string) => void; children: ReactNode }) {
  const { workstreams, loading, reload } = useWorkstreams(api)
  const { state, connection } = useThread(api, id)
  const [refusal, setRefusal] = useState<string | null>(null)
  const view = useMemo(() => workstreamOf(state, id ?? ''), [state, id])
  const composer = useMemo(() => composerOf(state, view), [state, view])
  const messages = useMemo(() => messagesOf(state), [state])

  const send = useCallback(
    async (kind: CommandKind, target: Json, body: Json): Promise<Answer> => {
      setRefusal(null)
      if (id === null) return { accepted: false, reason: 'no_workstream' }
      const answer = await api.command(id, kind, target, body)
      if (!answer.accepted) setRefusal(refusalText(answer.reason ?? 'unavailable'))
      reload()
      return answer
    },
    [api, id, reload],
  )

  const create = useCallback(async () => {
    const workstream = crypto.randomUUID()
    const answer = await api.create(workstream)
    if (!answer.accepted) return setRefusal(refusalText(answer.reason ?? 'unavailable'))
    reload()
    onOpen(workstream)
  }, [api, onOpen, reload])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isRunning: composer.running,
    isSendDisabled: !composer.open,
    isDisabled: view.state === 'none' || view.state === 'ended',
    onNew: async (message) => {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      await send('Write', { execution: view.execution, session: view.session }, { prompt: [{ type: 'text', text }] })
    },
    onCancel: async () => {
      if (composer.cancellable) await send('Cancel', { execution: view.execution, turn: composer.cancellable.id }, {})
    },
    onRespondToToolApproval: async ({ approvalId, optionId, approved }) => {
      const permission = state.objects.get(approvalId)?.object
      if (!permission) return
      const options = ((permission.params as Json | undefined)?.options ?? []) as Json[]
      // Without an option chosen, the first of the kind the answer means.
      const chosen = optionId ?? String(options.find((o) => String(o.kind).startsWith(approved ? 'allow' : 'reject'))?.optionId ?? '')
      await send(
        'RespondPermission',
        { execution: permission.execution, session: permission.session, requestPosition: permission.requestPosition },
        { requestId: permission.requestId, outcome: { outcome: 'selected', optionId: chosen } },
      )
    },
    adapters: {
      threadList: {
        threadId: id ?? undefined,
        isLoading: loading,
        threads: workstreams.map((w) => ({ id: w.id, status: 'regular' as const, title: w.title, custom: { state: w.state, harness: w.harness } })),
        onSwitchToThread: (threadId) => {
          setRefusal(null)
          onOpen(threadId)
        },
        onSwitchToNewThread: () => void create(),
      },
    },
  })

  const agora: Agora = { api, id, state, view, composer, connection, workstreams, refusal, send, open: onOpen, create }
  return (
    <AgoraContext.Provider value={agora}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </AgoraContext.Provider>
  )
}

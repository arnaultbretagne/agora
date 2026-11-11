// In place of apps/web/src/agora/runtime.tsx for this static page (the build resolves the components' import
// of it here): the same `useAgora`, answered from fixed data, and assistant-ui's external store runtime over
// fixed messages, as the client builds it. Nothing is sent anywhere: every action is a no-op.
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { createContext, useContext, type ReactNode } from 'react'
import { Api } from '@/agora/api.ts'
import { empty, type ThreadState } from '@/agora/objects.ts'
import type { ListRow, WorkstreamView } from '@/agora/view.ts'

export interface Fixed {
  readonly id: string | null
  readonly state: ThreadState
  readonly view: WorkstreamView
  readonly messages: readonly ThreadMessageLike[]
  /** The open Workstream's parents, its root first (the header's line). */
  readonly line: readonly ListRow[]
  /** The rows the thread's delegate lines read. */
  readonly delegates: readonly ListRow[]
}

const noop = async () => ({ accepted: false, reason: 'static page' })
const api = new Api('', (async () => new Response('{}', { status: 404 })) as typeof fetch)

const Context = createContext<Fixed | null>(null)

export function useAgora() {
  const fixed = useContext(Context)
  if (fixed === null) throw new Error('useAgora outside StandIn')
  return {
    api,
    ...fixed,
    composer: { open: false, running: false, reason: 'static page' },
    connection: 'connected' as const,
    pending: null,
    open: () => undefined,
    send: noop,
    answer: async () => undefined,
    account: { email: null },
    waiting: [],
  }
}

export function StandIn({ value, children }: { value: Fixed; children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: value.messages,
    convertMessage: (message) => message,
    isRunning: false,
    onNew: async () => undefined,
  })
  return (
    <Context.Provider value={value}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </Context.Provider>
  )
}

export const emptyState = empty

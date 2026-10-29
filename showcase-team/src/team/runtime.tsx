// An ExternalStoreRuntime fed from in-memory messages: the moment of the run being shown, plus
// whatever the person types (no lead is behind this page).
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AuiConfig,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

type Props = {
  messages: readonly ThreadMessageLike[]
  isRunning: boolean
  config?: AuiConfig
  onAnswer?: (approvalId: string, optionId: string | undefined, approved: boolean) => void
  children: ReactNode
}

export function StaticRuntime({ messages, isRunning, config, onAnswer, children }: Props) {
  const [typed, setTyped] = useState<ThreadMessageLike[]>([])
  const all = useMemo(() => [...messages, ...typed], [messages, typed])
  const onNew = useCallback(async (message: { content: readonly { type: string; text?: string }[] }) => {
    const text = message.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    const n = Date.now()
    setTyped((list) => [
      ...list,
      { role: 'user', id: `typed-${n}`, content: [{ type: 'text', text }] },
      { role: 'assistant', id: `typed-${n}-reply`, content: [{ type: 'text', text: 'This page replays a finished run: no lead is listening.' }] },
    ])
  }, [])
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: all,
    isRunning,
    convertMessage: (m) => m,
    onNew,
    ...(onAnswer && {
      onRespondToToolApproval: ({ approvalId, optionId, approved }) => onAnswer(approvalId, optionId, approved),
    }),
  })
  return (
    <AssistantRuntimeProvider runtime={runtime} {...(config && { config })}>
      {children}
    </AssistantRuntimeProvider>
  )
}

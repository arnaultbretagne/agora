// A thread frozen in one state: assistant-ui's own Thread over an ExternalStoreRuntime that holds
// fixed messages and answers nothing. The page's CSS hides the composer (.frozen), nothing else.
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AuiConfig, type ThreadMessageLike } from '@assistant-ui/react'
import type { ReactNode } from 'react'
import { TaskGroup } from '@/components/assistant-ui/elements/task-card.aui'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'

const noop = async () => {}

export function FrozenRuntime({ messages, running = false, config, children }: { messages: readonly ThreadMessageLike[]; running?: boolean; config?: AuiConfig; children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: running,
    convertMessage: (m) => m,
    onNew: noop,
    onRespondToToolApproval: noop,
  })
  return <AssistantRuntimeProvider runtime={runtime} {...(config && { config })}>{children}</AssistantRuntimeProvider>
}

/** `lanes`: Thread with its `components.TaskGroup` slot set, as the Task card's docs say. */
export function FrozenThread({ messages, running = false, lanes = false, config }: { messages: readonly ThreadMessageLike[]; running?: boolean; lanes?: boolean; config?: AuiConfig }) {
  return (
    <FrozenRuntime messages={messages} running={running} {...(config && { config })}>
      <div className="frozen">
        <Thread components={lanes ? { TaskGroup } : {}} />
      </div>
    </FrozenRuntime>
  )
}

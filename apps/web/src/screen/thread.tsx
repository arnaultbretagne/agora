// The thread (docs/specs/assistant-ui.md, "The screen"), as assistant-ui's base skin lays it out: a
// column of 42rem; a draft greets with the brand and the composer in the middle; a Workstream scrolls
// its messages above a composer that stays at the bottom.
import { ThreadPrimitive } from '@assistant-ui/react'
import { ArrowDownIcon } from 'lucide-react'
import type { FC } from 'react'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { BrandMark } from './brand.tsx'
import { Composer } from './composer.tsx'
import { AssistantMessage, Notice, UserMessage } from './messages.tsx'

const Greeting: FC = () => (
  <div className="animate-in fade-in slide-in-from-bottom-1 mx-auto mb-8 flex w-full max-w-(--thread-max-width) flex-col items-center gap-4 text-center duration-200">
    <BrandMark className="size-11" />
    <p className="font-brand text-[2rem] leading-tight tracking-[-0.6px]">What shall we work on?</p>
  </div>
)

export const Thread: FC = () => {
  const { id, state } = useAgora()
  const draft = id === null
  const loading = !draft && !state.complete && state.objects.size === 0
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col" style={{ ['--thread-max-width' as string]: '42rem' }}>
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        className={cn('relative flex flex-1 flex-col overflow-y-auto px-4 pt-6 [scrollbar-gutter:stable_both-edges] md:px-6', draft && 'justify-center')}
      >
        {draft && <Greeting />}
        {loading && <p className="text-muted-foreground mx-auto mt-8 font-mono text-[12px]">loading…</p>}
        <div className="mb-12 flex flex-col gap-y-6 empty:hidden">
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserMessage /> : message.role === 'assistant' ? <AssistantMessage /> : <Notice />)}
          </ThreadPrimitive.Messages>
        </div>
        <ThreadPrimitive.ViewportFooter className={cn('bg-background mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-3 overflow-visible pb-5', !draft && 'sticky bottom-0 mt-auto')}>
          <ThreadPrimitive.ScrollToBottom asChild>
            <button
              type="button"
              aria-label="Scroll to the bottom"
              className="border-foreground/10 bg-background hover:border-foreground/25 rounded-control absolute -top-11 z-10 grid size-8 place-items-center self-center border transition-colors disabled:invisible"
            >
              <ArrowDownIcon className="size-4" />
            </button>
          </ThreadPrimitive.ScrollToBottom>
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

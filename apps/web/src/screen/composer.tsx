// The composer (docs/specs/assistant-ui.md, "Sending"), in assistant-ui's base skin: one bordered
// field, the harness picker inside it where their model picker sits, Send on the right, or Cancel
// while the agent works. Above it, what the user must know before sending: a refusal, an uncertain
// turn, why sending waits.
import { AuiIf, ComposerPrimitive, useAui } from '@assistant-ui/react'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, type FC } from 'react'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { harnessName } from '../agora/view.ts'

const menuContentClass =
  'bg-popover text-popover-foreground border-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 rounded-surface z-50 min-w-56 overflow-hidden border p-1'
const menuItemClass =
  'hover:bg-muted focus:bg-muted flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none select-none'
const quietButton = 'text-muted-foreground hover:text-foreground rounded-control h-7 px-2 text-[13px] transition-colors'

/** The harness a new execution starts with; the running one, as a plain label, once started. */
const HarnessPicker: FC = () => {
  const { pools, pool, choosePool, composer, view } = useAgora()
  const current = pools?.find((p) => p.name === pool)
  if (!composer.create) return view.harness ? <span className="text-muted-foreground px-2 text-[13px]">{harnessName(view.harness)}</span> : null
  if (pools === null) return <span className="text-muted-foreground px-2 text-[13px]">…</span>
  if (pools.length === 0) return <span className="text-destructive px-2 text-[13px]">No harness available</span>
  const continues = (name: string) => view.state === 'ended' && view.anchor !== null && view.pool === name
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="Harness" className={cn(quietButton, 'flex items-center gap-1')}>
          {harnessName(current?.harness)}
          <ChevronDownIcon className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className={menuContentClass}>
          {pools.map((p) => (
            <DropdownMenu.Item key={p.name} className={menuItemClass} onSelect={() => choosePool(p.name)}>
              <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', p.name === pool ? 'opacity-100' : 'opacity-0')} />
              <span className="flex flex-col">
                <span>{harnessName(p.harness)}</span>
                <span className="text-muted-foreground text-[12px]">
                  {continues(p.name) ? 'continues the last session' : p.readyReplicas > 0 ? 'ready at once' : 'starts in a few seconds'}
                </span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** What stands between the user and sending, said above the field. */
const Notes: FC = () => {
  const { refusal, composer, view, send, pending } = useAgora()
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {refusal && (
        <p role="alert" className="border-destructive/60 text-destructive border-l-2 pl-3 text-[13px]">
          {refusal}
        </p>
      )}
      {composer.uncertain ? (
        <div className="border-warning flex flex-wrap items-center gap-2 border-l-2 pl-3 text-[13px]">
          <span className="flex-1">The end of the last turn could not be confirmed. It is never sent again.</span>
          <button type="button" className={quietButton} onClick={() => void send('Cancel', { execution: view.execution, turn: composer.uncertain!.id }, {})}>
            Cancel the turn
          </button>
          <button type="button" className={quietButton} onClick={() => void send('Stop', { execution: view.execution }, {})}>
            Stop the sandbox
          </button>
        </div>
      ) : (
        composer.reason !== null && pending === null && <p className="text-muted-foreground border-foreground/15 border-l-2 pl-3 text-[13px]">{composer.reason}</p>
      )}
    </div>
  )
}

export const Composer: FC<{ placeholder?: string }> = ({ placeholder }) => {
  const aui = useAui()
  const { returned, takeReturned, pending, composer } = useAgora()
  // A message whose execution failed to start comes back here, to be sent again.
  useEffect(() => {
    if (returned === null) return
    aui.composer().setText(returned)
    takeReturned()
  }, [returned, aui, takeReturned])
  return (
    <div className="flex w-full flex-col gap-3">
      <Notes />
      <ComposerPrimitive.Root className="border-foreground/10 bg-muted/30 focus-within:border-foreground/25 rounded-thread flex w-full flex-col border transition-colors">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder={placeholder ?? (composer.create ? 'Describe the task…' : 'Write to the agent…')}
          className="placeholder:text-muted-foreground field-sizing-content max-h-48 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-2 text-base leading-6 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            <HarnessPicker />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {pending ? (
              <span className="bg-primary/60 text-primary-foreground rounded-control grid size-7 place-items-center" aria-label="Starting">
                <LoaderCircleIcon className="size-4 animate-spin" />
              </span>
            ) : (
              <>
                <AuiIf condition={(s) => !s.thread.isRunning}>
                  <ComposerPrimitive.Send
                    aria-label="Send"
                    className="bg-primary text-primary-foreground rounded-control grid size-7 place-items-center transition-opacity disabled:opacity-40"
                  >
                    <ArrowUpIcon className="size-4" />
                  </ComposerPrimitive.Send>
                </AuiIf>
                <AuiIf condition={(s) => s.thread.isRunning}>
                  <ComposerPrimitive.Cancel aria-label="Cancel the turn" className="bg-primary text-primary-foreground rounded-control grid size-7 place-items-center">
                    <SquareIcon className="size-3 fill-current" />
                  </ComposerPrimitive.Cancel>
                </AuiIf>
              </>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  )
}

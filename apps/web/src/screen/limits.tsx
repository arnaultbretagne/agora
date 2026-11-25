// The subscriptions' limits, in the header's top-right corner (docs/specs/assistant-ui.md, "Context and limits"):
// a gauge coloured by the fullest window of every account, whatever the Workstream's pool; opened by a click or a
// touch, a popover with each subscription's windows. The limits are read again each time it opens.
import { GaugeIcon } from 'lucide-react'
import { Popover } from 'radix-ui'
import type { FC } from 'react'
import { Meter, severityOf, severityText } from '@/components/assistant-ui/elements/context-display'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { fullest, resetIn, windowName, type Subscription } from '../agora/view.ts'

/** One subscription: its provider, its plan when known, each window's share, reset and bar; dimmed when its read failed. */
const Account: FC<{ account: Subscription; now: number }> = ({ account: { name, limits }, now }) => (
  <section aria-label={name} className="grid gap-2.5">
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-foreground font-medium">{name}</span>
      {limits.plan !== null && <span className="text-muted-foreground capitalize">{limits.plan}</span>}
    </div>
    {limits.windows.map((w) => {
      const reset = resetIn(w.resetsAt, now)
      return (
        <div key={w.kind} className={cn('grid gap-1.5', limits.stale && 'opacity-60')}>
          <div className="flex items-baseline justify-between gap-4 whitespace-nowrap">
            <span className="text-muted-foreground">{windowName(w.kind)}</span>
            <span className="tabular-nums">
              <span className={severityText[severityOf(w.usedPercent)]}>{Math.round(w.usedPercent)}%</span>
              {reset !== null && <span className="text-muted-foreground"> · resets in {reset}</span>}
            </span>
          </div>
          <Meter percent={w.usedPercent} />
        </div>
      )
    })}
    {limits.stale && (
      <p className="text-muted-foreground">
        {limits.checkedAt === null ? "The limits couldn't be read." : `Not updated since ${new Date(limits.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`}
      </p>
    )}
  </section>
)

/** The gauge and its popover; nothing while no account has windows or a reason. */
export const Limits: FC<{ className?: string }> = ({ className }) => {
  const { limits, refreshLimits } = useAgora()
  if (limits.length === 0) return null
  const percent = fullest(limits)
  const now = Date.now()
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) refreshLimits()
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Limits"
          data-slot="limits-trigger"
          className={cn('text-muted-foreground hover:text-foreground rounded-control grid size-7 shrink-0 place-items-center transition-colors', className)}
        >
          <GaugeIcon className={cn('size-4', percent >= 65 && severityText[severityOf(percent)])} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-slot="limits-popover"
          className="bg-popover text-popover-foreground border-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 rounded-surface z-50 grid max-h-(--radix-popover-content-available-height) w-72 max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto border p-3 text-xs"
        >
          {limits.map((account, i) => (
            <div key={account.profile} className={cn(i > 0 && 'border-foreground/10 border-t pt-3')}>
              <Account account={account} now={now} />
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

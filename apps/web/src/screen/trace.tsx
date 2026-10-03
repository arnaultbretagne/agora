// The trace grammar of assistant-ui's base skin: one monospace line per step, a `>` that turns when it
// opens, a shimmer while it runs, a quiet note on the right. A line that holds more opens in place.
import type { FC, ReactNode } from 'react'
import { ShimmerLabel } from '@/components/assistant-ui/elements/surfaces'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export type Tone = 'live' | 'quiet' | 'error' | 'attention'

const MARKER: Record<Tone, string> = {
  live: 'text-primary',
  quiet: 'text-muted-foreground/50',
  error: 'text-destructive',
  attention: 'text-warning',
}

export const TraceMarker: FC<{ tone: Tone; className?: string }> = ({ tone, className }) => (
  <span aria-hidden className={cn('inline-block shrink-0 transition-transform', MARKER[tone], className)}>
    {'>'}
  </span>
)

const lineClass = 'my-1 flex max-w-full items-baseline gap-2 text-left font-mono text-[12px] [font-variant-ligatures:none]'

const Label: FC<{ tone: Tone; children: ReactNode }> = ({ tone, children }) => (
  <span className={cn('min-w-0 flex-1 truncate', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
    {tone === 'live' ? <ShimmerLabel>{children}</ShimmerLabel> : children}
  </span>
)

const Meta: FC<{ children?: ReactNode }> = ({ children }) =>
  children ? <span className="text-muted-foreground/60 shrink-0">{children}</span> : null

export const TraceLine: FC<{ tone: Tone; label: ReactNode; meta?: ReactNode }> = ({ tone, label, meta }) => (
  <div className={lineClass}>
    <TraceMarker tone={tone} />
    <Label tone={tone}>{label}</Label>
    <Meta>{meta}</Meta>
  </div>
)

/** A trace line that opens onto what it holds: output, a diff, a list. */
export const TraceDisclosure: FC<{
  tone: Tone
  label: ReactNode
  meta?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: ReactNode
}> = ({ tone, label, meta, open, onOpenChange, defaultOpen, children }) => (
  <Collapsible
    {...(open === undefined ? {} : { open })}
    {...(onOpenChange === undefined ? {} : { onOpenChange })}
    {...(defaultOpen === undefined ? {} : { defaultOpen })}
  >
    <CollapsibleTrigger className={cn(lineClass, 'group/trigger w-full outline-none focus-visible:underline')}>
      <TraceMarker tone={tone} className="group-data-[state=open]/trigger:rotate-90" />
      <span className="group-hover/trigger:text-foreground contents">
        <Label tone={tone}>{label}</Label>
      </span>
      <Meta>{meta}</Meta>
    </CollapsibleTrigger>
    <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
      <div className="border-foreground/10 ms-[5px] mb-2 flex flex-col gap-2 border-s ps-4 pt-1">{children}</div>
    </CollapsibleContent>
  </Collapsible>
)

/** Text a tool printed, as it printed it. */
export const Output: FC<{ text: string; tone?: 'error' }> = ({ text, tone }) => (
  <pre
    className={cn(
      'bg-code border-foreground/10 rounded-surface max-h-80 overflow-auto border px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre [font-variant-ligatures:none]',
      tone === 'error' && 'text-destructive',
    )}
  >
    {text}
  </pre>
)

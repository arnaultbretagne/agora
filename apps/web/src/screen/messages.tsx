// The messages (docs/specs/assistant-ui.md, "Messages" and "The screen"), in assistant-ui's base skin:
// the user's in a bubble on the right, the agent's bare on the page, its steps as trace lines, and the
// notices between them as quiet lines; a message of Agora's as a line opening on its text.
import { ActionBarPrimitive, AuiIf, MessagePrimitive, useAuiState, type PartState } from '@assistant-ui/react'
import { CheckIcon, CircleIcon, CopyIcon, LoaderCircleIcon } from 'lucide-react'
import type { FC } from 'react'
import { UserMessageAttachments } from '@/components/assistant-ui/elements/attachment'
import { MarkdownText } from '@/components/assistant-ui/elements/markdown-text'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { foldable } from '../agora/tools.ts'
import { harnessName, planItems } from '../agora/view.ts'
import { Markdown } from './markdown.tsx'
import { ToolCall, ToolFold } from './tool.tsx'
import { TraceDisclosure, TraceLine } from './trace.tsx'

const custom = (s: { message: { metadata: { custom: Record<string, unknown> } } }) => s.message.metadata.custom

/** What the user's turn has become, when it is not plainly done. */
const TURN_NOTE: Record<string, string> = {
  pending: 'waiting for the sandbox',
  saved: 'queued',
  uncertain: 'uncertain',
  cancelled: 'cancelled',
}

export const UserMessage: FC = () => {
  const status = useAuiState((s) => String(custom(s).turnStatus ?? ''))
  // A message of attachments alone has no bubble (docs/specs/assistant-ui.md, "Attachments").
  const said = useAuiState((s) => s.message.content.some((p) => p.type === 'text' && p.text.trim() !== ''))
  // A message of another Workstream's: its writer's, by its title, not the person's.
  const from = useAuiState((s) => String(custom(s).from ?? ''))
  const words = useAuiState((s) => s.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
  const { line, delegates, open } = useAgora()
  const note = TURN_NOTE[status]
  if (from !== '')
    return (
      <MessagePrimitive.Root
        data-role="user"
        data-from={from}
        className="animate-in fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-(--thread-max-width) flex-col items-start duration-150"
      >
        <a
          href={`/w/${from}`}
          onClick={(event) => {
            event.preventDefault()
            open(from)
          }}
          className="text-muted-foreground hover:text-foreground mb-1 px-1 text-[12px]"
        >
          From {[...line, ...delegates].find((r) => r.id === from)?.title ?? 'another agent'}
        </a>
        <div className="border-foreground/15 rounded-thread max-w-[80%] border px-4 py-2 text-[15px] leading-relaxed wrap-break-word">
          <Markdown text={words} />
        </div>
        {note && <span className="text-muted-foreground/70 mt-1 px-1 font-mono text-[11px]">{note}</span>}
      </MessagePrimitive.Root>
    )
  return (
    <MessagePrimitive.Root
      data-role="user"
      className="animate-in fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-(--thread-max-width) flex-col items-end duration-150"
    >
      <UserMessageAttachments />
      {said && (
        <div className="bg-muted rounded-thread max-w-[80%] px-4 py-2 text-[15px] leading-relaxed wrap-break-word whitespace-pre-wrap">
          <MessagePrimitive.Parts />
        </div>
      )}
      {note && (
        <span className={cn('mt-1 px-1 font-mono text-[11px]', status === 'uncertain' ? 'text-warning' : 'text-muted-foreground/70')}>{note}</span>
      )}
    </MessagePrimitive.Root>
  )
}

/** Tools in a row and the reasoning between them fold together (docs/specs/assistant-ui.md, "Folded tools"). */
const groupParts = (part: PartState): readonly ('group-fold' | 'group-reasoning')[] => {
  if (part.type === 'reasoning') return ['group-fold', 'group-reasoning']
  return part.type === 'tool-call' && foldable(part) ? ['group-fold'] : []
}

const Plan: FC<{ entries: unknown[] }> = ({ entries }) => {
  const items = planItems(entries)
  const done = items.filter((i) => i.status === 'done').length
  return (
    <TraceDisclosure tone={done === items.length ? 'quiet' : 'live'} label="plan" meta={`${String(done)}/${String(items.length)}`} defaultOpen>
      <ul className="flex flex-col gap-1 font-sans text-[13px]">
        {items.map((i) => (
          <li key={i.id} className={cn('flex items-start gap-2', i.status === 'done' && 'text-muted-foreground line-through')}>
            {i.status === 'done' ? (
              <CheckIcon className="text-success mt-0.5 size-3.5 shrink-0" />
            ) : i.status === 'active' ? (
              <LoaderCircleIcon className="text-primary mt-0.5 size-3.5 shrink-0 animate-spin" />
            ) : (
              <CircleIcon className="text-muted-foreground/60 mt-0.5 size-3.5 shrink-0" />
            )}
            <span>{i.text}</span>
          </li>
        ))}
      </ul>
    </TraceDisclosure>
  )
}

const Failure: FC = () => {
  const error = useAuiState((s) => {
    const status = s.message.status
    return status?.type === 'incomplete' && (status.reason === 'error' || status.reason === 'other') ? String(status.error ?? '') : ''
  })
  if (error === '') return null
  return <p className="border-destructive/60 text-destructive mt-2 border-l-2 pl-3 text-[13px]">{error}</p>
}

export const AssistantMessage: FC = () => {
  const pending = useAuiState((s) => custom(s).turnStatus === 'pending')
  const harness = useAuiState((s) => String(custom(s).harness ?? ''))
  const running = useAuiState((s) => s.message.status?.type === 'running')
  const empty = useAuiState((s) => s.message.parts.length === 0)
  // A question to the person is one box: its title and text, then its answer at its foot.
  const question = useAuiState((s) => custom(s).question !== undefined)
  const waiting = useAuiState((s) => s.message.status?.type === 'requires-action')
  return (
    <MessagePrimitive.Root
      data-role="assistant"
      className="group/message relative animate-in fade-in slide-in-from-bottom-1 mx-auto w-full max-w-(--thread-max-width) duration-150"
    >
      <div
        data-question={question ? (waiting ? 'pending' : 'answered') : undefined}
        className={cn(
          'text-[15px] leading-relaxed wrap-break-word',
          question && 'bg-background rounded-surface border p-4',
          question && (waiting ? 'border-primary/40' : 'border-foreground/10'),
        )}
      >
        <MessagePrimitive.GroupedParts groupBy={groupParts}>
          {({ part, children }) => {
            switch (part.type) {
              case 'group-fold':
                return <ToolFold indices={part.indices}>{children}</ToolFold>
              case 'group-reasoning': {
                const live = part.status.type === 'running'
                return (
                  <TraceDisclosure tone={live ? 'live' : 'quiet'} label={live ? 'thinking' : 'reasoning'}>
                    <div className="text-muted-foreground font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{children}</div>
                  </TraceDisclosure>
                )
              }
              case 'reasoning':
                return <>{part.text}</>
              case 'text':
                return part.text === '' ? null : <MarkdownText />
              case 'tool-call':
                return <ToolCall {...part} />
              case 'data':
                return part.name === 'plan' ? <Plan entries={(part.data as { entries: unknown[] }).entries} /> : null
              default:
                return null
            }
          }}
        </MessagePrimitive.GroupedParts>
        {running && empty && <TraceLine tone="live" label={pending ? `starting ${harnessName(harness)}` : 'working'} />}
        <Failure />
      </div>
      {/* Shown on hover over an earlier message, it floats in the gap below it: the thread does not move. */}
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        autohideFloat="always"
        className="mt-2 flex items-center gap-1.5 empty:hidden data-floating:absolute data-floating:top-full data-floating:left-0 data-floating:z-10 data-floating:mt-0"
      >
        <ActionBarPrimitive.Copy aria-label="Copy" className="text-muted-foreground/70 hover:text-foreground p-1 transition-colors">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="size-4" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="size-4" />
          </AuiIf>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

const ALARMING = ['execution.lost', 'execution.failed', 'request.failed']

export const Notice: FC = () => {
  const text = useAuiState((s) => {
    const first = s.message.parts[0]
    return first?.type === 'text' ? first.text : ''
  })
  const type = useAuiState((s) => String(custom(s).notice ?? ''))
  // A message of Agora's (docs/specs/assistant-ui.md, "Messages"): one line, opening on its text; an earlier delegation's report counts its outcomes.
  const outcomes = useAuiState((s) => custom(s).report)
  const agora = useAuiState((s) => custom(s).fromAgora === true)
  if (agora)
    return (
      <MessagePrimitive.Root data-agora className="mx-auto w-full max-w-(--thread-max-width)">
        <TraceDisclosure tone="quiet" label="From Agora">
          <Markdown text={text} />
        </TraceDisclosure>
      </MessagePrimitive.Root>
    )
  if (typeof outcomes === 'number')
    return (
      <MessagePrimitive.Root data-report={outcomes} className="mx-auto w-full max-w-(--thread-max-width)">
        <TraceDisclosure tone="quiet" label="From Agora" meta={outcomes === 0 ? 'a reminder' : `${String(outcomes)} outcome${outcomes === 1 ? '' : 's'}`}>
          <Markdown text={text} />
        </TraceDisclosure>
      </MessagePrimitive.Root>
    )
  return (
    <MessagePrimitive.Root
      role="note"
      data-notice={type}
      className={cn('mx-auto w-full max-w-(--thread-max-width) text-center text-[12px]', ALARMING.includes(type) ? 'text-destructive' : 'text-muted-foreground')}
    >
      {text}
    </MessagePrimitive.Root>
  )
}

// A tool call, in the trace grammar (docs/specs/assistant-ui.md, "Parts"): one line with the agent's
// own title, opening onto its diff, its output or its input; and, while the agent waits for it, the
// permission it asks, with the options it offers.
import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import { CheckIcon, CircleIcon, LoaderCircleIcon } from 'lucide-react'
import { useState, type FC } from 'react'
import { DiffViewer } from '@/components/ui/diff-viewer'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { diffStats, labelOf, unwrap, type Artifact, type Todo } from '../agora/tools.ts'
import { harnessName } from '../agora/view.ts'
import { Output, TraceDisclosure, TraceLine, type Tone } from './trace.tsx'

type Option = { id: string; kind: string; label: string }
type Approval = { id: string; options?: Option[]; optionId?: string; approved?: boolean; resolution?: string }

/** An answer worth a note: one that did not simply allow this once. */
function answerNote(approval: Approval | undefined): string | null {
  if (!approval) return null
  if (approval.resolution === 'cancelled') return 'not answered'
  if (approval.optionId === undefined) return null
  const kind = approval.options?.find((o) => o.id === approval.optionId)?.kind ?? (approval.approved ? 'allow-once' : 'reject-once')
  if (kind.startsWith('reject')) return 'rejected'
  return kind === 'allow-always' ? 'allowed for the session' : null
}

const TodoList: FC<{ todos: readonly Todo[] }> = ({ todos }) => (
  <ul className="flex flex-col gap-1 text-[13px]">
    {todos.map((t, i) => (
      <li key={i} className={cn('flex items-start gap-2', t.status === 'completed' && 'text-muted-foreground line-through')}>
        {t.status === 'completed' ? (
          <CheckIcon className="text-success mt-0.5 size-3.5 shrink-0" />
        ) : t.status === 'in_progress' ? (
          <LoaderCircleIcon className="text-primary mt-0.5 size-3.5 shrink-0 animate-spin" />
        ) : (
          <CircleIcon className="text-muted-foreground/60 mt-0.5 size-3.5 shrink-0" />
        )}
        <span>{t.content}</span>
      </li>
    ))}
  </ul>
)

export const PermissionCard: FC<{ approval: Approval }> = ({ approval }) => {
  const { answer, view } = useAgora()
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <div className="border-foreground/10 bg-background rounded-surface my-2 flex flex-col gap-2.5 border p-3">
      <p className="text-[13px]">{harnessName(view.harness)} asks before it goes on.</p>
      <div className="flex flex-wrap gap-1.5">
        {(approval.options ?? []).map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setBusy(o.id)
              void answer(approval.id, o.id).finally(() => setBusy(null))
            }}
            className={cn(
              'rounded-control h-7 px-3 text-[13px] transition-colors disabled:opacity-50',
              o.kind === 'allow-once'
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : o.kind.startsWith('allow')
                  ? 'border-foreground/10 hover:border-foreground/25 border'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export const ToolCall: ToolCallMessagePartComponent = ({ toolName, args, argsText, result, isError, artifact, approval }) => {
  const a = (artifact ?? {}) as Artifact
  const ask = approval as Approval | undefined
  const waiting = ask !== undefined && ask.optionId === undefined && ask.resolution === undefined
  const running = a.status === 'pending' || a.status === 'in_progress'
  const tone: Tone = waiting ? 'attention' : isError ? 'error' : running ? 'live' : 'quiet'
  const diffs = a.diffs ?? []
  const stats = diffs.length > 0 ? diffStats(diffs) : null
  const todos = a.todos ?? []
  // A list the agent keeps is shown as a list, not as the text it printed for itself.
  const output = typeof result === 'string' && result !== '(no output)' && todos.length === 0 ? result : ''
  const command = typeof (args as { command?: unknown }).command === 'string' ? unwrap((args as { command: string }).command) : null
  const meta = waiting
    ? 'waiting for you'
    : (answerNote(ask) ?? (isError ? 'failed' : stats ? `+${String(stats.added)} −${String(stats.removed)}` : undefined))
  const label = labelOf(a, toolName)
  const hasMore = diffs.length > 0 || output !== '' || todos.length > 0 || argsText.trim() !== ''
  return (
    <div>
      {hasMore ? (
        <TraceDisclosure tone={tone} label={label} meta={meta} defaultOpen={waiting}>
          {todos.length > 0 && <TodoList todos={todos} />}
          {diffs.map((d, i) => (
            <DiffViewer
              key={i}
              oldFile={{ content: d.oldText ?? '', name: d.path }}
              newFile={{ content: d.newText ?? '', name: d.path }}
              size="sm"
              maxCollapsedLines={30}
              className="rounded-surface"
            />
          ))}
          {output !== '' && <Output text={output} {...(isError ? { tone: 'error' as const } : {})} />}
          {diffs.length === 0 && output === '' && todos.length === 0 && argsText.trim() !== '' && <Output text={command !== null ? `$ ${command}` : argsText} />}
        </TraceDisclosure>
      ) : (
        <TraceLine tone={tone} label={label} meta={meta} />
      )}
      {waiting && <PermissionCard approval={ask} />}
    </div>
  )
}

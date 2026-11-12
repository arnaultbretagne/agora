// A tool call, in the trace grammar (docs/specs/assistant-ui.md, "Parts"): one line with the agent's
// own title, opening onto its diff, its output or its input; and, while the agent waits for it, the
// permission it asks, with the options it offers. A delegate's line names its delegate and its state, and holds
// the approval it waits for. Tools in a row fold under one line.
import { useAuiState, type ToolCallMessagePartComponent } from '@assistant-ui/react'
import { CheckIcon, CircleIcon, GitMergeIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type FC, type ReactNode } from 'react'
import { DiffViewer } from '@/components/ui/diff-viewer'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { diffStats, foldOf, labelOf, unanswered, unwrap, type Artifact, type Todo } from '../agora/tools.ts'
import { harnessName, type Gate, type MergeCard } from '../agora/view.ts'
import { Markdown } from './markdown.tsx'
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

/**
 * The options of a pending permission; or those of a question to the person (`question`), at the foot
 * of the question's own box, which holds its text: they answer the whole box. A question may take a
 * note with its answer.
 */
export const PermissionCard: FC<{ approval: Approval; question?: boolean; withNote?: boolean }> = ({ approval, question = false, withNote = false }) => {
  const { answer, view } = useAgora()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  return (
    <div className={cn('flex flex-col gap-2.5', !question && 'border-foreground/10 bg-background rounded-surface my-2 border p-3')}>
      {!question && <p className="text-[13px]">{harnessName(view.harness)} asks before it goes on.</p>}
      {withNote && (
        <textarea
          aria-label="Note"
          placeholder="A note with your answer (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          className="border-foreground/10 rounded-control bg-background placeholder:text-muted-foreground resize-y border px-2 py-1.5 text-[13px] outline-none"
        />
      )}
      <div className="flex flex-wrap gap-1.5">
        {(approval.options ?? []).map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setBusy(o.id)
              void answer(approval.id, o.id, withNote && note.trim() !== '' ? note.trim() : undefined).finally(() => setBusy(null))
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

/** A delegation's state as its caller's line says it (docs/specs/assistant-ui.md, "A tool's line"). */
const DELEGATION: Record<string, string> = { working: 'working', waiting: 'waiting for you', idle: 'idle', completed: 'idle', failed: 'failed', cancelled: 'stopped' }

const SETTLED: Record<Exclude<Gate['status'], 'pending'>, string> = { answered: 'Approved', refused: 'Refused', expired: 'Expired before a decision' }

/** An approval on the line it gates: while pending, the proposal, then Approve at its foot; once settled, how. */
const ApprovalBox: FC<{ gate: Gate }> = ({ gate }) => {
  const { answer } = useAgora()
  const [busy, setBusy] = useState(false)
  if (gate.status !== 'pending')
    return (
      <p data-approval={gate.status} className="border-foreground/10 text-muted-foreground ms-[5px] mb-1 flex flex-wrap items-baseline gap-x-1.5 border-s ps-4 text-[13px]">
        <span>{SETTLED[gate.status]}</span>
        {gate.words && <span className="text-foreground">“{gate.words}”</span>}
      </p>
    )
  return (
    <div data-approval="pending" className="border-primary/40 bg-background rounded-surface my-2 flex flex-col gap-3 border p-3">
      <Markdown text={gate.text} />
      <div className="border-foreground/10 flex items-center justify-end gap-2 border-t pt-2.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void answer(gate.id, 'approve').finally(() => setBusy(false))
          }}
          className="bg-primary text-primary-foreground rounded-control h-7 px-3 text-[13px] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Approve
        </button>
      </div>
    </div>
  )
}

/** What a merge card says of its pull request (docs/specs/merge.md, "The card"). */
const MERGE_STATE: Record<string, string> = {
  ready: 'Ready to merge',
  review: 'Waiting for a review',
  blocked: 'Blocked by the repository’s rules',
  checks: 'Checks failing or running',
  conflicts: 'Conflicts with the base',
  behind: 'Behind its base',
  draft: 'A draft',
  computing: 'GitHub is computing…',
  closed: 'Closed',
  merged: 'Merged',
}

/**
 * A merge card (docs/specs/merge.md): the pull request and what GitHub says of it, read again every 20 s while it
 * waits; Merge at its foot, open only when GitHub would merge it. Then how it went.
 */
const MergeBox: FC<{ card: MergeCard }> = ({ card }) => {
  const { api, id, answer } = useAgora()
  const [state, setState] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (card.status !== 'pending' || id === null) return
    let stopped = false
    const read = () =>
      void api
        .merge(id)
        .then((s) => {
          if (!stopped && s !== null && s.question === card.position) setState(s.state)
        })
        .catch(() => undefined)
    read()
    const timer = setInterval(read, 20_000)
    window.addEventListener('focus', read)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [api, id, card.status, card.position])
  const pr = `${card.repo}#${String(card.number)}`
  const title = (
    <a href={card.url} target="_blank" rel="noreferrer" className="hover:text-foreground font-medium underline-offset-2 hover:underline">
      {card.title}
    </a>
  )
  if (card.status !== 'pending') {
    const said =
      card.status === 'cancelled'
        ? 'Cancelled'
        : card.outcome === null
          ? 'Merging…'
          : card.outcome.merged
            ? `Merged · ${card.outcome.sha.slice(0, 7)}`
            : `Not merged — ${card.outcome.reason}`
    return (
      <div data-merge={card.status === 'cancelled' ? 'cancelled' : card.outcome === null ? 'merging' : card.outcome.merged ? 'merged' : 'refused'} className="border-foreground/10 my-2 flex flex-col gap-1 border-s ps-4 text-[13px]">
        <span className="flex items-center gap-1.5">
          <GitMergeIcon className="text-muted-foreground size-3.5 shrink-0" />
          {title}
          <span className="text-muted-foreground">{pr}</span>
        </span>
        <span className={cn('flex items-center gap-1.5', card.outcome?.merged === true ? 'text-foreground' : 'text-muted-foreground')}>
          {card.outcome === null && card.status === 'answered' ? <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" /> : card.outcome?.merged === true ? <CheckIcon className="text-success size-3.5 shrink-0" /> : null}
          {said}
        </span>
      </div>
    )
  }
  const ready = state === 'ready'
  return (
    <div data-merge="pending" className="border-primary/40 bg-background rounded-surface my-2 flex flex-col gap-3 border p-3">
      <div className="flex flex-col gap-1 text-[14px]">
        <span className="flex items-center gap-1.5">
          <GitMergeIcon className="text-primary size-4 shrink-0" />
          {title}
        </span>
        <span data-merge-state={state ?? 'reading'} className="text-muted-foreground text-[13px]">
          {pr} · {state === null ? 'Reading GitHub…' : (MERGE_STATE[state] ?? state)}
        </span>
      </div>
      <div className="border-foreground/10 flex items-center justify-end gap-2 border-t pt-2.5">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => {
            setBusy(true)
            void answer(card.id, 'merge').finally(() => setBusy(false))
          }}
          className="bg-primary text-primary-foreground rounded-control h-7 px-3 text-[13px] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Merge
        </button>
      </div>
    </div>
  )
}

/** A delegate's line — `spawn_agent`, or a `send_message` or a `stop_agent` naming one: its title and harness, a link to it, the state its row gives; its approval. */
const DelegateLine: FC<{ artifact: Artifact; args: Record<string, unknown>; isError: boolean; running: boolean }> = ({ artifact: a, args, isError, running }) => {
  const { delegates, open, view } = useAgora()
  const d = a.delegate
  const row = d ? delegates.find((r) => r.id === d.id) : undefined
  // A delegate's state, or a native sub-agent's: its row's, else what its line last said.
  const state = d ? (row?.delegation ?? row?.subagent ?? a.subagent ?? 'working') : null
  const waiting = a.gate?.status === 'pending' || Boolean(row?.question) || state === 'waiting'
  const settled = a.gate !== undefined && a.gate.status !== 'pending' && d === undefined
  const tone: Tone = waiting ? 'attention' : state === 'failed' || (isError && !settled) ? 'error' : state === 'working' || (d === undefined && running) ? 'live' : 'quiet'
  // A native sub-agent's turn was cancelled; a delegate was stopped.
  const native = a.subagent !== undefined || row?.state === 'native'
  const meta = waiting ? 'waiting for you' : state !== null ? (native && state === 'cancelled' ? 'cancelled' : DELEGATION[state]) : isError && !settled ? 'failed' : undefined
  // Its harness: its row's; before that, the one the call names, else the caller's — unless a role chose it.
  const harness = row?.harness ?? (typeof args.harness === 'string' ? args.harness : typeof args.agent_type === 'string' ? null : view.harness)
  const label = d ? (
    <a
      href={`/w/${d.id}`}
      onClick={(event) => {
        event.preventDefault()
        open(d.id)
      }}
      className="hover:text-foreground underline-offset-2 hover:underline"
    >
      {row?.title || d.title}
      {harness !== null && ` · ${harnessName(harness)}`}
    </a>
  ) : a.gate ? (
    `delegate · ${a.gate.title}`
  ) : (
    labelOf(a, 'delegate')
  )
  return (
    <div data-delegate={d?.id ?? ''}>
      <TraceLine tone={tone} label={label} meta={meta} />
      {a.gate && <ApprovalBox gate={a.gate} />}
    </div>
  )
}

export const ToolCall: ToolCallMessagePartComponent = ({ toolName, args, argsText, result, isError, artifact, approval }) => {
  const a = (artifact ?? {}) as Artifact
  if (a.merge) return <MergeBox card={a.merge} />
  if (a.delegate || a.gate)
    return <DelegateLine artifact={a} args={args as Record<string, unknown>} isError={isError === true} running={a.status === 'pending' || a.status === 'in_progress'} />
  const ask = approval as Approval | undefined
  const waiting = unanswered(ask)
  const running = a.status === 'pending' || a.status === 'in_progress'
  const tone: Tone = waiting ? 'attention' : isError ? 'error' : running ? 'live' : 'quiet'
  const diffs = a.diffs ?? []
  const stats = diffs.length > 0 ? diffStats(diffs) : null
  const todos = a.todos ?? []
  const question = toolName === 'question'
  // A list the agent keeps is shown as a list, not as the text it printed for itself; a question's
  // answer is its line's note.
  const output = typeof result === 'string' && result !== '(no output)' && todos.length === 0 && !question ? result : ''
  const command = typeof (args as { command?: unknown }).command === 'string' ? unwrap((args as { command: string }).command) : null
  const meta = waiting
    ? 'waiting for you'
    : question
      ? (a.answer ? `${a.answer}${a.answerNote ? ` — ${a.answerNote}` : ''}` : undefined)
      : (answerNote(ask) ?? (isError ? 'failed' : stats ? `+${String(stats.added)} −${String(stats.removed)}` : undefined))
  const label = labelOf(a, toolName)
  const hasMore = diffs.length > 0 || output !== '' || todos.length > 0 || argsText.trim() !== ''
  // A question is its message's box (docs/specs/assistant-ui.md, "Parts of a response"): this is its foot.
  if (question)
    return (
      <div className="border-foreground/10 mt-4 flex flex-col gap-2.5 border-t pt-3">
        {waiting ? (
          <>
            <p className="text-primary text-[12px] font-medium">waiting for you</p>
            <PermissionCard approval={ask} question withNote={a.note === true} />
          </>
        ) : (
          <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
            <CheckIcon className="size-3.5 shrink-0" />
            {meta}
          </p>
        )}
      </div>
    )
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
      {waiting && <PermissionCard approval={ask} question={question} withNote={question && a.note === true} />}
    </div>
  )
}

/**
 * Tools in a row (docs/specs/assistant-ui.md, "Folded tools"): one line, closed until the person opens
 * it, opening onto each tool's own line. A tool alone keeps its line.
 */
export const ToolFold: FC<{ indices: readonly number[]; children: ReactNode }> = ({ indices, children }) => {
  const parts = useAuiState((s) => s.message.parts)
  const atTheEnd = useAuiState((s) => s.message.status?.type === 'running' && indices.at(-1) === s.message.parts.length - 1)
  const fold = useMemo(() => foldOf(indices.flatMap((i) => (parts[i]?.type === 'tool-call' ? [parts[i]] : []))), [parts, indices])
  if (fold.count < 2) return <>{children}</>
  const live = atTheEnd || fold.running
  return (
    <div data-tool-fold>
      <TraceDisclosure lines tone={live ? 'live' : 'quiet'} label={live ? fold.latest : fold.summary} meta={live ? `${String(fold.count)} tools` : fold.note}>
        {children}
      </TraceDisclosure>
    </div>
  )
}

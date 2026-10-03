// The components Agora writes (docs/specs/assistant-ui.md, "The screen"): the notice, the turn and
// state badges, the header, the banner above the composer, the harness choice, Continue, the plan and
// the tool call with its title and diffs. Everything else is the registry's.
import { makeAssistantDataUI, useAuiState, type ToolCallMessagePartComponent } from '@assistant-ui/react'
import { AlertTriangleIcon, CircleDotIcon, ClockIcon, PowerIcon, RotateCcwIcon, SquareIcon } from 'lucide-react'
import { useEffect, useState, type FC } from 'react'
import { ConnectionState, type ConnectionPhase } from '@/components/assistant-ui/elements/connection-state'
import { Composer } from '@/components/assistant-ui/elements/thread.aui'
import { TodoList } from '@/components/assistant-ui/elements/todo-list'
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DiffViewer } from '@/components/ui/diff-viewer'
import { cn } from '@/lib/utils'
import type { Pool } from './api.ts'
import { useAgora } from './runtime.tsx'
import { continueBody, planItems, type WorkstreamState } from './view.ts'

// ---------------------------------------------------------------- the thread

export const Notice: FC = () => {
  const text = useAuiState((s) => {
    const first = s.message.parts[0]
    return first?.type === 'text' ? first.text : ''
  })
  const type = useAuiState((s) => String(s.message.metadata.custom.notice ?? ''))
  const alarming = ['execution.lost', 'execution.failed', 'request.failed'].includes(type)
  return (
    <div role="note" data-notice={type} className="flex items-center gap-3 px-2 py-1 text-xs">
      <span className="bg-border h-px flex-1" />
      <span className={cn('max-w-[80%] text-center', alarming ? 'text-destructive' : 'text-muted-foreground')}>{text}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  )
}

export const TurnBadge: FC = () => {
  const status = useAuiState((s) => String(s.message.metadata.custom.turnStatus ?? ''))
  if (status === 'saved')
    return (
      <Badge variant="outline" className="text-muted-foreground gap-1 font-normal">
        <ClockIcon /> saved
      </Badge>
    )
  if (status === 'uncertain')
    return (
      <Badge variant="outline" className="gap-1 border-amber-500 font-normal text-amber-600">
        <AlertTriangleIcon /> uncertain
      </Badge>
    )
  return null
}

const STATE_LABEL: Record<WorkstreamState, string | null> = {
  none: null,
  starting: 'starting',
  ready: 'ready',
  interrupted: 'reconnecting',
  stopped: 'stopped',
  lost: 'lost',
  failed: 'failed',
  ended: 'ended',
}

export const StateBadge: FC<{ state: WorkstreamState }> = ({ state }) => {
  const label = STATE_LABEL[state]
  if (label === null) return null
  const tone = state === 'ready' ? 'text-emerald-600' : ['lost', 'failed'].includes(state) ? 'text-destructive' : 'text-muted-foreground'
  return (
    <Badge variant="outline" className={cn('gap-1 font-normal', tone)}>
      <CircleDotIcon /> {label}
    </Badge>
  )
}

// ---------------------------------------------------------------- the header

export const Header: FC = () => {
  const { view, send, connection } = useAgora()
  const [phase, setPhase] = useState<ConnectionPhase>('online')
  useEffect(() => {
    // The stream's state in the browser: dropped, then reconnecting, then back.
    if (connection === 'offline') setPhase('dropped')
    else if (connection === 'connecting') setPhase((p) => (p === 'online' ? 'online' : 'reconnecting'))
    else setPhase((p) => (p === 'online' ? 'online' : 'resumed'))
  }, [connection])
  const stoppable = view.execution !== null && !['stopped', 'ended'].includes(view.state)
  return (
    <header className="flex flex-col gap-2 border-b px-4 py-2">
      <div className="flex items-center gap-3">
        <h1 className="min-w-0 flex-1 truncate font-medium">{view.title}</h1>
        {view.harness && <span className="text-muted-foreground text-sm">{view.harness}</span>}
        <StateBadge state={view.state} />
        {stoppable && (
          <Button variant="outline" size="sm" onClick={() => void send('Stop', { execution: view.execution }, {})}>
            <PowerIcon /> Stop
          </Button>
        )}
      </div>
      <ConnectionState phase={phase} />
    </header>
  )
}

// ---------------------------------------------------------------- the composer

export const ComposerBanner: FC = () => {
  const { composer, view, send, refusal } = useAgora()
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {refusal && (
        <p role="alert" className="text-destructive px-2 text-sm">
          {refusal}
        </p>
      )}
      {composer.uncertain ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-sm">
          <AlertTriangleIcon className="size-4 text-amber-600" />
          <span className="flex-1">The end of the last turn could not be confirmed. It is never sent again.</span>
          <Button size="sm" variant="outline" onClick={() => void send('Cancel', { execution: view.execution, turn: composer.uncertain!.id }, {})}>
            <SquareIcon /> Cancel
          </Button>
          <Button size="sm" variant="outline" onClick={() => void send('Stop', { execution: view.execution }, {})}>
            <PowerIcon /> Stop
          </Button>
        </div>
      ) : (
        composer.reason &&
        view.state !== 'none' &&
        view.state !== 'ended' && <p className="text-muted-foreground px-2 text-sm">{composer.reason}</p>
      )}
    </div>
  )
}

export const HarnessChoice: FC = () => {
  const { api, send } = useAgora()
  const [pools, setPools] = useState<Pool[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.pools().then(setPools, () => setPools([]))
  }, [api])
  if (pools === null) return <p className="text-muted-foreground text-sm">Loading the harnesses…</p>
  if (pools.length === 0) return <p className="text-muted-foreground text-sm">No harness is available.</p>
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Choose the harness to start with.</p>
      <div className="flex flex-wrap gap-2">
        {pools.map((pool) => (
          <Button
            key={pool.name}
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void send('Create', {}, { pool: pool.name }).finally(() => setBusy(false))
            }}
          >
            {pool.harness}
            <span className="text-muted-foreground text-xs">{pool.readyReplicas > 0 ? 'ready' : 'cold start'}</span>
          </Button>
        ))}
      </div>
    </div>
  )
}

export const AgoraComposer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const { view, send } = useAgora()
  const [fresh, setFresh] = useState(false)
  if (view.state === 'none') return <HarnessChoice />
  if (view.state === 'ended') {
    const body = continueBody(view)
    if (fresh || body === null)
      return (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">The execution has ended.{body === null ? ' Nothing was saved to continue from.' : ''}</p>
          <HarnessChoice />
        </div>
      )
    return (
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground flex-1 text-sm">The execution has ended. Its files are saved.</p>
        <Button onClick={() => void send('Create', {}, body)}>
          <RotateCcwIcon /> Continue
        </Button>
        <Button variant="outline" onClick={() => setFresh(true)}>
          New execution
        </Button>
      </div>
    )
  }
  return <Composer autoFocus={autoFocus} />
}

// ---------------------------------------------------------------- parts

export const PlanUI = makeAssistantDataUI<{ entries: unknown[] }>({
  name: 'plan',
  render: ({ data }) => (
    <div className="my-3">
      <TodoList title="Plan" items={planItems(data.entries)} />
    </div>
  ),
})

type Artifact = { title?: string; diffs?: { path?: string; oldText?: string | null; newText?: string }[] }

/** The tool call with its title, its diffs, its permission and its result. */
export const AgoraTool: ToolCallMessagePartComponent = (props) => {
  const artifact = (props.artifact ?? {}) as Artifact
  const requiresAction = props.status?.type === 'requires-action'
  return (
    <ToolFallback.Root defaultOpen={requiresAction || (artifact.diffs?.length ?? 0) > 0}>
      <ToolFallback.Trigger toolName={artifact.title ?? props.toolName} status={props.status} />
      <ToolFallback.Content>
        <ToolFallback.Error status={props.status} />
        {(artifact.diffs ?? []).map((diff, i) => (
          <div key={i} className="px-4 pb-2">
            <DiffViewer
              oldFile={{ content: diff.oldText ?? '', name: diff.path }}
              newFile={{ content: diff.newText ?? '', name: diff.path }}
              size="sm"
            />
          </div>
        ))}
        <ToolFallback.Args argsText={props.argsText} />
        {(requiresAction || props.approval?.optionId !== undefined || props.approval?.resolution !== undefined) && (
          <ToolFallback.Approval
            approval={props.approval}
            respondToApproval={props.respondToApproval}
            addResult={props.addResult}
            resume={props.resume}
            interrupt={props.interrupt}
            status={props.status}
          />
        )}
        <ToolFallback.Result result={props.result} />
      </ToolFallback.Content>
    </ToolFallback.Root>
  )
}

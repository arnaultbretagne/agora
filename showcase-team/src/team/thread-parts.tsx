// What the team view puts in Thread's slots: Agora's report turns, and the Subagent list aggregate.
import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { ArrowUpRightIcon } from 'lucide-react'
import { useMemo, type FC } from 'react'
import { SpeakerIdentity } from '@/components/assistant-ui/elements/speaker-identity'
import { SubagentList } from '@/components/assistant-ui/elements/subagent-list'
import { TaskGroup } from '@/components/assistant-ui/elements/task-card.aui'
import { UserMessage, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui'
import { subagentModel, subagentName, type ReportTurn } from '@/data/timeline'

/**
 * A report turn is a user-side turn Agora writes into the lead's thread when a member's turn ends.
 * It is input for the lead, not something the person said: one Speaker identity row per report.
 */
const ReportOrUserMessage: FC = () => {
  const reports = useAuiState((s) => s.message.metadata.custom['reports']) as ReportTurn[] | undefined
  if (!reports) return <UserMessage />
  return (
    <MessagePrimitive.Root data-slot="report-turn" data-role="report" className="flex flex-col gap-2 px-2">
      <span className="text-muted-foreground font-mono text-[11px]">
        Agora · {reports.length === 1 ? 'report' : `${reports.length} reports`} to the lead
      </span>
      {reports.map((r) => (
        <div key={r.id} className="flex flex-col gap-1">
          <SpeakerIdentity
            className="max-w-xl"
            data-status={r.status}
            turns={[{ id: r.id, kind: 'subagent', name: r.who, detail: `${r.status} · ${r.feature}`, text: r.text }]}
          />
          {r.href && (
            <a href={r.href} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground ms-8.5 inline-flex w-fit items-center gap-0.5 text-xs">
              {r.link}
              <ArrowUpRightIcon className="size-3" />
            </a>
          )}
        </div>
      ))}
    </MessagePrimitive.Root>
  )
}

/** The Subagent list under one lead message, folded from its start and verify calls (the docs' mapping). */
const SubagentProgress: FC = () => {
  const parts = useAuiState((s) => s.message.parts)
  const view = useMemo(() => {
    const calls = parts.flatMap((p) => (p.type === 'tool-call' && (p.toolName === 'start' || p.toolName === 'verify') ? [p] : []))
    // completedCount counts from the front, so finished workers go first. A failed call has a
    // result too; the list has no failed state, so it stays among the unfinished ones.
    const finished = calls.filter((c) => c.status.type === 'complete' && !c.isError)
    const others = calls.filter((c) => !finished.includes(c))
    const ordered = [...finished, ...others]
    return {
      agents: ordered.map((c) => ({ name: subagentName(c.toolName, c.args), model: subagentModel(c.toolName, c.args) })),
      completed: finished.length,
      progress: ordered.map((c) => (finished.includes(c) ? 100 : 0)),
    }
  }, [parts])
  if (view.agents.length === 0) return null
  return (
    <SubagentList
      className="my-2"
      agents={view.agents}
      completedCount={view.completed}
      progress={view.progress}
      showSummary={false}
      summaryAgent={{ name: '', model: '' }}
    />
  )
}

export const LANES_COMPONENTS: ThreadComponents = { TaskGroup, UserMessage: ReportOrUserMessage }
export const LIST_COMPONENTS: ThreadComponents = { UserMessage: ReportOrUserMessage, AssistantMessageAfterParts: SubagentProgress }
export const PLAIN_COMPONENTS: ThreadComponents = {}

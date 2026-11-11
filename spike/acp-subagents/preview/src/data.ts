// The page's data: rows folded by Agora's core projector from captured lines (tools/preview-data.test.ts),
// turned into messages by the client's own conversion (apps/web/src/agora/view.ts, messagesOf), and the
// children's states read from the captured `subagent_update`s.
import type { ThreadMessageLike } from '@assistant-ui/react'
import { apply, empty, type ThreadRow, type ThreadState } from '@/agora/objects.ts'
import { messagesOf, workstreamOf, type ListRow, type WorkstreamView } from '@/agora/view.ts'
import threadsJson from './data/threads.json'
import treeJson from './data/tree.json'

type Json = Record<string, unknown>
export interface ChildState { state: string; stopReason?: string }
export interface Child {
  id: string
  parent: string | null
  title: string
  description: string
  state: ChildState | null
  capabilities: { cancel?: unknown } | null
}
export interface Moment { capture: string; label: string; at: number; title: string; children: Child[] }
export const TREE = treeJson as unknown as Moment[]

interface Thread { rows: ThreadRow[]; prompt?: string; lines: number }
const threads = threadsJson as unknown as {
  today: Thread
  declared: Thread
  proposed: Thread & { children: (Child & { partsBefore: number; announcedAt: number })[] }
  childClaude: Thread & Child & { at: number; parentTitle: string; task: string | null }
  childCodex: Thread & Child & { at: number; parentTitle: string; task: string | null }
}
export const THREADS = threads

export const stateOf = (rows: readonly ThreadRow[]): ThreadState => {
  let state = empty
  for (const row of rows) state = apply(state, row)
  return { ...state, complete: true }
}

/** Fixed ids for the demo's Workstreams: the replay's are the Lab's, not production's. */
export const IDS = {
  parent: '00000000-0000-4000-8000-0000000000a1',
  delegate: '00000000-0000-4000-8000-0000000000d1',
  child: '00000000-0000-4000-8000-0000000000c1',
}

export function viewOf(state: ThreadState, patch: Partial<WorkstreamView>): WorkstreamView {
  const id = [...state.objects.values()].find((o) => o.kind === 'workstream')?.id ?? IDS.parent
  return { ...workstreamOf(state, id), execution: null, ...patch }
}

/** The client's messages; the Session notice of the replayed lines dropped where it says nothing captured. */
export const messagesFrom = (state: ThreadState): ThreadMessageLike[] => messagesOf(state)

/** A child's line in its parent's thread: Agora's own `delegate` line (tool.tsx, DelegateLine), fed the child. */
export function withChildLines(messages: ThreadMessageLike[], children: typeof threads.proposed.children): ThreadMessageLike[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m
    const parts = [...(m.content as unknown as Json[])]
    for (const [i, c] of [...children].reverse().entries())
      parts.splice(c.partsBefore, 0, {
        type: 'tool-call',
        toolCallId: `child-${String(i)}`,
        toolName: 'other',
        args: {},
        argsText: '',
        result: '',
        artifact: { title: c.title, kind: 'other', status: 'completed', locations: [], diffs: [], delegate: { id: c.id, title: c.title } },
      })
    return { ...m, content: parts as never }
  })
}

/** A native child as the delegate line and the header read a row: its title, harness, and state mapped. */
export function childRow(c: Child, harness: string): ListRow {
  const s = c.state?.state
  const delegation = s === 'running' || s === 'requires_action' ? 'working' : c.state?.stopReason === 'cancelled' ? 'cancelled' : c.state?.stopReason === 'error' ? 'failed' : 'idle'
  return { id: c.id, title: c.title, state: 'none', harness, question: s === 'requires_action' ? 'child' : null, changedAt: '2026-11-11T14:08:00Z', delegation }
}

export const HARNESS: Record<string, string> = { 'claude-caps': 'claude-code', 'codex-caps': 'codex' }
export const TOOL: Record<string, string> = { 'claude-code': 'Agent', codex: 'spawn_agent' }

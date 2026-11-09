// What a tool call's line says (docs/specs/assistant-ui.md, "Parts"): the agent's title made readable,
// and the size of its change; and what the line of a fold says. Pure, like view.ts.
import type { Gate, MergeCard } from './view.ts'

export type Diff = { path?: string; oldText?: string | null; newText?: string }
export type Todo = { content: string; status: string }
export type Artifact = {
  title?: string
  kind?: string
  status?: string
  locations?: { path?: string }[]
  diffs?: Diff[]
  todos?: Todo[]
  /** A question's: whether its answer may carry a note; the option answered and its note. */
  note?: boolean
  answer?: string
  answerNote?: string | null
  /** A `delegate` line's: the delegate its call started; the approval it waits for or waited for. */
  delegate?: { id: string; title: string }
  gate?: Gate
  /** A merge card's (docs/specs/merge.md). */
  merge?: MergeCard
}

const basename = (path: string | undefined): string => (path ? (path.split('/').at(-1) ?? path) : '')

const VERB: Record<string, string> = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run', fetch: 'Fetch' }

/**
 * A command as the user would type it, without the shell an agent wraps it in: the outer quotes go,
 * whatever quoting tricks sit inside.
 */
export function unwrap(title: string): string {
  const inner = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh -l?c\s+([\s\S]+)$/.exec(title)?.[1]
  if (inner === undefined) return title
  return /^['"]/.test(inner) ? inner.slice(1).replace(/['"]$/, '') : inner
}

/** The agent's title; a bare tool name or a path becomes the action and the file it acts on. */
export function labelOf(artifact: Artifact, toolName: string): string {
  const title = unwrap(artifact.title?.trim() || toolName)
  if (/\s/.test(title)) return title
  const where = basename(artifact.locations?.[0]?.path ?? artifact.diffs?.[0]?.path ?? (title.includes('/') ? title : undefined))
  if (where === '') return title
  return `${VERB[artifact.kind ?? ''] ?? (title.includes('/') ? 'Use' : title)} ${where}`
}

const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

/** Lines added and removed, counted as a multiset: enough for a note, not a diff. */
export function diffStats(diffs: readonly Diff[]): { added: number; removed: number } {
  let added = 0,
    removed = 0
  for (const d of diffs) {
    const before = lines(d.oldText ?? '')
    const after = lines(d.newText ?? '')
    const left = new Map<string, number>()
    for (const line of before) left.set(line, (left.get(line) ?? 0) + 1)
    for (const line of after) {
      const n = left.get(line) ?? 0
      if (n > 0) left.set(line, n - 1)
      else added++
    }
    for (const n of left.values()) removed += n
  }
  return { added, removed }
}

/** A permission or a question still waiting for its answer. */
export const unanswered = <A extends { optionId?: string; resolution?: string }>(approval: A | undefined): approval is A =>
  approval !== undefined && approval.optionId === undefined && approval.resolution === undefined

/** A tool call as a fold reads it (docs/specs/assistant-ui.md, "Folded tools"). */
type FoldedTool = { toolName: string; artifact?: unknown; approval?: unknown; isError?: boolean | undefined }

/** Whether a tool call goes in its fold: what waits for the person, a delegate and a question stay on the page. */
export function foldable(tool: FoldedTool): boolean {
  const a = (tool.artifact ?? {}) as Artifact
  return tool.toolName !== 'question' && a.delegate === undefined && a.gate === undefined && !unanswered(tool.approval as { optionId?: string; resolution?: string } | undefined)
}

const NOUN: Record<string, readonly [string, string]> = {
  read: ['read', 'reads'],
  edit: ['edit', 'edits'],
  delete: ['deletion', 'deletions'],
  move: ['move', 'moves'],
  search: ['search', 'searches'],
  execute: ['command', 'commands'],
  fetch: ['fetch', 'fetches'],
  other: ['other tool', 'other tools'],
}

const isRunning = (a: Artifact): boolean => a.status === 'pending' || a.status === 'in_progress'

/** What a fold's line says: its tools counted by kind in their order, how they ended, and the step it is at. */
export function foldOf(tools: readonly FoldedTool[]): { count: number; summary: string; note: string | undefined; latest: string; running: boolean } {
  const kinds = new Map<string, number>()
  const diffs: Diff[] = []
  let failed = 0
  let latest = ''
  let running = false
  for (const tool of tools) {
    const a = (tool.artifact ?? {}) as Artifact
    const kind = a.kind !== undefined && a.kind in NOUN ? a.kind : 'other'
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    diffs.push(...(a.diffs ?? []))
    if (tool.isError === true) failed++
    if (isRunning(a)) running = true
    if (isRunning(a) || !running) latest = labelOf(a, tool.toolName)
  }
  const stats = diffs.length > 0 ? diffStats(diffs) : null
  const note = [failed > 0 ? `${String(failed)} failed` : '', stats ? `+${String(stats.added)} −${String(stats.removed)}` : ''].filter((n) => n !== '').join(' · ')
  return {
    count: tools.length,
    summary: [...kinds].map(([kind, n]) => `${String(n)} ${NOUN[kind]![n === 1 ? 0 : 1]}`).join(', '),
    note: note === '' ? undefined : note,
    latest,
    running,
  }
}

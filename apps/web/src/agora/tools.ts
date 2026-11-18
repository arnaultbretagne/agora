// What a tool call's line says (docs/specs/assistant-ui.md, "Parts"): the agent's title made readable,
// and the size of its change; a message the agent received, who wrote it and its first line; and what the
// line of a fold says. Pure, like view.ts.
import type { Form, Gate, MergeCard, Received } from './view.ts'

export type Diff = { path?: string; oldText?: string | null; newText?: string }
export type Todo = { content: string; status: string }
export type Artifact = {
  title?: string
  kind?: string
  status?: string
  locations?: { path?: string }[]
  diffs?: Diff[]
  todos?: Todo[]
  /** A question's: the option answered and its note. */
  answer?: string
  answerNote?: string | null
  /** A permission its agent's delegator answered, by `answer_agent` (docs/specs/delegation.md, "Requests"). */
  answeredBy?: string
  /** A delegate's line's: the delegate its call names; the approval it waits for or waited for. */
  delegate?: { id: string; title: string }
  /** A native sub-agent's line's: its state as its parent's thread holds it (docs/specs/log.md, "Native sub-agents"). */
  subagent?: string
  gate?: Gate
  /** A merge card's (docs/specs/merge.md). */
  merge?: MergeCard
  /** A form its agent asks, on the tool line it names or on its own (docs/specs/assistant-ui.md, "Forms"). */
  form?: Form
  /** A message the agent received from another than the person (docs/specs/assistant-ui.md, "Messages"). */
  message?: Received
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

/** A message's first line, as a trace line holds it: its first words, without the marks of Markdown that open a line or set its words. */
export function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  return line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '').replace(/\*\*|__|`/g, '')
}

/** Who wrote a message the agent received: Agora, or the Workstream of its writer by its title, among the rows the thread reads. */
export const senderOf = (message: Received, rows: readonly { readonly id: string; readonly title: string }[]): string =>
  message.as === 'agora' ? 'Agora' : (rows.find((r) => r.id === message.from)?.title ?? 'another agent')

/** A message's line: who wrote it, then its first line. */
export const messageLabel = (message: Received, sender: string): string => `From ${sender} · ${firstLine(message.text)}`

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

/** Whether a tool call goes in its fold: what waits for the person, a delegate, a question and a form stay on the page. */
export function foldable(tool: FoldedTool): boolean {
  const a = (tool.artifact ?? {}) as Artifact
  return tool.toolName !== 'question' && a.delegate === undefined && a.gate === undefined && a.form === undefined && !unanswered(tool.approval as { optionId?: string; resolution?: string } | undefined)
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
  message: ['message', 'messages'],
}

const isRunning = (a: Artifact): boolean => a.status === 'pending' || a.status === 'in_progress'

const counted = (n: number, [one, many]: readonly [string, string]): string => `${String(n)} ${n === 1 ? one : many}`

/**
 * What a fold's line says: its tools counted by kind in their order, how they ended, and the step it is at — a message's
 * step said by `label`, which knows its writer's title —; while it runs, how many tool calls and messages it holds.
 */
export function foldOf(
  tools: readonly FoldedTool[],
  label: (tool: FoldedTool) => string = (tool) => labelOf((tool.artifact ?? {}) as Artifact, tool.toolName),
): { count: number; summary: string; note: string | undefined; latest: string; running: boolean; size: string } {
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
    if (isRunning(a) || !running) latest = label(tool)
  }
  const messages = kinds.get('message') ?? 0
  const stats = diffs.length > 0 ? diffStats(diffs) : null
  const note = [failed > 0 ? `${String(failed)} failed` : '', stats ? `+${String(stats.added)} −${String(stats.removed)}` : ''].filter((n) => n !== '').join(' · ')
  return {
    count: tools.length,
    summary: [...kinds].map(([kind, n]) => counted(n, NOUN[kind]!)).join(', '),
    note: note === '' ? undefined : note,
    latest,
    running,
    size: [tools.length > messages ? counted(tools.length - messages, ['tool', 'tools']) : '', messages > 0 ? counted(messages, NOUN.message!) : ''].filter((s) => s !== '').join(', '),
  }
}

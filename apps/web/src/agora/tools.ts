// What a tool call's line says (docs/specs/assistant-ui.md, "Parts"): the agent's title made readable,
// and the size of its change. Pure, like view.ts.

export type Diff = { path?: string; oldText?: string | null; newText?: string }
export type Todo = { content: string; status: string }
export type Artifact = { title?: string; kind?: string; status?: string; locations?: { path?: string }[]; diffs?: Diff[]; todos?: Todo[] }

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

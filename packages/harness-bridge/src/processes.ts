// What still runs in the sandbox (docs/specs/executions.md, "The bridge's routes"): the processes under the adapter,
// read from /proc. The bridge decides nothing with them; Agora reads them to know whether work its agent started
// still runs once a turn is over.
import { readdir, readFile } from 'node:fs/promises'

export interface ProcessView {
  readonly pid: number
  readonly parent: number
  /** The kernel's name for it (`comm`): what the operator reads, never what Agora decides on. */
  readonly command: string
  readonly startedAt: string
}

/** Linux counts a process's start in clock ticks since boot: USER_HZ, 100 on every architecture Agora runs on. */
const TICKS_PER_SECOND = 100

interface Stat {
  readonly pid: number
  readonly parent: number
  readonly command: string
  readonly state: string
  readonly start: number
}

/** `/proc/<pid>/stat`: the name in parentheses may hold anything, so the fields are read after its last `)`. */
function parse(pid: number, text: string): Stat | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const fields = text.slice(close + 2).split(' ')
  const parent = Number(fields[1])
  const start = Number(fields[19])
  if (!Number.isInteger(parent) || !Number.isFinite(start)) return null
  return { pid, parent, command: text.slice(open + 1, close), state: fields[0] ?? '', start }
}

/**
 * The processes descending from `root`, oldest first: neither `except` (whose own descendants are kept), nor a zombie or
 * a dead one. Empty where there is no /proc: nothing is known to run.
 */
export async function processesUnder(root: number, except: readonly number[] = []): Promise<ProcessView[]> {
  let names: string[]
  let uptime: number
  try {
    names = await readdir('/proc')
    uptime = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0])
  } catch {
    return []
  }
  const now = Date.now()
  const stats = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          return parse(Number(name), await readFile(`/proc/${name}/stat`, 'utf8'))
        } catch {
          // Gone since the listing.
          return null
        }
      }),
  )
  const children = new Map<number, Stat[]>()
  for (const stat of stats) if (stat !== null) children.set(stat.parent, [...(children.get(stat.parent) ?? []), stat])
  const out: Stat[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      queue.push(child.pid)
      if (!except.includes(child.pid) && child.state !== 'Z' && child.state !== 'X') out.push(child)
    }
  }
  return out
    .sort((a, b) => a.start - b.start || a.pid - b.pid)
    .map((s) => ({ pid: s.pid, parent: s.parent, command: s.command, startedAt: new Date(now - (uptime - s.start / TICKS_PER_SECOND) * 1000).toISOString() }))
}

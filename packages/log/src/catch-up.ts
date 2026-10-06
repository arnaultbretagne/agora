// Continuing a Workstream (docs/specs/log.md, "Continuing"): the anchor a Create restores, and the
// exchanges that anchor does not hold, given to the agent as text with the execution's first prompt.
// Pure: it reads the fold and the entries, nothing else.
import { object } from './json.ts'
import type { Execution, State } from './state.ts'
import type { Entry } from './store.ts'

/** The `_meta` key that marks Agora's catch-up block in a prompt. */
export const CATCH_UP_META = 'agora.bretagne.dev/catch-up'
/** The characters of exchanges given at most: the most recent are kept. */
export const CATCH_UP_MAX = 200_000
/** A user message or an agent response longer than this is cut. */
const FIELD_MAX = 20_000

export interface Exchange {
  /** The position of its `session/prompt`. */
  readonly position: string
  readonly user: string
  readonly agent: string
}

export interface CatchUp {
  readonly text: string
  /** The exchanges given, by their prompts' positions, and how many were left out for length. */
  readonly turns: readonly string[]
  readonly omitted: number
}

/** Agora's catch-up block, never the user's: what the thread leaves out of the user's message. */
export const isCatchUp = (block: unknown): boolean => object(object(block)?._meta)?.[CATCH_UP_META] !== undefined

const carries = (prompt: Entry | undefined): boolean => {
  const blocks = object(prompt?.content.params)?.prompt
  return Array.isArray(blocks) && blocks.some(isCatchUp)
}

/** What the log knows of a Workstream's anchors. */
export interface Anchors {
  /** Each anchor's execution and harness, and whether it names an ACP session to resume. */
  readonly of: Map<string, { readonly execution: string; readonly harness: string; readonly resumable: boolean }>
  /** The anchors an execution failed to restore — its failure, or an error answering its resume: not restored again unless named. */
  readonly failed: Set<string>
}

export const noAnchors = (): Anchors => ({ of: new Map(), failed: new Set() })

/** Notes what one entry says of the anchors: in position order, after the fold has taken it. */
export function noteAnchor(anchors: Anchors, entry: Entry, state: State): void {
  if (entry.kind === 'anchor.received' && entry.execution && typeof entry.content.id === 'string') {
    const metadata = object(entry.content.metadata)
    if (typeof metadata?.harness === 'string')
      anchors.of.set(entry.content.id, { execution: entry.execution, harness: metadata.harness, resumable: typeof metadata.sessionId === 'string' })
  }
  const refused =
    (entry.kind === 'execution.failed' && ['restore_failed', 'anchor_missing'].includes(String(entry.content.reason))) ||
    (entry.kind === 'acp' && entry.rpc_kind === 'error' && ['session/resume', 'session/load'].includes(entry.correlated_method ?? ''))
  const anchor = refused && entry.execution ? state.executions.get(entry.execution)?.body.anchor : undefined
  if (typeof anchor === 'string') anchors.failed.add(anchor)
}

export function anchorsOf(entries: readonly Entry[], state: State): Anchors {
  const anchors = noAnchors()
  for (const entry of entries) noteAnchor(anchors, entry, state)
  return anchors
}

/**
 * The anchor a Create in this harness restores: among the Workstream's, that of the execution created
 * last, if it opened a Session; never one an execution failed to restore.
 */
export function lastAnchor(anchors: Anchors, state: State, harness: string): string | null {
  const order = [...state.executions.keys()]
  let found: { anchor: string; rank: number } | null = null
  for (const [anchor, a] of anchors.of) {
    if (a.harness !== harness || !a.resumable || anchors.failed.has(anchor) || !state.executions.get(a.execution)?.session) continue
    const rank = order.indexOf(a.execution)
    if (found === null || rank >= found.rank) found = { anchor, rank }
  }
  return found?.anchor ?? null
}

const byPosition = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)

/** The Workstream's exchanges: its prompts that were dispatched, by position. */
export function dispatched(state: State): string[] {
  return [...state.turns.values()].filter((t) => t.dispatching).map((t) => t.requestPosition).sort(byPosition)
}

/** The exchanges an execution was given: its Create's catch-up, once a prompt carrying it was dispatched. */
function given(state: State, e: Execution): string[] {
  const turns = object(e.body.catchUp)?.turns
  if (!Array.isArray(turns) || turns.length === 0) return []
  const sent = [...state.turns.values()].some((t) => t.execution === e.id && t.dispatching && carries(state.requestPositions.get(t.requestPosition)))
  return sent ? turns.map(String) : []
}

/**
 * The exchanges an anchor holds: its execution's own, those it was given, and those the anchor it
 * restored held. None for an anchor of another Workstream.
 */
export function held(anchors: Anchors, state: State, anchor: string | null): Set<string> {
  const holds = new Set<string>()
  const seen = new Set<string>()
  for (let current = anchor; current !== null; ) {
    const a = anchors.of.get(current)
    const e = a && !seen.has(a.execution) ? state.executions.get(a.execution) : undefined
    if (!e) break
    seen.add(e.id)
    for (const t of state.turns.values()) if (t.execution === e.id && t.dispatching) holds.add(t.requestPosition)
    for (const position of given(state, e)) holds.add(position)
    current = typeof e.body.anchor === 'string' ? e.body.anchor : null
  }
  return holds
}

/** What a Session restored from this anchor — or from none — lacks: every exchange it does not hold. */
export function lacking(anchors: Anchors, state: State, anchor: string | null): string[] {
  const holds = held(anchors, state, anchor)
  return dispatched(state).filter((position) => !holds.has(position))
}

function blockText(block: unknown): string {
  const b = object(block)
  if (!b || isCatchUp(b)) return ''
  if (b.type === 'text') return typeof b.text === 'string' ? b.text : ''
  if (b.type === 'resource_link') return `[link: ${String(b.name ?? b.uri ?? '')}]`
  if (b.type === 'resource') return `[resource: ${String(object(b.resource)?.uri ?? '')}]`
  return `[${String(b.type ?? 'content')}]`
}

const cut = (text: string): string => (text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX)}\n[…cut]` : text)

/**
 * The exchanges of these prompts, in order: the user's message, but an earlier catch-up; then what
 * the agent said and the tools it called, in the order it gave them. No reasoning, no tool content.
 */
export function exchangesOf(entries: readonly Entry[], positions: readonly string[]): Exchange[] {
  const wanted = new Set(positions)
  type Part = { tool?: string; text: string }
  const turns = new Map<string, { user: string; parts: Part[]; tools: Map<string, Part> }>()
  const latest = new Map<string, string>()
  for (const e of entries) {
    if (e.kind === 'acp' && e.direction === 'out' && e.rpc_kind === 'request' && e.method === 'session/prompt' && e.session) {
      latest.set(e.session, e.position)
      if (!wanted.has(e.position)) continue
      const prompt = object(e.content.params)?.prompt
      const user = (Array.isArray(prompt) ? prompt : []).map(blockText).filter((t) => t !== '').join('\n')
      turns.set(e.position, { user, parts: [], tools: new Map() })
    }
    if (e.kind === 'acp' && e.direction === 'in' && e.method === 'session/update' && e.session) {
      const turn = turns.get(latest.get(e.session) ?? '')
      const update = object(object(e.content.params)?.update)
      if (!turn || !update) continue
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = object(update.content)
        if (content?.type !== 'text' || typeof content.text !== 'string') continue
        const last = turn.parts.at(-1)
        if (last && last.tool === undefined) last.text += content.text
        else turn.parts.push({ text: content.text })
      }
      if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && typeof update.toolCallId === 'string') {
        let tool = turn.tools.get(update.toolCallId)
        if (!tool) {
          tool = { tool: '', text: '' }
          turn.tools.set(update.toolCallId, tool)
          turn.parts.push(tool)
        }
        if (typeof update.title === 'string') tool.tool = update.title
        if (typeof update.status === 'string') tool.text = update.status
      }
    }
  }
  return [...turns].map(([position, t]) => ({
    position,
    user: t.user,
    agent: t.parts
      .map((p) => (p.tool === undefined ? p.text.trim() : `[tool: ${p.tool || 'unnamed'}${p.text === 'failed' ? ' — failed' : ''}]`))
      .filter((p) => p !== '')
      .join('\n'),
  }))
}

/**
 * The text that gives exchanges to a Session, the most recent kept within CATCH_UP_MAX; `restored`
 * says whether it was restored from an anchor that does not hold them; `omitted`, how many were
 * already left out before these.
 */
export function catchUpText(exchanges: readonly Exchange[], restored: boolean, omitted = 0): CatchUp {
  const rendered = exchanges.map((x) => `<exchange>\n<user>\n${cut(x.user)}\n</user>\n<agent>\n${cut(x.agent)}\n</agent>\n</exchange>`)
  let kept = 0,
    size = 0
  for (let i = rendered.length - 1; i >= 0 && size + rendered[i]!.length <= CATCH_UP_MAX; i--) {
    size += rendered[i]!.length
    kept++
  }
  const left = rendered.length - kept + omitted
  const header = [
    restored
      ? 'Your session was restored from a save that does not hold the exchanges below: the conversation went on without it.'
      : 'This conversation began before your session, and no save of it could be restored.',
    'They are given here for context, oldest first. The message after this block is the user’s new one.',
    ...(left > 0 ? [`${String(left)} earlier exchanges are left out for length.`] : []),
  ].join(' ')
  return {
    text: `<agora-catch-up>\n${header}\n\n${rendered.slice(rendered.length - kept).join('\n\n')}\n</agora-catch-up>`,
    turns: exchanges.slice(exchanges.length - kept).map((x) => x.position),
    omitted: left,
  }
}

/** The prompt block that carries a catch-up. */
export function catchUpBlock(catchUp: CatchUp): Record<string, unknown> {
  return { type: 'text', text: catchUp.text, _meta: { [CATCH_UP_META]: { exchanges: catchUp.turns.length, omitted: catchUp.omitted } } }
}

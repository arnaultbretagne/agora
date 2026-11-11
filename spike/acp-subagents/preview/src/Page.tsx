// Native sub-agents in Agora's interface: two needs, side by side, static. Every block says what it is:
// captured (from the raw ACP lines), Agora (the client's component, unmodified), new (made for this page).
import { ThreadPrimitive } from '@assistant-ui/react'
import { ChevronRightIcon, SquareIcon } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { BrandMark, Wordmark } from '@/screen/brand.tsx'
import { AssistantMessage, Notice, UserMessage } from '@/screen/messages.tsx'
// Not exported by shell.tsx: the build exports them, their code unchanged (vite.config.ts).
import { Below, Item, Title } from '@/screen/shell.tsx'
import type { ListRow } from '@/agora/view.ts'
import { StandIn, type Fixed } from './standin.tsx'
import { childRow, HARNESS, IDS, messagesFrom, stateOf, THREADS, TOOL, TREE, viewOf, withChildLines, type Child, type Moment } from './data.ts'

// ---------------------------------------------------------------- labels

type Kind = 'captured' | 'agora' | 'new'
const KIND: Record<Kind, { label: string; className: string }> = {
  captured: { label: 'captured', className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  agora: { label: 'Agora, unmodified', className: 'bg-foreground/[0.06] text-foreground/80' },
  new: { label: 'new for this page', className: 'bg-primary/12 text-primary' },
}
const Tag: FC<{ kind: Kind; children?: ReactNode }> = ({ kind, children }) => (
  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium', KIND[kind].className)}>
    {KIND[kind].label}
    {children && <span className="font-normal opacity-80">· {children}</span>}
  </span>
)

const Block: FC<{ title: ReactNode; tags: ReactNode; children: ReactNode; note?: ReactNode; className?: string }> = ({ title, tags, children, note, className }) => (
  <figure className={cn('m-0 flex min-w-0 flex-col gap-2', className)}>
    <figcaption className="flex flex-col gap-1.5">
      <span className="text-[14px] font-medium">{title}</span>
      <span className="flex flex-wrap gap-1">{tags}</span>
    </figcaption>
    {children}
    {note && <p className="text-muted-foreground m-0 text-[12.5px] leading-relaxed">{note}</p>}
  </figure>
)

// ---------------------------------------------------------------- the sidebar

const at = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const harnessOf = (m: Moment) => HARNESS[m.capture] ?? 'claude-code'
const rootRow = (m: Moment, i: number, below?: ListRow['below']): ListRow => ({
  id: `root-${String(i)}`,
  title: m.title,
  state: 'ready',
  harness: harnessOf(m),
  question: null,
  changedAt: '2026-11-11T14:10:00Z',
  ...(below ? { below } : {}),
})
/** The example delegate: Agora's own sub-stream, under the first parent only. Not captured. */
const DELEGATE: ListRow = { id: IDS.delegate, title: 'Review the change', state: 'ready', harness: 'codex', question: null, changedAt: '2026-11-11T14:10:00Z', parent: 'root-0', depth: 1, delegation: 'working' }
const noop = () => undefined

/** SubStreams' indent (shell.tsx), its markup copied: the component reads its list from the server. */
const Group: FC<{ children: ReactNode }> = ({ children }) => (
  <div role="group" className="border-foreground/10 ml-[11px] flex flex-col gap-0.5 border-l pl-1">
    {children}
  </div>
)

/** New: a native sub-agent as a node: Item's markup, the harness's tool before its title, its captured state at its end; opening it opens its read-only thread. */
const NativeItem: FC<{ c: Child; harness: string; open?: boolean }> = ({ c, harness, open }) => {
  const s = c.state?.state
  return (
    <div className="rounded-control text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground flex h-8 w-full shrink-0 items-center text-[13px] transition-colors">
      {open === undefined ? <span aria-hidden className="w-5 shrink-0" /> : <span className="grid h-8 w-5 shrink-0 place-items-center pl-1.5"><ChevronRightIcon className={cn('size-3.5', open && 'rotate-90')} /></span>}
      <span title={`A native sub-agent of ${harness === 'codex' ? 'Codex' : 'Claude Code'}: read-only`} className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2 pl-1">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground/60 font-mono text-[11px]">{TOOL[harness]}</span> {c.title}
        </span>
        {s === 'requires_action' ? (
          <span className="text-primary shrink-0 text-[11px] font-medium">waiting for you</span>
        ) : s === 'running' ? (
          <span aria-label="running" className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full" />
        ) : c.state?.stopReason === 'cancelled' ? (
          <span className="text-muted-foreground/70 shrink-0 text-[11px]">stopped</span>
        ) : null}
      </span>
    </div>
  )
}

const natives = (m: Moment, parent: string | null): Child[] => m.children.filter((c) => c.parent === parent)
const NativeBranch: FC<{ m: Moment; c: Child }> = ({ m, c }) => {
  const below = natives(m, c.id)
  return (
    <div className="flex flex-col gap-0.5">
      <NativeItem c={c} harness={harnessOf(m)} open={below.length > 0 ? true : undefined} />
      {below.length > 0 && (
        <Group>
          {below.map((x) => (
            <NativeBranch key={x.id} m={m} c={x} />
          ))}
        </Group>
      )}
    </div>
  )
}

/** New: what B puts on the parent's row: how many native sub-agents it has, how many run; one waiting for the person first. */
const NativeCount: FC<{ m: Moment }> = ({ m }) => {
  const all = m.children
  if (all.some((c) => c.state?.state === 'requires_action')) return <span className="text-primary shrink-0 text-[11px] font-medium">waiting for you</span>
  const running = all.filter((c) => c.state?.state === 'running').length
  return (
    <span className="text-muted-foreground/80 shrink-0 text-[11px] tabular-nums">
      {running > 0 ? <span className="text-primary">{running}/{all.length} running</span> : `${String(all.length)} sub-agent${all.length === 1 ? '' : 's'}`}
    </span>
  )
}

/** New for B: Item's markup (shell.tsx), the counter at its end in place of the state's dot. */
const CountedItem: FC<{ w: ListRow; m: Moment; open: boolean }> = ({ w, m, open }) => (
  <div className="rounded-control text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground flex h-8 w-full shrink-0 items-center text-[13px] transition-colors">
    {w.below ? <span className="grid h-8 w-5 shrink-0 place-items-center pl-1.5"><ChevronRightIcon className={cn('size-3.5', open && 'rotate-90')} /></span> : <span aria-hidden className="w-5 shrink-0" />}
    <span className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2 pl-1">
      <span className="min-w-0 flex-1 truncate">{w.title}</span>
      {!open && w.below && <Below below={w.below} />}
      <NativeCount m={m} />
    </span>
  </div>
)

const Sidebar: FC<{ children: ReactNode }> = ({ children }) => (
  <aside className="bg-sidebar border-foreground/10 rounded-surface w-full max-w-[17rem] border p-3">
    <p className="text-muted-foreground mb-1 px-2 text-xs font-medium">Today</p>
    <div className="flex flex-col gap-0.5">{children}</div>
  </aside>
)

const TreeA: FC = () => (
  <Sidebar>
    {TREE.map((m, i) => (
      <div key={m.label} className="flex flex-col gap-0.5">
        <Item w={rootRow(m, i, { count: 1, live: 1, waiting: 0 })} active={false} onOpen={noop} fold={{ open: true, toggle: noop }} />
        <Group>
          {i === 0 && <Item w={DELEGATE} active={false} onOpen={noop} />}
          {natives(m, null).map((c) => (
            <NativeBranch key={c.id} m={m} c={c} />
          ))}
        </Group>
      </div>
    ))}
  </Sidebar>
)

const TreeB: FC = () => (
  <Sidebar>
    {TREE.map((m, i) =>
      i === 0 ? (
        <div key={m.label} className="flex flex-col gap-0.5">
          <CountedItem w={rootRow(m, i, { count: 1, live: 1, waiting: 0 })} m={m} open />
          <Group>
            <Item w={DELEGATE} active={false} onOpen={noop} />
          </Group>
        </div>
      ) : (
        <CountedItem key={m.label} w={rootRow(m, i)} m={m} open={false} />
      ),
    )}
  </Sidebar>
)

// ---------------------------------------------------------------- the thread

const Messages: FC = () => (
  <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col" style={{ ['--thread-max-width' as string]: '42rem' }}>
    <ThreadPrimitive.Viewport autoScroll={false} className="relative flex flex-1 flex-col overflow-y-auto px-4 pt-5">
      <div className="mb-6 flex flex-col gap-y-5">
        <ThreadPrimitive.Messages>{({ message }) => (message.role === 'user' ? <UserMessage /> : message.role === 'assistant' ? <AssistantMessage /> : <Notice />)}</ThreadPrimitive.Messages>
      </div>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
)

/** A thread at a fixed height: its bar (Agora's Title), its messages (Agora's), and what stands at its foot. */
const Frame: FC<{ value: Fixed; after?: ReactNode; foot?: ReactNode; className?: string }> = ({ value, after, foot, className }) => (
  <StandIn value={value}>
    <div className={cn('bg-background border-foreground/10 rounded-surface flex h-[25rem] min-w-0 flex-col overflow-hidden border', className)}>
      <div className="border-foreground/10 flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <Title />
        {after}
      </div>
      <Messages />
      {foot}
    </div>
  </StandIn>
)

const fixed = (rows: typeof THREADS.today.rows, patch: Partial<Fixed> & { title?: string; harness?: string; state?: Fixed['view']['state'] } = {}, transform = (m: Fixed['messages']) => m): Fixed => {
  const state = stateOf(rows)
  const { title, harness, state: ws, ...rest } = patch
  const view = viewOf(state, { ...(title ? { title } : {}), ...(harness ? { harness } : {}), state: ws ?? 'ready' })
  // The replay's Session notice says nothing captured: dropped.
  const messages = messagesFrom(state).filter((m) => !(m.role === 'system' && (m.metadata?.custom as Record<string, unknown> | undefined)?.notice === 'session.opened'))
  return { id: IDS.parent, state, view, messages: transform(messages) as Fixed['messages'], line: [], delegates: [], ...rest }
}

const CHILD = THREADS.proposed.children[0]!
const today = fixed(THREADS.today.rows)
const declared = fixed(THREADS.declared.rows)
const proposed = fixed(THREADS.proposed.rows, { delegates: THREADS.proposed.children.map((c) => childRow(c, 'claude-code')) }, (m) => withChildLines([...m], THREADS.proposed.children))

const parentRow = (title: string, harness: string): ListRow => ({ id: IDS.parent, title, state: 'ready', harness, question: null, changedAt: '2026-11-11T14:10:00Z' })
const childFrame = (c: typeof THREADS.childClaude, harness: string): Fixed => {
  const value = fixed(c.rows, { title: c.title, harness, state: 'none', line: [parentRow(c.parentTitle, harness)] })
  // The task's "From …" names its parent: the element's `from`, read against the header's line.
  const messages = value.messages
    .filter((m) => m.role !== 'user' || c.task !== null)
    .map((m) => (m.role === 'user' ? { ...m, metadata: { custom: { ...(m.metadata?.custom ?? {}), from: IDS.parent } } } : m))
  return { ...value, id: IDS.child, messages }
}
const claudeChild = childFrame(THREADS.childClaude, 'claude-code')
const codexChild = childFrame(THREADS.childCodex, 'codex')

/** New: where the bar's Stop stands for an execution, the child's state; Cancel only where it advertises `cancel`. */
const ChildBar: FC<{ c: Child }> = ({ c }) => {
  const s = c.state?.state ?? 'unknown'
  const running = s === 'running' || s === 'requires_action'
  const cancel = c.capabilities?.cancel != null && running
  return (
    <span className="flex shrink-0 items-center gap-2 text-[12px]">
      <span className="text-muted-foreground">{running ? s.replace('_', ' ') : `${s}${c.state?.stopReason ? ` · ${c.state.stopReason}` : ''}`}</span>
      {cancel && (
        <span title="session/cancel on this sub-agent alone" className="text-muted-foreground hover:text-foreground rounded-control border-foreground/10 flex h-7 items-center gap-1.5 border px-2 text-[13px]">
          <SquareIcon className="size-3" />
          Cancel
        </span>
      )}
    </span>
  )
}
const ReadOnlyFoot: FC<{ parent: string }> = ({ parent }) => (
  <p className="border-foreground/10 text-muted-foreground m-0 shrink-0 border-t px-4 py-2.5 text-[12px]">Read-only: a sub-agent of “{parent}” takes no message.</p>
)

// ---------------------------------------------------------------- the page

export function Page() {
  const c1 = THREADS.childClaude, c2 = THREADS.childCodex
  return (
    <main className="mx-auto flex max-w-[76rem] flex-col gap-12 px-4 py-8 md:px-8">
      <header className="flex flex-col gap-3">
        <span className="flex items-center gap-2"><BrandMark className="size-5" /><Wordmark /></span>
        <h1 className="font-brand m-0 text-[2rem] leading-tight font-medium tracking-tight">Native sub-agents, as Agora could show them</h1>
        <p className="text-muted-foreground m-0 max-w-3xl text-[14px] leading-relaxed">
          From raw ACP lines captured on 11 November 2026 with <code className="font-mono text-[12.5px]">clientCapabilities.subagents</code> declared, on
          the production images: claude-agent-acp 0.100.0 with claude-code 2.1.316 (Haiku) and codex-acp 2.5.0 with codex 0.165.0 (gpt-6-luna). Threads are
          those lines through Agora’s own log, projector and client conversion (origin/main 6788da7), drawn by the client’s own components.
        </p>
        <p className="m-0 flex flex-wrap gap-1.5"><Tag kind="captured" /><Tag kind="agora" /><Tag kind="new" /></p>
      </header>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">1 · In the sidebar</h2>
          <p className="text-muted-foreground m-0 max-w-3xl text-[13px]">
            Three captured parents, each at one moment of its run ({TREE.map((m) => `${m.title} at ${at(m.at)}`).join('; ')}). The first also has an Agora delegate, as an example.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_1fr_1.1fr]">
          <Block
            title="A · a node, read-only, like a sub-stream"
            tags={<><Tag kind="agora">Item for Workstreams and the delegate</Tag><Tag kind="new">native rows</Tag><Tag kind="captured">titles, states, nesting</Tag></>}
          >
            <TreeA />
          </Block>
          <Block
            title="B · a counter on its parent’s row"
            tags={<><Tag kind="agora">Item, Below</Tag><Tag kind="new">the counter</Tag><Tag kind="captured">counts, states</Tag></>}
          >
            <TreeB />
          </Block>
          <Block title="What the lines say" tags={<Tag kind="captured">measured on these runs</Tag>}>
            <ul className="text-foreground/85 m-0 flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed">
              <li>A child is small: Claude Code 5–22 lines (2–13 KB) of its own, Codex 3–41 (1–14 KB); its parent spends 2–6 lines announcing it.</li>
              <li>Every child got one task and none a second; a background one can wake again after idle (Claude Code, when its own background command ends).</li>
              <li>What a node opens onto: Claude Code gives the task, the answer, the tools; Codex gives no task message, only the child’s text and tools.</li>
              <li>Both nest (depth 2 seen). Codex never reported its grandchild idle: a node would stay “running”.</li>
              <li>A child’s permission comes under its own id and puts it in “requires action”: in B it bubbles up as “waiting for you”.</li>
            </ul>
          </Block>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">2 · In the thread</h2>
          <p className="text-muted-foreground m-0 max-w-3xl text-[13px]">The same prompt on Claude Code, one sub-agent it waits for: “{THREADS.today.prompt}”</p>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Block
            title="Today: no capability"
            tags={<><Tag kind="captured">{THREADS.today.lines} lines</Tag><Tag kind="agora">thread, tool line</Tag></>}
            note="Claude Code shows its Agent call as a tool line, ends the turn while the child runs, and gives the result outside the turn (it shows in the last turn)."
          >
            <Frame value={today} />
          </Block>
          <Block
            title="Declared, Agora as it is"
            tags={<><Tag kind="captured">{THREADS.declared.lines} lines</Tag><Tag kind="agora">log, projector, thread</Tag></>}
            note="Nothing is refused, but the child’s “391” is drawn as the parent’s words, the Agent line is gone. Not drawn here: the Workstream’s settings become the child’s (mode, model, effort and a new agent = general-purpose)."
          >
            <Frame value={declared} />
          </Block>
          <Block
            title="With a child line"
            tags={<><Tag kind="captured">the parent’s {THREADS.proposed.lines} lines, the child’s title and state</Tag><Tag kind="agora">the delegate line</Tag><Tag kind="new">fed a native child</Tag></>}
            note={`The parent’s own lines only. Where the child was announced (${at(CHILD.announcedAt)} into the turn), Agora’s delegate line names it (“${CHILD.title}”, ${CHILD.description}) and its state, and opens its thread.`}
          >
            <Frame value={proposed} />
          </Block>
        </div>
        <p className="text-muted-foreground m-0 max-w-4xl text-[12.5px] leading-relaxed">
          <Tag kind="captured">Codex, the same prompt</Tag> Today its parent shows three tool lines, “Start subagent multiply”, “wait”, “Complete subagent multiply”. Declared, only “wait” stays, the
          child’s “391” joins the parent’s words, and the settings shrink to the child’s one option, model; its context ring can take the child’s numbers.
        </p>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Block
            title={<>The child’s thread, read-only: Claude Code, while it runs ({at(c1.at)})</>}
            tags={<><Tag kind="captured">its {c1.lines} lines, its task</Tag><Tag kind="agora">Title with its parent, messages, “From …”</Tag><Tag kind="new">state and Cancel in the bar, no composer</Tag></>}
            note={`Advertised: cancel ${JSON.stringify(c1.capabilities?.cancel ?? null)}. Claude Code keeps it after the child goes idle; Cancel shows only while it runs.`}
          >
            <Frame value={claudeChild} after={<ChildBar c={c1} />} className="h-[20rem]" foot={<ReadOnlyFoot parent={c1.parentTitle} />} />
          </Block>
          <Block
            title={<>The child’s thread, read-only: Codex, once idle</>}
            tags={<><Tag kind="captured">its {c2.lines} lines</Tag><Tag kind="agora">Title with its parent, messages</Tag><Tag kind="new">state in the bar, no composer</Tag></>}
            note="Codex withdraws cancel at idle (cancel: null), so no Cancel. It reports no task message: the thread opens on the child’s answer."
          >
            <Frame value={codexChild} after={<ChildBar c={c2} />} className="h-[20rem]" foot={<ReadOnlyFoot parent={c2.parentTitle} />} />
          </Block>
        </div>
      </section>
    </main>
  )
}

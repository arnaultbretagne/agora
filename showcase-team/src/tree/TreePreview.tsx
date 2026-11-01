// Sub-streams: the options for the sidebar and for the parent's thread, side by side, static, on the
// person's own list and team runs. The sidebar is Agora's own in every option (assistant-ui's thread list
// is flat); inside a thread, assistant-ui's elements render the sub-streams, unmodified.
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AgentStatus } from '@/components/assistant-ui/elements/agent-status'
import { SubagentList } from '@/components/assistant-ui/elements/subagent-list'
import { TaskCard } from '@/components/assistant-ui/elements/task-card'
import { Need, Option, State } from '@/catalog/Option'
import { cn } from '@/lib/utils'
import { RECENT, TEAMS, type Row } from './data'

// ---------------------------------------------------------------- the data, with the states made up

/** "Gateway 1.6.0 with oauth2-proxy": its run as recorded, its states made up to show what bubbles up. */
const GATEWAY = TEAMS.find((t) => t.lead.title.startsWith('Gateway'))!
const live = (r: Row): Row =>
  r.member === 'dev-1' ? { ...r, state: 'starting' } : r.member === 'sre-1' ? { ...r, state: 'ready', question: '1' } : r
/** A sub-stream of dev-1, made up: no team went two levels deep. */
const ASSISTANT: Row = {
  id: 'made-up', title: 'Read the gateway 1.6.0 changelog', state: 'starting', harness: 'claude-code', question: null, changedAt: '2026-10-28T20:40:00+00', member: 'assistant',
}

interface Node { row: Row; children: Node[] }
const nodeOf = (row: Row, children: Node[] = []): Node => ({ row, children })
const TREES: Record<string, Node[]> = Object.fromEntries(
  TEAMS.map((t) => [
    t.lead.id,
    t.members.map((m) => (t === GATEWAY ? nodeOf(live(m), m.member === 'dev-1' ? [nodeOf(ASSISTANT)] : []) : nodeOf(m))),
  ]),
)
const ROOTS: Row[] = [...RECENT, ...TEAMS.map((t) => t.lead)]
  .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
  .sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))

const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)])
const waiting = (nodes: Node[]) => all(nodes).some((n) => n.row.question)
const working = (nodes: Node[]) => all(nodes).filter((n) => n.row.state === 'starting').length
const SHORT = (r: Row) => (r.member ? `${r.member} · ${r.title}` : r.title)

// ---------------------------------------------------------------- Agora's own list row, as it is today

const DOT: Record<string, string> = {
  starting: 'bg-primary animate-pulse',
  ready: 'bg-success',
  interrupted: 'bg-warning animate-pulse',
  lost: 'bg-destructive',
  failed: 'bg-destructive',
}

function Item({ row, active, trailing, before, indent = 0 }: { row: Row; active?: boolean; trailing?: ReactNode; before?: ReactNode; indent?: number }) {
  return (
    <div
      aria-current={active ? 'page' : undefined}
      style={{ paddingLeft: 8 + indent * 14 }}
      className={cn(
        'rounded-control flex h-8 w-full shrink-0 items-center gap-1.5 pr-2 text-left text-[13px]',
        active ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground',
      )}
    >
      {before}
      <span className="min-w-0 flex-1 truncate">{row.member ? <><span className="text-foreground/70 font-mono text-[11.5px]">{row.member}</span> {row.title}</> : row.title}</span>
      {trailing ??
        (row.question ? (
          <span className="text-primary shrink-0 text-[11px] font-medium">waiting for you</span>
        ) : (
          DOT[row.state] && <span className={cn('size-1.5 shrink-0 rounded-full', DOT[row.state])} />
        ))}
    </div>
  )
}

/** The chevron's place, in a list where some rows have one. */
const Gutter = () => <span className="size-3.5 shrink-0" />
const Chevron = ({ open }: { open: boolean }) => <ChevronRightIcon className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />

/** What a folded parent shows of its sub-streams: one waiting for you first, else how many work. */
function Summary({ nodes }: { nodes: Node[] }) {
  if (waiting(nodes)) return <span className="text-primary shrink-0 text-[11px] font-medium">waiting for you</span>
  const n = working(nodes)
  return n > 0 ? <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{n} working</span> : <span className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums">{nodes.length}</span>
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="bg-sidebar border-foreground/10 flex w-full max-w-[290px] flex-col gap-2 rounded-xl border p-3">
      <div className="border-foreground/10 bg-background rounded-control flex h-8 items-center gap-2 border px-2.5 text-[13px]">
        <PlusIcon className="size-3.5" /> New workstream
      </div>
      <div className="border-foreground/10 bg-background rounded-control text-muted-foreground flex h-8 items-center gap-2 border px-2.5 text-[13px]">
        <SearchIcon className="size-3.5" /> Search
      </div>
      <div className="-mx-1 flex flex-col">{children}</div>
    </div>
  )
}

const Label = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground mt-3 mb-1 px-2 text-xs font-medium">{children}</p>

/** The roots, Yesterday then the week before, each drawn by `draw`. */
function Roots({ draw }: { draw: (row: Row) => ReactNode }) {
  const yesterday = ROOTS.filter((r) => r.changedAt.startsWith('2026-10-31'))
  const older = ROOTS.filter((r) => !r.changedAt.startsWith('2026-10-31'))
  const others = older.filter((r) => !TREES[r.id]).slice(0, 5)
  const week = older.filter((r) => TREES[r.id] || others.includes(r))
  return (
    <>
      <Label>Yesterday</Label>
      {yesterday.map(draw)}
      <Label>Previous 7 days</Label>
      {week.map(draw)}
    </>
  )
}

// ---------------------------------------------------------------- A · nested, folded by default

function Nested({ nodes, depth, open }: { nodes: Node[]; depth: number; open: ReadonlySet<string> }) {
  return (
    <div className="border-foreground/10 ml-[15px] flex flex-col border-l" style={{ marginLeft: 15 + (depth - 1) * 14 }}>
      {nodes.map((n) => (
        <div key={n.row.id}>
          <Item
            row={n.row}
            indent={0}
            active={n.row.member === 'sre-1'}
            before={n.children.length ? <Chevron open={open.has(n.row.id)} /> : <Gutter />}
          />
          {n.children.length > 0 && open.has(n.row.id) && <Nested nodes={n.children} depth={depth + 1} open={open} />}
        </div>
      ))}
    </div>
  )
}

function SidebarNested({ open }: { open: ReadonlySet<string> }) {
  return (
    <Frame>
      <Roots
        draw={(r) => {
          const kids = TREES[r.id]
          if (!kids) return <Item key={r.id} row={r} before={<Gutter />} />
          const unfolded = open.has(r.id)
          return (
            <div key={r.id}>
              <Item row={GATEWAY.lead.id === r.id ? { ...r, state: 'ready' } : r} before={<Chevron open={unfolded} />} trailing={unfolded ? undefined : <Summary nodes={kids} />} />
              {unfolded && <Nested nodes={kids} depth={1} open={open} />}
            </div>
          )
        }}
      />
    </Frame>
  )
}

// ---------------------------------------------------------------- B · only where you are

function SidebarHere({ here }: { here: boolean }) {
  return (
    <Frame>
      <Roots
        draw={(r) => {
          const kids = TREES[r.id]
          if (!kids) return <Item key={r.id} row={r} />
          const path = here && r.id === GATEWAY.lead.id
          const chip = (
            <span className="bg-foreground/[0.06] text-muted-foreground shrink-0 rounded-full px-1.5 text-[10.5px] tabular-nums">
              {kids.length}
              {waiting(kids) ? <span className="text-primary"> ●</span> : null}
            </span>
          )
          return (
            <div key={r.id}>
              <Item row={GATEWAY.lead.id === r.id ? { ...r, state: 'ready' } : r} trailing={path ? undefined : chip} />
              {path && (
                <div className="border-foreground/10 ml-[15px] flex flex-col border-l">
                  {kids.map((n) => (
                    <Item key={n.row.id} row={n.row} active={n.row.member === 'sre-1'} />
                  ))}
                </div>
              )}
            </div>
          )
        }}
      />
    </Frame>
  )
}

// ---------------------------------------------------------------- C · step into a tree

function SidebarInside() {
  const kids = TREES[GATEWAY.lead.id]!
  return (
    <Frame>
      <div className="text-muted-foreground mt-2 flex h-8 items-center gap-1.5 px-2 text-[13px]">
        <ArrowLeftIcon className="size-3.5" /> All workstreams
      </div>
      <p className="font-brand m-0 mt-1 px-2 text-[15px] leading-snug">{GATEWAY.lead.title}</p>
      <p className="text-muted-foreground m-0 mb-1 px-2 text-[11px]">8 sub-streams · its lead first</p>
      <Item row={{ ...GATEWAY.lead, member: 'lead', state: 'ready' }} />
      {kids.map((n) => (
        <Item
          key={n.row.id}
          row={n.row}
          active={n.row.member === 'sre-1'}
          trailing={n.children.length ? <span className="text-muted-foreground flex shrink-0 items-center text-[11px]">{n.children.length}<ChevronRightIcon className="size-3" /></span> : undefined}
        />
      ))}
    </Frame>
  )
}

function SidebarStep() {
  return (
    <Frame>
      <Roots
        draw={(r) => {
          const kids = TREES[r.id]
          return (
            <Item
              key={r.id}
              row={GATEWAY.lead.id === r.id ? { ...r, state: 'ready' } : r}
              trailing={
                kids ? (
                  <span className={cn('flex shrink-0 items-center text-[11px] tabular-nums', waiting(kids) ? 'text-primary font-medium' : 'text-muted-foreground')}>
                    {waiting(kids) ? 'waiting' : kids.length}
                    <ChevronRightIcon className="size-3" />
                  </span>
                ) : undefined
              }
            />
          )
        }}
      />
    </Frame>
  )
}

// ---------------------------------------------------------------- in the parent's thread

const member = (name: string) => TREES[GATEWAY.lead.id]!.find((n) => n.row.member === name)!.row

function LeadSays({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-2.5">
      <p className="m-0 text-[14px] leading-relaxed">{children}</p>
    </div>
  )
}

const Open = () => (
  <span className="text-foreground/80 hover:bg-foreground/[0.05] rounded-md border px-2 py-0.5 text-[12px]">Open</span>
)

function Cards() {
  const dev = member('dev-1'),
    sre = member('sre-1'),
    judge = member('judge-3')
  return (
    <LeadSays>
      I hand the merge to dev-1 and the infra change to sre-1; the judge checks each when they are done.
      <span className="mt-2.5 flex flex-col gap-2">
        <TaskCard label={dev.title} meta="dev-1" state="working" elapsed="4m" actions={<Open />} />
        <TaskCard label={sre.title} meta="sre-1" state="waiting" elapsed="1m" actions={<Open />} />
        <TaskCard label={judge.title} meta="judge-3" state="done" elapsed="6m" result={<span className="text-[13px]">Ship: every check passed, evidence in the PR status.</span>} actions={<Open />} />
      </span>
    </LeadSays>
  )
}

function Lines() {
  return (
    <div className="flex w-full flex-col gap-2">
      <p className="m-0 text-[14px] leading-relaxed">…the lead talks with you; above the composer, its sub-streams:</p>
      <div className="flex flex-wrap gap-1.5">
        <AgentStatus state="working" label="dev-1 · merge with main" elapsed="4m" />
        <AgentStatus state="waiting" label="sre-1 · infra-k8s #301" trailing={<span className="text-primary px-1.5 text-[11px] font-medium whitespace-nowrap">for you</span>} />
        <AgentStatus state="done" label="judge-3 · ship" />
        <AgentStatus state="working" label="assistant · changelog" elapsed="1m" />
      </div>
      <div className="border-foreground/15 text-muted-foreground mt-1 w-full rounded-xl border px-3 py-2.5 text-[13px]">Write to the agent…</div>
    </div>
  )
}

function Progress() {
  const kids = TREES[GATEWAY.lead.id]!
  const done = kids.filter((n) => n.row.member!.startsWith('judge'))
  const rest = kids.filter((n) => !done.includes(n))
  return (
    <SubagentList
      agents={[...done, ...rest].map((n) => ({ name: n.row.member!, model: n.row.harness ?? '' }))}
      completedCount={done.length}
      progress={[...done.map(() => 100), ...rest.map((n) => (n.row.question ? 70 : 40))]}
      showSummary
      summaryAgent={{ name: 'lead', model: GATEWAY.lead.harness ?? '' }}
    />
  )
}

// ---------------------------------------------------------------- the page

export function TreePreview() {
  const gatewayOpen = new Set([GATEWAY.lead.id])
  const deeper = new Set([GATEWAY.lead.id, member('dev-1').id])
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-14 px-4 py-10 md:px-8">
      <header className="flex flex-col gap-4">
        <p className="font-brand m-0 text-lg">Agora</p>
        <h1 className="font-brand m-0 text-4xl font-medium tracking-tight">Sub-streams: the sidebar and the thread</h1>
        <p className="text-muted-foreground m-0 max-w-3xl text-[15px] leading-relaxed">
          A sub-stream is a Workstream an agent started from another: it knows its parent, its root and its depth. Every frame uses your own list and your
          three team runs as production holds them on 1 November 2026, the {TEAMS.reduce((n, t) => n + t.members.length, 0)} members placed under their
          lead from Prefect’s runs. Nothing runs today, so the live states of “{GATEWAY.lead.title}” are made up to show what reaches the top — dev-1
          working, sre-1 waiting for you — and so is dev-1’s own sub-stream, two levels down: no team went that deep.
        </p>
        <p className="text-muted-foreground m-0 max-w-3xl text-[15px] leading-relaxed">
          assistant-ui’s thread list is flat (0.15.32: items, archive, no nesting), so the sidebar is Agora’s own in every option, drawn with today’s rows.
          Inside a thread, assistant-ui’s elements do render sub-agents: the second section shows them, unmodified. <span className="text-primary">★</span> marks
          the one I suggest.
        </p>
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {[['sidebar', '1 · Find a sub-stream in the sidebar'], ['thread', '2 · See them in their parent'], ['inside', '3 · Know where you are']].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="hover:bg-muted rounded-full border px-3 py-1 no-underline">{label}</a>
          ))}
          <a href="?page=team" className="text-muted-foreground hover:bg-muted rounded-full px-3 py-1">Earlier: the team-view catalogue</a>
        </nav>
      </header>

      <Need
        id="sidebar"
        title="1 · Find a sub-stream in the sidebar"
        mechanism={<>The list holds roots only, newest first, as today. What differs is where a root’s sub-streams appear, and what a folded root tells you: a sub-stream waiting for you always shows on its root.</>}
      >
        <Option name="Nested, folded by default" kind="agora" star
          gives="Your own description: a Workstream holds its sub-streams, folded until you open it; depth reads as indentation; whatever waits for you shows on the folded root."
          lacks="A long team (14 members) pushes the rest of the list down while unfolded; three levels deep, titles get short on a phone.">
          <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-2">
            <State label="folded"><SidebarNested open={new Set()} /></State>
            <State label="unfolded, then dev-1"><SidebarNested open={deeper} /></State>
          </div>
        </Option>
        <Option name="Only where you are" kind="agora"
          gives="The list stays as calm as today: a count on each parent, and the sub-streams of the Workstream you are in unfold by themselves."
          lacks="To reach a sub-stream elsewhere, you open its root first; deeper levels need the thread (section 2) or a step in.">
          <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-2">
            <State label="nothing open"><SidebarHere here={false} /></State>
            <State label="sre-1 open"><SidebarHere here /></State>
          </div>
        </Option>
        <Option name="Step into a tree" kind="agora"
          gives="Each level gets the whole column, titles in full, any depth: a parent’s chevron replaces the list with its sub-streams, a row leads back. Natural on a phone."
          lacks="One more tap, and you lose sight of the rest of the list while inside a tree." wide>
          <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2">
            <State label="the list"><SidebarStep /></State>
            <State label="inside “Gateway 1.6.0”"><SidebarInside /></State>
          </div>
        </Option>
      </Need>

      <Need
        id="thread"
        title="2 · See sub-streams in their parent"
        mechanism={<>Where an agent started a sub-stream, its parent’s thread can show it with assistant-ui’s own elements: each takes props, so Agora maps a sub-stream’s row (title, state, time, last answer) onto them. Clicking through opens the sub-stream.</>}
      >
        <Option name="Task card where it started" kind="props" item="@assistant-ui/elements-task-card" doc="/elements/task-card" star
          gives="The sub-stream sits in the conversation at the moment it was started, with its state and time; done, its last answer shows; Open goes to it."
          lacks="Started long ago, it is far up the thread: the cards alone do not tell you, at the bottom, that one waits for you.">
          <Cards />
        </Option>
        <Option name="Status lines above the composer" kind="props" item="@assistant-ui/elements-agent-status" doc="/elements/agent-status"
          gives="Always in view while you talk to the lead: what works, what waits for you, what is done, at any depth."
          lacks="No content: only a label and a state; the conversation keeps no trace of when each was started.">
          <Lines />
        </Option>
        <Option name="Sub-agent list" kind="props" item="@assistant-ui/elements-subagent-list" doc="/elements/subagent-list"
          gives="The whole team at a glance, with progress and the lead’s summary at its foot."
          lacks="Made for a fixed set run once; Agora’s sub-streams come and go, and progress is a number Agora does not have." wide>
          <Progress />
        </Option>
      </Need>

      <Need
        id="inside"
        title="3 · Know where you are"
        mechanism={<>Inside a sub-stream, the header names its line of parents; each opens. Writing there talks to that agent directly, as in any Workstream.</>}
      >
        <Option name="The line of parents in the header" kind="agora" star
          gives="Where you are and the way back, at any depth, in the bar you already read."
          lacks="Long titles: each parent is cut short; the full title is its tooltip." wide>
          <div className="bg-background border-foreground/10 flex h-12 w-full items-center gap-1.5 rounded-xl border px-4 text-[13px]">
            <span className="text-muted-foreground max-w-[30%] truncate">{GATEWAY.lead.title}</span>
            <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-muted-foreground font-mono text-[12px]">dev-1</span>
            <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate font-medium">{ASSISTANT.title}</span>
            <span className="bg-primary ml-1 size-1.5 shrink-0 animate-pulse rounded-full" />
            <span className="text-muted-foreground ml-auto shrink-0 text-[12px]">claude-code · working</span>
          </div>
        </Option>
      </Need>
      <footer className="text-muted-foreground border-t pt-4 text-[12.5px]">
        Data: listings and Prefect runs read from production on 1 November 2026 (members are uuid5 of “run/member”; 24 of the agents folder’s 33 match a run, the other
        9 are judge replays and access checks). {SHORT(member('sre-1'))}: made up waiting, as dev-1 working and its sub-stream.
      </footer>
    </main>
  )
}

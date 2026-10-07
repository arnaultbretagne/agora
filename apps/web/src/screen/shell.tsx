// The frame (docs/specs/assistant-ui.md, "The screen"), as assistant-ui's base skin builds it: a 3rem
// bar across, the Workstreams on the left under the brand, the open one on the right under its title.
// On a phone (docs/specs/assistant-ui.md, "On a phone") it fills what the keyboard leaves and keeps
// clear of the screen's edges. The browser colours its bars after the fixed or sticky element it finds
// at each edge (WebKit's LocalFrameView::fixedContainerEdges): that element's background, read on every
// frame, unless it covers the whole screen, as the frame does, whose first colour it keeps for good. So
// each edge has an element of its own in the theme's colour: the header at the top, a strip at the bottom.
import { MenuIcon, MoonIcon, PanelLeftIcon, PlusIcon, PowerIcon, SearchIcon, SunIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type FC } from 'react'
import { ShimmerLabel } from '@/components/assistant-ui/elements/surfaces'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { harnessName, sections, type WorkstreamState, type WorkstreamView } from '../agora/view.ts'
import { BrandMark, Wordmark } from './brand.tsx'
import { Thread } from './thread.tsx'
import { useVisualViewport } from './viewport.ts'

const iconButton = 'text-muted-foreground hover:text-foreground rounded-control grid size-7 shrink-0 place-items-center transition-colors'

// ---------------------------------------------------------------- the theme

type Theme = 'light' | 'dark'
const THEME_KEY = 'agora:theme'
const systemTheme = (): Theme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
const storedTheme = (): Theme | null => {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : null
  } catch {
    return null
  }
}

/** The system's theme, until the user picks one; then theirs, remembered. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme())
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // A phone's status bar takes this colour: the theme's, which may not be the system's.
    const background = getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', background)
  }, [theme])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const follow = () => storedTheme() === null && setTheme(systemTheme())
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [])
  const toggle = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        // For this page only.
      }
      return next
    })
  return [theme, toggle]
}

// ---------------------------------------------------------------- the list

const DOT: Partial<Record<WorkstreamState, string>> = {
  starting: 'bg-primary animate-pulse',
  ready: 'bg-success',
  interrupted: 'bg-warning animate-pulse',
  lost: 'bg-destructive',
  failed: 'bg-destructive',
}

const Item: FC<{ w: WorkstreamView; active: boolean; onOpen: () => void }> = ({ w, active, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    title={`${harnessName(w.harness)} · ${w.state}`}
    aria-current={active ? 'page' : undefined}
    className={cn(
      'rounded-control flex h-8 w-full shrink-0 items-center gap-2 px-2 text-left text-[13px] transition-colors',
      active ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
    )}
  >
    <span className="min-w-0 flex-1 truncate">{w.title}</span>
    {DOT[w.state] && <span aria-label={w.state} className={cn('size-1.5 shrink-0 rounded-full', DOT[w.state])} />}
  </button>
)

const Sidebar: FC<{ onNavigate: () => void }> = ({ onNavigate }) => {
  const { workstreams, id, open } = useAgora()
  const [search, setSearch] = useState('')
  const groups = useMemo(() => sections(workstreams, new Date(), search, id), [workstreams, search, id])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            open(null)
            onNavigate()
          }}
          className="border-foreground/10 bg-background hover:border-foreground/25 rounded-control flex h-8 w-full items-center gap-2 border px-2.5 text-[13px] transition-colors"
        >
          <PlusIcon className="size-3.5" />
          New workstream
        </button>
        <label className="border-foreground/10 bg-background focus-within:border-foreground/25 rounded-control flex h-8 items-center gap-2 border px-2.5">
          <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search the workstreams"
            // 16 px on a touch screen: under that, iOS zooms the page in to type.
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none pointer-coarse:text-base"
          />
        </label>
      </div>
      <nav aria-label="Workstreams" className="-mx-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {groups.length === 0 && <p className="text-muted-foreground mt-5 px-2 text-[13px]">{search.trim() ? 'No workstream found' : 'No workstream yet'}</p>}
        {groups.map((g) => (
          <section key={g.label}>
            <p className="text-muted-foreground mt-5 mb-1 px-2 text-xs font-medium">{g.label}</p>
            <div className="flex flex-col gap-0.5">
              {g.workstreams.map((w) => (
                <Item
                  key={w.id}
                  w={w}
                  active={w.id === id}
                  onOpen={() => {
                    open(w.id)
                    onNavigate()
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </nav>
    </div>
  )
}

// ---------------------------------------------------------------- the bar

const STATE_LABEL: Partial<Record<WorkstreamState, string>> = {
  starting: 'starting',
  ready: 'ready',
  interrupted: 'reconnecting',
  stopped: 'stopped',
  lost: 'lost',
  failed: 'failed',
  ended: 'ended',
}

const Title: FC = () => {
  const { id, view, pending, send, connection } = useAgora()
  const stoppable = view.execution !== null && ['starting', 'ready', 'interrupted', 'lost'].includes(view.state)
  if (id === null) return <span className="min-w-0 flex-1 truncate text-[13px] font-medium">New workstream</span>
  const state = pending ? 'starting' : view.state
  return (
    <>
      <span className="min-w-0 truncate text-[13px] font-medium">{pending ? pending.text.split('\n')[0] : view.title}</span>
      {STATE_LABEL[state] && (
        <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[12px]">
          {/* On a phone the title needs the room; the composer shows the harness. */}
          <span aria-hidden className="max-sm:hidden">·</span>
          <span className="max-sm:hidden">{harnessName(pending?.harness ?? view.harness)}</span>
          <span aria-hidden>·</span>
          {state === 'starting' || state === 'interrupted' ? (
            <ShimmerLabel data-state={state}>{STATE_LABEL[state]}</ShimmerLabel>
          ) : (
            <span data-state={state}>{STATE_LABEL[state]}</span>
          )}
        </span>
      )}
      <span className="flex-1" />
      {connection === 'offline' && <ShimmerLabel className="text-muted-foreground shrink-0 font-mono text-[11px]">reconnecting to the server</ShimmerLabel>}
      {stoppable && (
        <button
          type="button"
          aria-label="Stop"
          title="Stop the sandbox: it ends at its deadline, its files saved"
          onClick={() => void send('Stop', { execution: view.execution }, {})}
          className="text-muted-foreground hover:text-foreground rounded-control flex h-7 shrink-0 items-center gap-1.5 px-2 text-[13px] transition-colors max-sm:-me-1"
        >
          <PowerIcon className="size-3.5" />
          <span className="max-sm:hidden">Stop</span>
        </button>
      )}
    </>
  )
}

export const Shell: FC = () => {
  const { id } = useAgora()
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [theme, toggleTheme] = useTheme()
  useVisualViewport()
  return (
    <div
      className={cn(
        'bg-background fixed inset-x-0 top-(--viewport-top) grid h-(--viewport-height) grid-rows-[calc(3rem+env(safe-area-inset-top))_minmax(0,1fr)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        collapsed ? 'md:grid-cols-[minmax(0,1fr)]' : 'md:grid-cols-[16rem_minmax(0,1fr)]',
      )}
    >
      <div className={cn('bg-sidebar border-foreground/10 hidden items-center gap-2.5 border-r border-b px-4 pt-[env(safe-area-inset-top)]', !collapsed && 'md:flex')}>
        <BrandMark className="size-5" />
        <Wordmark />
        <button type="button" onClick={() => setCollapsed(true)} aria-label="Hide the workstreams" className={cn(iconButton, 'ms-auto -me-1.5')}>
          <PanelLeftIcon className="size-4" />
        </button>
      </div>
      <header className="border-foreground/10 bg-background sticky top-0 flex min-w-0 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top)] md:px-5">
        <button type="button" onClick={() => setDrawer(true)} aria-label="Show the workstreams" className={cn(iconButton, '-ms-1.5 md:hidden')}>
          <MenuIcon className="size-4" />
        </button>
        {collapsed && (
          <button type="button" onClick={() => setCollapsed(false)} aria-label="Show the workstreams" className={cn(iconButton, '-ms-1.5 hidden md:grid')}>
            <PanelLeftIcon className="size-4" />
          </button>
        )}
        <Title />
        <button type="button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} className={cn(iconButton, '-me-1.5')}>
          {theme === 'dark' ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
        </button>
      </header>
      <aside className={cn('bg-sidebar border-foreground/10 hidden min-h-0 flex-col overflow-hidden border-r p-3 pb-[max(0.75rem,var(--safe-bottom))]', !collapsed && 'md:flex')}>
        <Sidebar onNavigate={() => undefined} />
      </aside>
      <main className="min-h-0 min-w-0">
        <Thread key={id ?? 'draft'} />
      </main>
      <div aria-hidden className="bg-background fixed inset-x-0 bottom-0 z-30 h-[max(11px,var(--safe-bottom))] md:hidden" />
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close" className="bg-foreground/20 absolute inset-0" onClick={() => setDrawer(false)} />
          <div className="bg-sidebar border-foreground/10 absolute inset-y-0 left-0 flex w-[calc(18rem+env(safe-area-inset-left))] flex-col gap-3 border-r p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,var(--safe-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]">
            <div className="flex h-9 items-center gap-2.5 px-1">
              <BrandMark className="size-5" />
              <Wordmark />
            </div>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

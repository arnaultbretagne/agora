// The access picker (docs/specs/assistant-ui.md, "Access"): a key alone on the composer, and a panel of the
// rights the agent is given beyond its harness's own service — the services, the Internet first, each on or
// off; then each offered repository, with None, Read and, when offered, Review and Write.
// Three mock-ups of the panel, for the person to pick one on the preview: the strip at the panel's top
// switches between them, and `?access=a|b|c` opens the page on one.
import { BanIcon, CheckIcon, ChevronRightIcon, EyeIcon, GitBranchIcon, GlobeIcon, KeyRoundIcon, MessageSquareTextIcon, PencilIcon, type LucideIcon } from 'lucide-react'
import { DropdownMenu, Popover } from 'radix-ui'
import { useState, type FC, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { accessDisplay, accessEntries, accessOf, accessTitle, INTERNET, type AccessEntry } from '../agora/view.ts'
import { below, fitted, fittedPanel, iconButton, menuContentClass, menuItemClass } from './picker.ts'

type Choose = (entry: AccessEntry, profile: string | null) => void

const MOCKUPS = [
  { id: 'a', name: 'Sheet' },
  { id: 'b', name: 'Chips' },
  { id: 'c', name: 'Menu' },
] as const
type Mockup = (typeof MOCKUPS)[number]['id']
const MOCKUP_KEY = 'agora.access-mockup'

function initialMockup(): Mockup {
  const asked = new URLSearchParams(location.search).get('access') ?? localStorage.getItem(MOCKUP_KEY)
  return MOCKUPS.find((m) => m.id === asked)?.id ?? 'a'
}

/** The key alone; its name and its tooltip say what is granted. */
export const AccessPicker: FC = () => {
  const { offered, access, chooseAccess, composer, view } = useAgora()
  const [open, setOpen] = useState(false)
  const [mockup, setMockup] = useState<Mockup>(initialMockup)
  const all = accessEntries(offered)
  if (all.length === 0) return null
  const entries = accessDisplay(all)
  const closed = !composer.create && (composer.running || composer.uncertain !== null || view.state === 'stopped' || view.state === 'lost')
  const title = accessTitle(access, all)
  const granted = all.some((entry) => accessOf(access, entry) !== null)
  const choose: Choose = (entry, profile) => chooseAccess(all, entry, profile)
  const trigger = (
    <button type="button" aria-label={`Access: ${title}`} title={title} disabled={closed} className={iconButton}>
      {/* The key alone: coral once anything is granted. */}
      <KeyRoundIcon className={cn('size-4', granted && 'text-primary')} />
    </button>
  )
  const strip = (
    <MockupStrip
      current={mockup}
      onPick={(m) => {
        localStorage.setItem(MOCKUP_KEY, m)
        setMockup(m)
      }}
    />
  )
  const panel = { entries, access, choose, strip }
  if (mockup === 'c')
    return (
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content {...below} aria-label="Access" className={cn(menuContentClass, fitted, 'w-72')}>
            <MenuPanel {...panel} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...below}
          role="dialog"
          aria-label="Access"
          className={cn(menuContentClass, fittedPanel, 'w-[22rem] p-0')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {mockup === 'a' ? <SheetPanel {...panel} /> : <ChipsPanel {...panel} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

interface PanelProps {
  readonly entries: readonly AccessEntry[]
  readonly access: readonly string[]
  readonly choose: Choose
  readonly strip: ReactNode
}

/** Which mock-up shows: one button each, the current one pressed. */
const MockupStrip: FC<{ current: Mockup; onPick: (m: Mockup) => void }> = ({ current, onPick }) => (
  <div role="group" aria-label="Mock-up" className="bg-muted/60 border-foreground/10 flex items-center gap-1 border-b px-2 py-1.5 text-[11px]">
    <span className="text-muted-foreground mr-auto font-medium">Mock-up</span>
    {MOCKUPS.map((m) => (
      <button
        key={m.id}
        type="button"
        aria-pressed={m.id === current}
        onClick={() => onPick(m.id)}
        className={cn('rounded-full px-2 py-0.5 transition-colors pointer-coarse:py-1.5', m.id === current ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
      >
        {m.id.toUpperCase()} · {m.name}
      </button>
    ))}
  </div>
)

const services = (entries: readonly AccessEntry[]) => entries.filter((e) => !e.repository)
const repositories = (entries: readonly AccessEntry[]) => entries.filter((e) => e.repository)
const onProfile = (entry: AccessEntry) => entry.choices.at(-1)!.profile
/** A repository's name, its owner quieter. */
const RepoName: FC<{ name: string }> = ({ name }) => {
  const [owner, repo] = name.split('/')
  return (
    <span className="min-w-0 truncate">
      <span className="text-muted-foreground">{owner}/</span>
      {repo}
    </span>
  )
}

/** A switch, itself the control. */
const Switch: FC<{ on: boolean; label: string; onChange: (on: boolean) => void }> = ({ on, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={() => onChange(!on)}
    className={cn('relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors', on ? 'bg-primary' : 'bg-foreground/20')}
  >
    <span className={cn('bg-primary-foreground absolute top-0.5 size-3 rounded-full shadow-sm transition-transform', on ? 'translate-x-3.5' : 'translate-x-0.5')} />
  </button>
)

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="px-3 py-2">
    <h3 className="text-muted-foreground pb-1 text-[11px] font-medium">{title}</h3>
    {children}
  </section>
)

/**
 * A · Sheet: a settings panel. Two sections, every choice in sight: each service a line with its switch,
 * each repository a line with its levels side by side, in words.
 */
const SheetPanel: FC<PanelProps> = ({ entries, access, choose, strip }) => (
  <div className="flex flex-col text-[13px]">
    {strip}
    {services(entries).length > 0 && (
      <Section title="Services">
        {services(entries).map((e) => {
          const on = accessOf(access, e) !== null
          return (
            <div key={e.key} className="flex h-8 items-center justify-between gap-4">
              <span className="flex items-center gap-2">
                {e.key === INTERNET && <GlobeIcon className="text-muted-foreground size-3.5" />}
                {e.name}
              </span>
              <Switch on={on} label={e.name} onChange={(v) => choose(e, v ? onProfile(e) : null)} />
            </div>
          )
        })}
      </Section>
    )}
    {repositories(entries).length > 0 && (
      <Section title="Repositories">
        {repositories(entries).map((e) => {
          const current = accessOf(access, e)
          return (
            <div key={e.key} className="flex min-h-8 items-center justify-between gap-3 py-0.5">
              <RepoName name={e.name} />
              <div role="radiogroup" aria-label={e.name} className="bg-muted flex shrink-0 rounded-full p-0.5">
                {e.choices.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    role="radio"
                    aria-checked={c.profile === current}
                    onClick={() => choose(e, c.profile)}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[12px] transition-colors pointer-coarse:py-1.5',
                      c.profile === current ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </Section>
    )}
  </div>
)

const LEVEL_ICONS: Record<string, LucideIcon> = { None: BanIcon, Read: EyeIcon, Review: MessageSquareTextIcon, Write: PencilIcon }

/**
 * B · Chips: what is on, at a glance. The services as chips that light up; each repository a line with its
 * levels as icons, named in their tooltips, the level picked spelled out beside them.
 */
const ChipsPanel: FC<PanelProps> = ({ entries, access, choose, strip }) => (
  <div className="flex flex-col text-[13px]">
    {strip}
    {services(entries).length > 0 && (
      <div role="group" aria-label="Services" className="flex flex-wrap gap-1.5 px-3 pt-3 pb-2">
        {services(entries).map((e) => {
          const on = accessOf(access, e) !== null
          return (
            <button
              key={e.key}
              type="button"
              aria-pressed={on}
              onClick={() => choose(e, on ? null : onProfile(e))}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors pointer-coarse:h-9',
                on ? 'bg-primary/10 border-primary/40 text-foreground' : 'border-foreground/15 text-muted-foreground hover:text-foreground',
              )}
            >
              {on ? <CheckIcon className="text-primary size-3.5" /> : e.key === INTERNET ? <GlobeIcon className="size-3.5" /> : null}
              {e.name}
            </button>
          )
        })}
      </div>
    )}
    {repositories(entries).length > 0 && (
      <ul aria-label="Repositories" className="border-foreground/10 flex flex-col border-t px-3 py-2">
        {repositories(entries).map((e) => {
          const current = accessOf(access, e)
          const label = e.choices.find((c) => c.profile === current)!.label
          return (
            <li key={e.key} className="flex min-h-9 items-center gap-2">
              <GitBranchIcon className={cn('size-3.5 shrink-0', current === null ? 'text-muted-foreground' : 'text-primary')} />
              <RepoName name={e.name} />
              <span className={cn('ml-auto shrink-0 text-[11px]', current === null ? 'text-muted-foreground' : 'text-primary')}>{label}</span>
              <div role="radiogroup" aria-label={e.name} className="flex shrink-0 gap-0.5">
                {e.choices.map((c) => {
                  const Icon = LEVEL_ICONS[c.label] ?? CheckIcon
                  const on = c.profile === current
                  return (
                    <button
                      key={c.label}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={c.label}
                      title={c.label}
                      onClick={() => choose(e, c.profile)}
                      className={cn(
                        'grid size-7 place-items-center rounded-md transition-colors pointer-coarse:size-9',
                        on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                    </button>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ul>
    )}
  </div>
)

/**
 * C · Menu: a plain menu, one line per right with its value at the end. A service is ticked on and off where
 * it is; a repository opens its levels beside it.
 */
const MenuPanel: FC<PanelProps> = ({ entries, access, choose, strip }) => (
  <>
    <div className="-mx-1 -mt-1 mb-1">{strip}</div>
    {services(entries).map((e) => {
      const on = accessOf(access, e) !== null
      return (
        <DropdownMenu.CheckboxItem
          key={e.key}
          checked={on}
          onCheckedChange={(checked) => choose(e, checked ? onProfile(e) : null)}
          onSelect={(event) => event.preventDefault()}
          className={cn(menuItemClass, 'items-center')}
        >
          <CheckIcon className={cn('size-3.5 shrink-0', on ? 'opacity-100' : 'opacity-0')} />
          <span>{e.name}</span>
        </DropdownMenu.CheckboxItem>
      )
    })}
    {services(entries).length > 0 && repositories(entries).length > 0 && <DropdownMenu.Separator className="bg-foreground/10 my-1 h-px" />}
    {repositories(entries).map((e) => {
      const current = accessOf(access, e)
      const label = e.choices.find((c) => c.profile === current)!.label
      return (
        <DropdownMenu.Sub key={e.key}>
          <DropdownMenu.SubTrigger className={cn(menuItemClass, 'items-center data-[state=open]:bg-muted')}>
            <span className="size-3.5 shrink-0" />
            <RepoName name={e.name} />
            <span className={cn('ml-auto pl-4 text-[12px]', current === null ? 'text-muted-foreground' : 'text-primary')}>{label}</span>
            <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent sideOffset={4} collisionPadding={8} className={cn(menuContentClass, 'min-w-36')}>
              <DropdownMenu.RadioGroup aria-label={e.name} value={current ?? ''} onValueChange={(value) => choose(e, value === '' ? null : value)}>
                {e.choices.map((c) => (
                  <DropdownMenu.RadioItem key={c.label} value={c.profile ?? ''} onSelect={(event) => event.preventDefault()} className={menuItemClass}>
                    <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', c.profile === current ? 'opacity-100' : 'opacity-0')} />
                    <span>{c.label}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )
    })}
  </>
)

import type { ThreadMessageLike } from '@assistant-ui/react'
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, SkipBackIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from 'react'
import { TaskTray } from '@/components/assistant-ui/elements/agent-status.aui'
import { BackgroundInbox } from '@/components/assistant-ui/elements/background-inbox'
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { RAW, RUN_ID } from '@/data/run'
import { ACCESS_STEP, LAST_STEP, PLAN_STEP, STEPS, agentsAt, buildThread, type Answers, type PlanAnswer } from '@/data/timeline'
import { StaticRuntime } from '@/team/runtime'
import { LANES_COMPONENTS, LIST_COMPONENTS, PLAIN_COMPONENTS } from '@/team/thread-parts'
import { ApprovalVariantContext, LANES_CONFIG, LIST_CONFIG, type ApprovalVariant } from '@/team/tools'

type Tab = 'lead' | 'list' | 'agents' | 'today'

const TABS: { id: Tab; label: string; caption: ReactNode }[] = [
  {
    id: 'lead',
    label: 'Lead thread',
    caption: (
      <>
        <Code>Thread</Code> with <Code>TaskGroup</Code> lanes (<Code>start</Code>/<Code>verify</Code> carry <Code>ToolCallMessagePart.messages</Code>, opened read-only), <Code>Approval card</Code> or{' '}
        <Code>Permission grant</Code>, <Code>Speaker identity</Code> report rows, <Code>Tool group</Code>, <Code>Agent status</Code> (its <Code>TaskTray</Code>), <Code>Agent plan</Code> — in Agora: the lead's Workstream, the one you talk to.
      </>
    ),
  },
  {
    id: 'list',
    label: 'Subagent list',
    caption: (
      <>
        <Code>Subagent list</Code> under each lead message, <Code>start</Code>/<Code>verify</Code> registered with <Code>render: () =&gt; null</Code> — in Agora: the same thread with members as progress rows; no transcript to open, no failed state.
      </>
    ),
  },
  {
    id: 'agents',
    label: 'Agents folder',
    caption: (
      <>
        <Code>Background runs</Code> (<Code>BackgroundInbox</Code>, props-driven) — in Agora: the Agents folder, one row per member Workstream; running and finished-unread from turn state, failed from Agora's own bookkeeping.
      </>
    ),
  },
  {
    id: 'today',
    label: 'Today',
    caption: (
      <>
        <Code>Thread</Code>, default slots — in Agora today: the flow injects each decision prompt as a user bubble, and the lead answers with one raw JSON line (run {RUN_ID}, decisions 2 and 3).
      </>
    ),
  },
]

function Code({ children }: { children: ReactNode }) {
  return <code className="bg-foreground/[0.05] rounded px-1 py-px font-mono text-[11px]">{children}</code>
}

type HashState = { tab: Tab; step: number; approval: ApprovalVariant }

const readHash = (): HashState => {
  const p = new URLSearchParams(location.hash.slice(1))
  const tab = (['lead', 'list', 'agents', 'today'] as const).find((t) => t === p.get('tab')) ?? 'lead'
  const step = Number(p.get('step'))
  return {
    tab,
    step: Number.isInteger(step) && p.has('step') && step >= 0 && step <= LAST_STEP ? step : LAST_STEP,
    approval: p.get('approval') === 'grant' ? 'grant' : 'card',
  }
}

export function App() {
  const initial = useMemo(readHash, [])
  const [tab, setTab] = useState<Tab>(initial.tab)
  const [step, setStepRaw] = useState(initial.step)
  const [variant, setVariant] = useState<ApprovalVariant>(initial.approval)
  const [answers, setAnswers] = useState<Answers>({})
  const [playing, setPlaying] = useState(false)

  const setStep = useCallback((next: number) => {
    const s = Math.max(0, Math.min(LAST_STEP, next))
    setStepRaw(s)
    // An answer belongs to the moment it was given: going back before it asks again.
    setAnswers((a) => ({ plan: s === PLAN_STEP ? a.plan : undefined, access: s <= ACCESS_STEP ? undefined : a.access }))
  }, [])

  useEffect(() => {
    history.replaceState(null, '', `#tab=${tab}&step=${step}&approval=${variant}`)
  }, [tab, step, variant])

  useEffect(() => {
    if (!playing) return
    if (step >= LAST_STEP) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setStep(step + 1), 2200)
    return () => clearTimeout(id)
  }, [playing, step, setStep])

  const onAnswer = useCallback(
    (approvalId: string, optionId: string | undefined) => {
      if (approvalId === 'approval-plan' && step === PLAN_STEP) {
        const plan = (optionId ?? 'approve') as PlanAnswer
        if (plan === 'approve') setStep(PLAN_STEP + 1)
        else setAnswers((a) => ({ ...a, plan }))
      }
      if (approvalId === 'approval-access' && step === ACCESS_STEP) {
        const access = optionId === 'session' || optionId === 'always' ? optionId : 'denied'
        setStepRaw(ACCESS_STEP + 1)
        setAnswers((a) => ({ ...a, access }))
      }
    },
    [step, setStep],
  )

  const current = TABS.find((t) => t.id === tab)!

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-(--viewport-height) flex-col overflow-hidden">
        <header className="border-border/70 shrink-0 border-b">
          <div className="flex h-11 items-center gap-2.5 px-4">
            <span className="font-brand text-[19px] leading-none font-medium tracking-tight">Agora</span>
            <span className="text-muted-foreground truncate text-xs">team view · judging assistant-ui's multi-agent elements</span>
            <span className="text-muted-foreground ms-auto hidden font-mono text-[11px] sm:inline">run {RUN_ID} · replay</span>
          </div>
          <nav role="tablist" aria-label="Views" className="-mb-px flex gap-1 overflow-x-auto px-3 [scrollbar-width:none]">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={t.id === tab}
                onClick={() => setTab(t.id)}
                className={cn(
                  'shrink-0 border-b-2 px-2.5 pt-1 pb-2 text-[13px] font-medium whitespace-nowrap transition-colors',
                  t.id === tab ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>

        <Caption key={tab}>{current.caption}</Caption>

        {tab !== 'today' && (
          <Stepper step={step} setStep={setStep} playing={playing} setPlaying={setPlaying}>
            {tab === 'lead' && <VariantSwitch value={variant} onChange={setVariant} />}
          </Stepper>
        )}

        <main className="min-h-0 flex-1">
          <ApprovalVariantContext.Provider value={variant}>
            {tab === 'lead' && <TeamThread mode="lanes" step={step} answers={answers} onAnswer={onAnswer} />}
            {tab === 'list' && <TeamThread mode="list" step={step} answers={answers} onAnswer={onAnswer} />}
            {tab === 'agents' && <AgentsFolder step={step} answers={answers} />}
            {tab === 'today' && <Today />}
          </ApprovalVariantContext.Provider>
        </main>
      </div>
    </TooltipProvider>
  )
}

const Caption: FC<{ children: ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false)
  return (
    <div data-slot="caption" className="border-border/70 shrink-0 border-b px-4 py-2">
      <p
        onClick={() => setOpen((o) => !o)}
        className={cn('text-muted-foreground text-xs leading-5 sm:line-clamp-none', !open && 'line-clamp-2 cursor-pointer')}
      >
        {children}
      </p>
    </div>
  )
}

const Stepper: FC<{ step: number; setStep: (s: number) => void; playing: boolean; setPlaying: (p: boolean) => void; children?: ReactNode }> = ({
  step,
  setStep,
  playing,
  setPlaying,
  children,
}) => {
  const btn = 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-full disabled:opacity-35 disabled:hover:bg-transparent'
  return (
    <div data-slot="stepper" className="border-border/70 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5">
      <div className="flex min-w-[min(100%,20rem)] flex-1 items-center gap-0.5">
        <button type="button" className={btn} aria-label="First moment" disabled={step === 0} onClick={() => setStep(0)}>
          <SkipBackIcon className="size-3.5" />
        </button>
        <button type="button" className={btn} aria-label="Previous moment" disabled={step === 0} onClick={() => setStep(step - 1)}>
          <ChevronLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          className={btn}
          aria-label={playing ? 'Pause' : 'Play the run'}
          onClick={() => {
            if (!playing && step >= LAST_STEP) setStep(0)
            setPlaying(!playing)
          }}
        >
          {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
        </button>
        <button type="button" className={btn} aria-label="Next moment" disabled={step === LAST_STEP} onClick={() => setStep(step + 1)}>
          <ChevronRightIcon className="size-4" />
        </button>
        <span className="text-muted-foreground ms-1.5 shrink-0 font-mono text-[11px] tabular-nums">
          {step}/{LAST_STEP}
        </span>
        <span className="ms-2 min-w-0 truncate text-xs" aria-live="polite">
          {STEPS[step]!.label}
        </span>
      </div>
      {children}
    </div>
  )
}

const VariantSwitch: FC<{ value: ApprovalVariant; onChange: (v: ApprovalVariant) => void }> = ({ value, onChange }) => (
  <div role="radiogroup" aria-label="Approval element" className="bg-foreground/[0.05] flex shrink-0 rounded-full p-0.5 text-xs">
    {(
      [
        ['card', 'Approval card'],
        ['grant', 'Permission grant'],
      ] as const
    ).map(([id, label]) => (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={value === id}
        onClick={() => onChange(id)}
        className={cn('rounded-full px-2.5 py-1 font-medium transition-colors', value === id ? 'bg-background text-foreground shadow-[0_0_0_1px_var(--border)]' : 'text-muted-foreground hover:text-foreground')}
      >
        {label}
      </button>
    ))}
  </div>
)

const TeamThread: FC<{ mode: 'lanes' | 'list'; step: number; answers: Answers; onAnswer: (id: string, option: string | undefined) => void }> = ({ mode, step, answers, onAnswer }) => {
  const snapshot = useMemo(() => buildThread(step, answers, Date.now()), [step, answers])
  const components: ThreadComponents = mode === 'lanes' ? LANES_COMPONENTS : LIST_COMPONENTS
  return (
    <StaticRuntime key={mode} messages={snapshot.messages} isRunning={snapshot.isRunning} config={mode === 'lanes' ? LANES_CONFIG : LIST_CONFIG} onAnswer={onAnswer}>
      <div className="flex h-full flex-col">
        <div data-slot="lead-bar" className="border-border/50 flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
          <span className="text-[13px] font-medium">lead</span>
          <span className="text-muted-foreground hidden font-mono text-[11px] sm:inline">claude-code · opus · high</span>
          <div className="ms-auto flex min-w-0 items-center gap-2">
            <TaskTray />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <Thread components={components} autoFocus={false} />
        </div>
      </div>
    </StaticRuntime>
  )
}

const AgentsFolder: FC<{ step: number; answers: Answers }> = ({ step, answers }) => {
  const [opened, setOpened] = useState<string[]>([])
  const rows = agentsAt(step, answers)
  const unread = rows.filter((r) => !opened.includes(r.id))
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-brand text-xl font-medium">Agents</h1>
          <span className="text-muted-foreground font-mono text-[11px]">folder of run {RUN_ID}</span>
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No member Workstream yet: the lead has not started anyone at this moment.</p>
        ) : (
          <BackgroundInbox className="max-w-none" runs={unread} onCollect={(id) => setOpened((o) => [...o, id])} />
        )}
        <div className="text-muted-foreground flex flex-col gap-1.5 text-xs leading-relaxed">
          <p>
            Opening a finished or failed row would open that member's Workstream and mark it read; here it only leaves the list.
            {opened.length > 0 && (
              <>
                {' '}
                {opened.length} opened ·{' '}
                <button type="button" className="hover:text-foreground underline underline-offset-2" onClick={() => setOpened([])}>
                  show them again
                </button>
              </>
            )}
          </p>
          <p>A running row cannot be opened from the element (it is disabled while running). Step to 10 to see all three states at once.</p>
        </div>
      </div>
    </div>
  )
}

const TODAY: ThreadMessageLike[] = RAW.today.flatMap((d, i) => [
  { role: 'user', id: `today-${i}-prompt`, content: [{ type: 'text', text: d.prompt }] } as ThreadMessageLike,
  { role: 'assistant', id: `today-${i}-reply`, content: [{ type: 'text', text: d.reply }] } as ThreadMessageLike,
])

const Today: FC = () => (
  <StaticRuntime messages={TODAY} isRunning={false}>
    <Thread components={PLAIN_COMPONENTS} autoFocus={false} />
  </StaticRuntime>
)

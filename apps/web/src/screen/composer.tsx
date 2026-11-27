// The composer (docs/specs/assistant-ui.md, "Sending"), in assistant-ui's base skin: one bordered
// field, the harness, model, role and access pickers inside it where their model picker sits, Send on the
// right, Cancel beside it while the agent works. Above it, what the user must know before sending: a
// refusal, what the agent will be given of the conversation, an uncertain turn, why sending waits,
// the messages waiting.
// The pickers are light (docs/specs/assistant-ui.md, "The pickers"): the harness's mark, the model · its
// effort, a person, a key; no arrow. Each opens its list below it, upward only where it does not fit. Before
// them, the paperclip, when the agent takes images or files; what is attached shows above the text ("Attachments").
import { AuiIf, ComposerPrimitive, QueueItemPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import { ArrowUpIcon, CheckIcon, ClockIcon, LoaderCircleIcon, PaperclipIcon, SquareIcon, UserRoundIcon, XIcon } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState, type FC, type KeyboardEvent } from 'react'
import { ComposerAddAttachment, ComposerAttachments } from '@/components/assistant-ui/elements/attachment'
import { ContextDisplay } from '@/components/assistant-ui/elements/context-display'
import { cn } from '@/lib/utils'
import { acceptOf } from '../agora/attachments.ts'
import { useAgora } from '../agora/runtime.tsx'
import { commandsMatching, continuationNote, harnessName, modelChoice, offeredPools } from '../agora/view.ts'
import { AccessPicker } from './access.tsx'
import { HarnessMark } from './harness-mark.tsx'
import { below, fitted, iconButton, menuContentClass, menuItemClass, quietButton } from './picker.ts'

// A touch screen's keyboard comes up with the focus, over half the thread: there the field waits to be
// touched. With a mouse or a trackpad it takes the focus itself — on opening, on Scroll to the bottom, as
// a turn starts.
const focusesItself = () => matchMedia('(any-pointer: fine)').matches
// A touch screen alone, as assistant-ui's `unstable_insertNewlineOnTouchEnter` tells it: there Enter starts a new line.
const touchAlone = () => matchMedia('(pointer: coarse) and (not (any-pointer: fine))').matches

/** The harness a new execution starts with; the running one, as a plain label, once started. */
const HarnessPicker: FC = () => {
  const { pools, pool, choosePool, composer, view } = useAgora()
  const current = pools?.find((p) => p.name === pool)
  if (!composer.create)
    return view.harness ? (
      <span role="img" aria-label={`Harness: ${harnessName(view.harness)}`} title={harnessName(view.harness)} className="text-muted-foreground grid w-7 shrink-0 place-items-center pointer-coarse:w-9">
        <HarnessMark harness={view.harness} className="size-4" />
      </span>
    ) : null
  if (pools === null) return <span className="text-muted-foreground px-2 text-[13px]">…</span>
  const offered = offeredPools(pools)
  if (offered.length === 0) return <span className="text-destructive px-2 text-[13px]">No harness available</span>
  // Its harness has a save in this Workstream: sending restores it (docs/specs/log.md, "Continuing").
  const continues = (harness: string) => view.continuation?.[harness] !== undefined
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`Harness: ${harnessName(current?.harness)}`} title={harnessName(current?.harness)} className={iconButton}>
          <HarnessMark harness={current?.harness} className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...below} className={cn(menuContentClass, fitted)}>
          {offered.map((p) => (
            <DropdownMenu.Item key={p.name} className={menuItemClass} onSelect={() => choosePool(p.name)}>
              <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', p.name === pool ? 'opacity-100' : 'opacity-0')} />
              <HarnessMark harness={p.harness} className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span className="flex flex-col">
                <span>{harnessName(p.harness)}</span>
                {/* Only what changes what sending does: a harness with a save continues from it. */}
                {continues(p.harness) && <span className="text-muted-foreground text-[12px]">continues its saved session</span>}
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * The model and its effort (docs/specs/assistant-ui.md, "Settings and commands"): the real values
 * only. Before a Session, kept for its Create; in one, sent at once, between turns.
 */
const ModelPicker: FC = () => {
  const { settings, chosen, chooseSetting, composer, view } = useAgora()
  const choice = modelChoice(settings, chosen)
  if (!choice.model || choice.models.length === 0) return null
  const name = (options: typeof choice.models, value: string | null) => options.find((o) => o.value === value)?.name ?? null
  const model = name(choice.models, choice.current.model) ?? 'Model'
  const effort = name(choice.efforts, choice.current.effort)
  const shown = effort ? `${model} · ${effort}` : model
  const changing = !composer.create && view.configuring === true
  const closed = !composer.create && (!composer.open || composer.running || changing)
  const item = (setting: string, value: string, label: string, current: string | null) => (
    <DropdownMenu.Item key={`${setting}:${value}`} className={menuItemClass} onSelect={() => chooseSetting(setting, value)}>
      <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', value === current ? 'opacity-100' : 'opacity-0')} />
      <span>{label}</span>
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={closed}>
        <button
          type="button"
          aria-label={`Model: ${shown}`}
          title={shown}
          className={cn(quietButton, 'flex min-w-0 items-center gap-1 disabled:opacity-50')}
        >
          {changing && <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />}
          <span className="truncate">{shown}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...below} className={cn(menuContentClass, fitted)}>
          <DropdownMenu.Label className="text-muted-foreground px-2 pt-1 pb-0.5 text-[11px] font-medium">Model</DropdownMenu.Label>
          {choice.models.map((o) => item(choice.model!.id, o.value, o.name, choice.current.model))}
          {choice.effort && choice.efforts.length > 0 && (
            <>
              <DropdownMenu.Separator className="bg-foreground/10 my-1 h-px" />
              <DropdownMenu.Label className="text-muted-foreground px-2 pt-1 pb-0.5 text-[11px] font-medium">Effort</DropdownMenu.Label>
              {choice.efforts.map((o) => item(choice.effort!.id, o.value, o.name, choice.current.effort))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * Who the agent is to be (docs/specs/assistant-ui.md, "Roles"): No role, then each of Agora's roles by its name,
 * its summary under it. Offered before the Workstream's first execution alone; what its card sets shows on
 * the other pickers, where the person picked nothing.
 */
const RolePicker: FC = () => {
  const { roles, role, chooseRole } = useAgora()
  if (roles.length === 0) return null
  const label = role?.role ?? 'No role'
  const item = (name: string | null, text: string, summary?: string) => (
    <DropdownMenu.Item key={name ?? ''} className={menuItemClass} onSelect={() => chooseRole(name)}>
      <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0', name === (role?.role ?? null) ? 'opacity-100' : 'opacity-0')} />
      <span className="flex min-w-0 flex-col">
        <span>{text}</span>
        {summary && <span className="text-muted-foreground text-[12px]">{summary}</span>}
      </span>
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`Role: ${label}`} title={label} className={iconButton}>
          {/* A person alone: coral once a role is picked. */}
          <UserRoundIcon className={cn('size-4', role !== null && 'text-primary')} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...below} className={cn(menuContentClass, fitted)}>
          {item(null, 'No role')}
          {roles.map((r) => item(r.role, r.role, r.summary))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The context the agent has used, as a ring beside Send (docs/specs/assistant-ui.md, "Context and limits"); nothing without one. */
const Usage: FC = () => {
  const { view, composer } = useAgora()
  return <ContextDisplay usage={composer.create ? null : (view.usage ?? null)} />
}

/** What stands between the user and sending, said above the field. */
const Notes: FC = () => {
  const { refusal, composer, view, send, starting, pools, pool } = useAgora()
  const continuation = composer.create ? continuationNote(view, pools?.find((p) => p.name === pool)?.harness) : null
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {refusal && (
        <p role="alert" className="border-destructive/60 text-destructive border-l-2 pl-3 text-[13px]">
          {refusal}
        </p>
      )}
      {continuation !== null && <p className="text-muted-foreground border-foreground/15 border-l-2 pl-3 text-[13px]">{continuation}</p>}
      {composer.uncertain ? (
        <div className="border-warning flex flex-wrap items-center gap-2 border-l-2 pl-3 text-[13px]">
          <span className="flex-1">The end of the last turn could not be confirmed. It is never sent again.</span>
          <button type="button" className={quietButton} onClick={() => void send('Cancel', { execution: view.execution, turn: composer.uncertain!.id }, {})}>
            Cancel the turn
          </button>
          <button type="button" className={quietButton} onClick={() => void send('Stop', { execution: view.execution }, {})}>
            Stop the sandbox
          </button>
        </div>
      ) : (
        composer.reason !== null && !starting && <p className="text-muted-foreground border-foreground/15 border-l-2 pl-3 text-[13px]">{composer.reason}</p>
      )}
    </div>
  )
}

/** The messages waiting, oldest first, each with its cross (docs/specs/assistant-ui.md, "Messages during a turn"). */
const WaitingMessages: FC = () => {
  const { waiting, composer, line, delegates } = useAgora()
  if (waiting.length === 0) return null
  // Who wrote a message that is not the person's, as its bubble says it.
  const writer = (id: string): string | null => {
    const message = waiting.find((w) => w.id === id)
    if (message?.as === 'agora') return 'From Agora'
    if (!message?.from) return null
    return `From ${[...line, ...delegates].find((r) => r.id === message.from)?.title ?? 'another agent'}`
  }
  return (
    <div role="list" aria-label="Messages waiting" className="border-foreground/10 rounded-surface -mb-1 flex flex-col border p-1">
      {composer.held && <p className="text-muted-foreground px-2 py-1 text-[12px]">These go with your next message.</p>}
      <ComposerPrimitive.Queue>
        {({ queueItem }) => {
          const attached = waiting.find((w) => w.id === queueItem.id)?.attachments ?? 0
          return (
            <div role="listitem" className="flex items-center gap-2 rounded-sm px-2 text-[13px]">
              <ClockIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              {writer(queueItem.id) !== null && <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-[12px]">{writer(queueItem.id)}</span>}
              <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
              {attached > 0 && (
                <span title={`${String(attached)} attached`} className="text-muted-foreground flex shrink-0 items-center gap-0.5 text-[12px] tabular-nums">
                  <PaperclipIcon aria-hidden className="size-3" />
                  {attached}
                </span>
              )}
              <QueueItemPrimitive.Remove aria-label="Take back" title="Take back" className={cn(quietButton, 'grid w-7 shrink-0 place-items-center px-0 pointer-coarse:w-9')}>
                <XIcon className="size-3.5" />
              </QueueItemPrimitive.Remove>
            </div>
          )
        }}
      </ComposerPrimitive.Queue>
    </div>
  )
}

/** The composer; in a native sub-stream, which takes no message, the line that says so (docs/specs/assistant-ui.md, "The screen"). */
export const Composer: FC<{ placeholder?: string }> = (props) => {
  const { composer, line, refusal } = useAgora()
  if (composer.readOnly)
    return (
      <div className="flex w-full flex-col gap-2">
        {/* What its host refused of a Cancel or an answer made here. */}
        {refusal !== null && (
          <p role="alert" className="text-destructive border-destructive/40 border-l-2 pl-3 text-[13px]">
            {refusal}
          </p>
        )}
        <p data-read-only className="text-muted-foreground border-foreground/15 border-l-2 pl-3 text-[13px]">
          Read-only: a sub-agent of “{line.at(-1)?.title ?? 'its parent'}” takes no message.
        </p>
      </div>
    )
  return <Writing {...props} />
}

const Writing: FC<{ placeholder?: string }> = ({ placeholder }) => {
  const aui = useAui()
  const { starting, composer, commands, promptCapabilities } = useAgora()
  const attachable = acceptOf(promptCapabilities) !== null
  // The commands `/` lists, one of them highlighted; Escape hides them until the text changes.
  const text = useAuiState((s) => s.composer.text)
  const empty = useAuiState((s) => s.composer.isEmpty)
  const [highlighted, setHighlighted] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const matches = dismissed === text ? [] : commandsMatching(commands, text)
  const at = Math.min(highlighted, Math.max(0, matches.length - 1))
  const choose = (name: string) => {
    aui.composer().setText(`/${name} `)
    setHighlighted(0)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The Enter that confirms an IME conversion is the IME's, never a send: Safari fires it once
    // `isComposing` is false again, its keyCode 229 (assistant-ui #8319).
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault()
      return
    }
    // assistant-ui turns every Enter into a new line on a touch screen alone, Ctrl's and Cmd's too: those
    // still send there, through the composer's form as its own Enter does.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && matches.length === 0 && touchAlone()) {
      e.preventDefault()
      if (composer.open && !empty) e.currentTarget.form?.requestSubmit()
      return
    }
    if (matches.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((at + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(matches[at]!.name)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDismissed(text)
    }
  }
  return (
    <div className="flex w-full flex-col gap-3">
      <Notes />
      {matches.length > 0 && (
        <div role="listbox" aria-label="Commands" className="border-foreground/10 bg-popover rounded-surface -mb-1 flex max-h-64 flex-col overflow-y-auto border p-1">
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(c.name)}
              onMouseEnter={() => setHighlighted(i)}
              className={cn('flex items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-[13px]', i === at && 'bg-muted')}
            >
              <span className="font-mono text-[12px]">/{c.name}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">{c.description}</span>
              {c.hint && <span className="text-muted-foreground/70 shrink-0 text-[12px]">{c.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <WaitingMessages />
      <ComposerPrimitive.Root className="border-foreground/10 bg-muted/30 focus-within:border-foreground/25 rounded-thread @container flex w-full flex-col border transition-colors">
        <ComposerAttachments />
        <ComposerPrimitive.Input
          rows={1}
          // With a mouse or a trackpad, Enter sends and Shift+Enter starts a new line. On a touch screen
          // alone — `(pointer: coarse) and (not (any-pointer: fine))`, as assistant-ui tells it —, whose
          // keyboard is the screen's, Enter starts a new line and Send sends. Ctrl or Cmd with Enter sends on both.
          submitMode="enter"
          unstable_insertNewlineOnTouchEnter
          autoFocus={focusesItself()}
          onKeyDown={onKeyDown}
          // Escape hides the commands listed; it cancels the turn only with none.
          cancelOnEscape={matches.length === 0}
          placeholder={composer.refuses ? 'Write to refuse, or to ask for a change' : (placeholder ?? (composer.create ? 'Describe the task…' : 'Write to the agent…'))}
          className="placeholder:text-muted-foreground field-sizing-content max-h-48 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-2 text-base leading-6 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            {attachable && (
              <ComposerAddAttachment className={cn(quietButton, 'grid shrink-0 place-items-center px-0 disabled:opacity-50', 'w-7 pointer-coarse:w-9')} />
            )}
            <HarnessPicker />
            <ModelPicker />
            <RolePicker />
            <AccessPicker />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Usage />
            {starting ? (
              <span className="bg-primary/60 text-primary-foreground rounded-control grid size-7 place-items-center pointer-coarse:size-9" aria-label="Starting">
                <LoaderCircleIcon className="size-4 animate-spin" />
              </span>
            ) : (
              <>
                <AuiIf condition={(s) => s.thread.isRunning}>
                  {/* Quiet once Send stands beside it. */}
                  <ComposerPrimitive.Cancel
                    aria-label="Cancel the turn"
                    className={cn('rounded-control grid size-7 place-items-center pointer-coarse:size-9', empty ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}
                  >
                    <SquareIcon className="size-3 fill-current" />
                  </ComposerPrimitive.Cancel>
                </AuiIf>
                <AuiIf condition={(s) => !s.thread.isRunning || !s.composer.isEmpty}>
                  <ComposerPrimitive.Send
                    aria-label="Send"
                    className="bg-primary text-primary-foreground rounded-control grid size-7 place-items-center transition-opacity disabled:opacity-40 pointer-coarse:size-9"
                  >
                    <ArrowUpIcon className="size-4" />
                  </ComposerPrimitive.Send>
                </AuiIf>
              </>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  )
}

// A form an agent asks (docs/specs/assistant-ui.md, "Forms"): one box — who asks, its message, its questions and, at
// its foot, its answer. Drawn with assistant-ui's OptionList and QuestionFlow (Tool UI's, as assistant-ui ships them),
// answered through assistant-ui: one option, one text or nothing to fill by the part's `respondToApproval`; anything
// else by its `resume`. Once answered, the same components as a receipt — from the log's answer alone: refused or not
// delivered, the box gives its controls back, the reason said.
import type { ToolApprovalResponse } from '@assistant-ui/react'
import { CheckIcon } from 'lucide-react'
import { useState, type FC, type ReactNode } from 'react'
import { OptionList } from '@/components/assistant-ui/elements/option-list'
import { QuestionFlow } from '@/components/assistant-ui/elements/question-flow'
import { field, ghostButton, inkButton } from '@/components/assistant-ui/elements/surfaces'
import { cn } from '@/lib/utils'
import { useAgora } from '../agora/runtime.tsx'
import { answerOf, formContent, harnessName, numberFits, textFits, type Form, type FormAnswer, type FormQuestion } from '../agora/view.ts'

type Respond = (response: ToolApprovalResponse) => Promise<void>

/** Why Agora declined a form itself (docs/specs/log.md, "Requests"). */
const DECLINED: Record<string, string> = {
  secret: 'it asks for a secret, which Agora’s log would keep in clear. Give it to the agent another way if it must have it.',
  async: 'Codex asks it without waiting for the answer, which Agora does not show.',
  mode: 'it is not a form Agora can show.',
}

/** The OptionList's props for one question: its options, its "Other" field, what it requires. */
const listOf = (q: FormQuestion) => ({
  options: q.options,
  selectionMode: q.kind === 'many' ? ('multiple' as const) : ('single' as const),
  // A list's own bounds, `minItems` and `maxItems`; one option, when required.
  minSelections: q.kind === 'many' ? (q.min ?? 0) : q.required ? 1 : 0,
  ...(q.kind === 'many' && q.max !== null ? { maxSelections: q.max } : {}),
  ...(q.other !== null ? { other: { label: 'Other', placeholder: 'Your own answer, or a note' } } : {}),
})

/** The QuestionFlow's step for one question: its options, or a field for a text or a number. */
const stepOf = (q: FormQuestion) => ({
  id: q.key,
  question: q.question,
  ...(q.label ? { description: q.label } : {}),
  required: q.required,
  ...(q.kind === 'text' || q.kind === 'number' || q.kind === 'integer'
    ? { options: [], input: q.kind, fits: (typed: string) => (q.kind === 'text' ? textFits(q, typed) : numberFits(q, typed)) }
    : listOf(q)),
})

const embedded = 'max-w-none border-0 bg-transparent p-0 dark:bg-transparent'

/** One text answered, then Send; or declined. */
const TextAnswer: FC<{ q: FormQuestion; respond: Respond }> = ({ q, respond }) => {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Held until the log's answer comes; given back, the reason said, when it refuses or cannot be reached.
  const go = (response: ToolApprovalResponse) => {
    setBusy(true)
    setError(null)
    void respond(response).catch((refused: unknown) => {
      setBusy(false)
      setError(refused instanceof Error ? refused.message : String(refused))
    })
  }
  const fits = textFits(q, typed)
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label={q.question}
        value={typed}
        rows={2}
        disabled={busy}
        onChange={(event) => setTyped(event.target.value)}
        className={cn(field, 'rounded-control placeholder:text-muted-foreground resize-y px-2 py-1.5 text-[13px] outline-none')}
      />
      {error !== null && (
        <p role="alert" className="text-xs break-words text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" disabled={busy} onClick={() => go({ approved: false })} className={cn(ghostButton, 'h-8 px-3 text-xs font-medium')}>
          Decline
        </button>
        <button
          type="button"
          aria-disabled={busy || !fits || undefined}
          onClick={() => {
            if (!busy && fits) go({ text: typed.trim() })
          }}
          className={cn(inkButton, 'flex h-8 items-center rounded-full px-3.5 text-xs font-medium', (busy || !fits) && 'cursor-default opacity-40 hover:opacity-40')}
        >
          Send
        </button>
      </div>
    </div>
  )
}

/** Its questions, open: by shape, the part's approval or its interrupt answering. */
function Questions({ form, respond, resume }: { form: Form; respond: Respond; resume: (payload: FormAnswer) => Promise<void> }): ReactNode {
  const [only] = form.questions
  if (form.shape === 'select' && only)
    return (
      <OptionList
        {...listOf(only)}
        aria-label={only.question}
        confirmLabel="Answer"
        onConfirm={(ids, text) => respond({ approved: true, ...(ids[0] !== undefined ? { optionId: ids[0] } : {}), ...(only.other !== null && text !== '' ? { text } : {}) })}
        onDecline={() => respond({ approved: false })}
        className={embedded}
      />
    )
  if (form.shape === 'text' && only) return <TextAnswer q={only} respond={respond} />
  if (form.shape === 'list' && only)
    return (
      <OptionList
        {...listOf(only)}
        aria-label={only.question}
        confirmLabel="Answer"
        onConfirm={(ids, text) => resume({ action: 'accept', content: formContent(form, { [only.key]: ids }, { [only.key]: text }) })}
        onDecline={() => resume({ action: 'decline' })}
        className={embedded}
      />
    )
  if (form.shape === 'flow')
    return (
      <QuestionFlow
        steps={form.questions.map(stepOf)}
        completeLabel="Answer"
        onComplete={(answers, texts) => resume({ action: 'accept', content: formContent(form, answers, texts) })}
        onDecline={() => resume({ action: 'decline' })}
        className={embedded}
      />
    )
  return (
    <div className="flex items-center justify-end gap-1.5">
      <button type="button" onClick={() => void respond({ approved: false }).catch(() => undefined)} className={cn(ghostButton, 'h-8 px-3 text-xs font-medium')}>
        Decline
      </button>
      <button type="button" onClick={() => void respond({ approved: true }).catch(() => undefined)} className={cn(inkButton, 'flex h-8 items-center rounded-full px-3.5 text-xs font-medium')}>
        Accept
      </button>
    </div>
  )
}

/** Its answer, as a receipt: the same components, given what was chosen and typed. */
function Receipt({ form }: { form: Form }): ReactNode {
  const answers = form.questions.map((q) => ({ q, ...answerOf(q, form.content) }))
  if (form.questions.length === 1 && (form.shape === 'select' || form.shape === 'list')) {
    const [{ q, chosen, text }] = answers as [(typeof answers)[number]]
    return <OptionList {...listOf(q)} choice={chosen} choiceText={text} className={embedded} />
  }
  if (form.shape === 'text') return <p className="text-foreground/80 text-[13.5px] leading-5 break-words whitespace-pre-wrap">{answers[0]?.text}</p>
  if (form.shape === 'confirm') return null
  return (
    <QuestionFlow
      steps={form.questions.map(stepOf)}
      choice={Object.fromEntries(answers.map((a) => [a.q.key, a.chosen]))}
      choiceTexts={Object.fromEntries(answers.filter((a) => a.text !== '').map((a) => [a.q.key, a.text]))}
      className={embedded}
    />
  )
}

export const FormCard: FC<{ form: Form; respond: Respond; resume: (payload: unknown) => void }> = ({ form, respond, resume }) => {
  const { view, answered } = useAgora()
  // assistant-ui's `resume` returns nothing: what became of the answer is read back from Agora's context.
  const answer = (payload: FormAnswer): Promise<void> => {
    const outcome = answered(form.id)
    resume(payload)
    return outcome
  }
  const open = form.status === 'pending' && form.declined === null
  const [only] = form.questions
  // A single question that is not the message itself is said under it (Codex says its question in its field).
  const asked = form.questions.length === 1 && only && only.question !== form.message ? only.question : null
  const by = form.by === 'delegator' ? ' by its delegator' : ''
  const note =
    form.declined !== null
      ? null
      : form.status === 'pending'
        ? 'waiting for you'
        : form.status === 'cancelled'
          ? 'not answered'
          : form.status === 'declined'
            ? `declined${by}`
            : `answered${by}`
  return (
    <div
      data-form={form.shape}
      data-form-status={form.declined !== null ? 'declined-by-agora' : form.status}
      className={cn('bg-background rounded-surface my-2 flex flex-col gap-2.5 border p-3', open ? 'border-primary/40' : 'border-foreground/10')}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-muted-foreground text-[13px]">{harnessName(view.harness)} asks you.</p>
        {note !== null && (
          <p className={cn('flex shrink-0 items-center gap-1.5 text-[12px] font-medium', open ? 'text-primary' : 'text-muted-foreground')}>
            {!open && form.status === 'answered' && <CheckIcon className="size-3.5 shrink-0" />}
            {note}
          </p>
        )}
      </div>
      {form.message !== '' && <p className="text-[15px] leading-relaxed font-medium whitespace-pre-wrap">{form.message}</p>}
      {asked !== null && <p className="text-[13.5px] leading-5">{asked}</p>}
      {form.declined !== null ? (
        <p className="text-muted-foreground text-[13px]">Agora declined it: {DECLINED[form.declined] ?? DECLINED.mode}</p>
      ) : open ? (
        <Questions form={form} respond={respond} resume={answer} />
      ) : form.status === 'answered' ? (
        <Receipt form={form} />
      ) : null}
    </div>
  )
}

// A question to the person (docs/specs/log.md, "Commands"): whoever drives a Workstream asks, the
// interface answers. Neither goes to an agent; both are commands of the log, read back in its thread.
import { object } from './json.ts'

const KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always'])

const within = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max

/** Whether an Ask's body is within its bounds: a one-line title, Markdown, 2 to 4 options, a note or not. */
export function validQuestion(body: Record<string, unknown>): boolean {
  if (!within(body.title, 1, 200) || /[\r\n]/.test(body.title)) return false
  if (!within(body.text, 0, 100_000)) return false
  if (body.note !== undefined && typeof body.note !== 'boolean') return false
  const options = body.options
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return false
  const ids = new Set<string>()
  for (const raw of options) {
    const option = object(raw)
    if (!option || !within(option.optionId, 1, 64) || !within(option.name, 1, 80) || !KINDS.has(String(option.kind))) return false
    if (ids.has(option.optionId)) return false
    ids.add(option.optionId)
  }
  return true
}

/** Why an Answer cannot be given to this pending question, or null when it can. */
export function answerRefusal(question: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const options = Array.isArray(question.options) ? question.options : []
  if (!options.some((o) => object(o)?.optionId === body.optionId)) return 'invalid_question_option'
  if (body.note !== undefined && (question.note !== true || !within(body.note, 0, 10_000))) return 'invalid_answer'
  return null
}

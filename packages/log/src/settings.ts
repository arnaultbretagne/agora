// A Session's settings (docs/specs/log.md, "Sessions"): the ACP `configOptions` it last gave, the
// opening settings its Create resolved, and which of them are left to send. Pure.
import { object } from './json.ts'
import type { Execution, State } from './state.ts'

export interface SettingOption {
  readonly value: string
  readonly name: string
  readonly description: string | null
}

/** A setting as the Workstream view carries it. */
export interface Setting {
  readonly id: string
  readonly name: string
  readonly category: string | null
  readonly type: string
  readonly currentValue: unknown
  readonly options: readonly SettingOption[]
}

/** One opening setting: its id and the value a Session starts with. */
export interface Wanted {
  readonly id: string
  readonly value: string
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A `select`'s options, its groups flattened. */
function optionsOf(option: Record<string, unknown>): SettingOption[] {
  const out: SettingOption[] = []
  for (const raw of list(option.options)) {
    const o = object(raw)
    if (!o) continue
    if (Array.isArray(o.options)) {
      for (const inner of list(o.options)) {
        const i = object(inner)
        if (i && typeof i.value === 'string') out.push({ value: i.value, name: text(i.name) ?? i.value, description: text(i.description) })
      }
    } else if (typeof o.value === 'string') out.push({ value: o.value, name: text(o.name) ?? o.value, description: text(o.description) })
  }
  return out
}

/** The `configOptions` an agent gave, as the view carries them; anything unreadable left out. */
export function settingsOf(configOptions: unknown): Setting[] {
  const out: Setting[] = []
  for (const raw of list(configOptions)) {
    const o = object(raw)
    const id = text(o?.id) ?? text(o?.configId)
    if (!o || id === null) continue
    out.push({ id, name: text(o.name) ?? id, category: text(o.category), type: text(o.type) ?? 'select', currentValue: o.currentValue ?? null, options: optionsOf(o) })
  }
  return out
}

/** An agent's commands, as the view carries them. */
export function commandsOf(availableCommands: unknown): { name: string; description: string; hint: string | null }[] {
  return list(availableCommands)
    .map((raw) => object(raw))
    .filter((c): c is Record<string, unknown> => typeof c?.name === 'string')
    .map((c) => ({ name: String(c.name), description: text(c.description) ?? '', hint: text(object(c.input)?.hint) }))
}

/** A Create's opening settings: the pool's, each replaced by the Create's own, then its others. */
export function resolveSettings(pool: readonly Wanted[], own: Record<string, string>): Wanted[] {
  const out = pool.map((w) => (Object.hasOwn(own, w.id) ? { id: w.id, value: own[w.id]! } : w))
  for (const [id, value] of Object.entries(own)) if (!out.some((w) => w.id === id)) out.push({ id, value })
  return out
}

/** A Create's `settings` when valid: an object of strings. */
export function ownSettings(value: unknown): Record<string, string> | null {
  if (value === undefined) return {}
  const o = object(value)
  if (!o || Object.values(o).some((v) => typeof v !== 'string')) return null
  return o as Record<string, string>
}

const opening = (e: Execution): Wanted[] =>
  list(e.body.settings)
    .map((raw) => object(raw))
    .filter((w): w is Record<string, unknown> => typeof w?.id === 'string' && typeof w.value === 'string')
    .map((w) => ({ id: String(w.id), value: String(w.value) }))

/** Whether a Session offers that setting with that value. */
export function offers(e: Execution, id: string, value: unknown): boolean {
  const setting = settingsOf(e.settings).find((s) => s.id === id)
  return setting !== undefined && typeof value === 'string' && setting.options.some((o) => o.value === value)
}

/** The next opening setting to send: offered, with a value listed, not current, not sent yet. */
export function nextOpening(e: Execution): Wanted | null {
  if (!e.session) return null
  const settings = settingsOf(e.settings)
  for (const w of opening(e)) {
    if (e.configSent.includes(w.id)) continue
    const setting = settings.find((s) => s.id === w.id)
    if (!setting || setting.currentValue === w.value || !setting.options.some((o) => o.value === w.value)) continue
    return w
  }
  return null
}

/** A `session/set_config_option` of the execution's open Session is unanswered. */
export function configuring(state: State, e: Execution): boolean {
  for (const position of state.unanswered) {
    const request = state.requestPositions.get(position)
    if (request?.method === 'session/set_config_option' && request.execution === e.id && request.session === e.session && !state.failures.has(position))
      return true
  }
  return false
}

/** None left to send and none unanswered. */
export const settled = (state: State, e: Execution): boolean => nextOpening(e) === null && !configuring(state, e)

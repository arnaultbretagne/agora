/**
 * Every derivation the chat UI performs on engine data, kept free of the DOM so it can be tested
 * for real rather than through a DOM stub (the OLD UI's own `test/app-loads.test.js` could only
 * prove the module *loaded*, because all of this was tangled into the render functions).
 *
 * The OLD system handed the browser a pre-chewed "conversation" summary carrying `state`, `kind`,
 * `model`, `effort` and `agent` as flat fields. The new engine has no such summary and should not
 * grow one: those five things are five different facts with five different owners (Session phase,
 * launch envelope, the harness's own ACP config). This module is where they are re-derived from
 * what the engine actually publishes.
 */

import type { PublicAgent, Session, WorkstreamItem, WorkstreamTurn } from './api.js'

// ---------- Runtime state (the sidebar dot and the topbar chip) ----------

/**
 * The OLD UI's four-state vocabulary, preserved because it is what the operator reads at a glance.
 * The nine-phase Session lifecycle (docs/specs/03) collapses onto it: everything that is not yet
 * usable is "starting", everything usable is "live", every resting or finished state is "en veille",
 * and only `failed` is an error. A Workstream with no Session at all is at rest, not broken.
 */
export type RuntimeState = 'dormant' | 'starting' | 'live' | 'error'

export const STATE_LABELS: Readonly<Record<RuntimeState, string>> = {
  dormant: 'En veille',
  starting: 'Démarrage…',
  live: 'Live',
  error: 'Erreur',
}

export function runtimeStateOfPhase(phase: string | undefined): RuntimeState {
  switch (phase) {
    case 'requested':
    case 'provisioning':
      return 'starting'
    case 'ready':
    case 'busy':
      return 'live'
    case 'failed':
      return 'error'
    default:
      return 'dormant'
  }
}

/** The Session the UI speaks to: the one the engine marks current, which is the only one `POST /v1/sessions/{id}/prompts` accepts. */
export function currentSession(sessions: readonly Session[]): Session | undefined {
  return sessions.find((session) => session.current)
}

// ---------- History grouping ----------

export type HistoryGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

/** Order is the rendered order — pinned first, then newest-to-oldest buckets. */
export const HISTORY_GROUPS: readonly (readonly [HistoryGroupKey, string])[] = [
  ['pinned', 'Épinglées'],
  ['today', "Aujourd'hui"],
  ['yesterday', 'Hier'],
  ['week', '7 derniers jours'],
  ['older', 'Plus ancien'],
]

/**
 * Bucketed by CALENDAR day, not by elapsed hours: something touched at 23:50 yesterday belongs
 * under "Hier" at 00:10 today, which is how a human reads their own history. Both sides are
 * normalised to local midnight before subtracting for that reason.
 */
export function groupOf(updatedAt: string, now: Date): Exclude<HistoryGroupKey, 'pinned'> {
  const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.floor((startOfDay(now) - startOfDay(new Date(updatedAt))) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 7) return 'week'
  return 'older'
}

export interface GroupableWorkstream {
  readonly id: string
  readonly title: string
  readonly pinned: boolean
  readonly updatedAt: string
}

export interface HistoryGroup<T extends GroupableWorkstream> {
  readonly key: HistoryGroupKey
  readonly label: string
  readonly items: readonly T[]
}

/**
 * Search is a client-side substring match over titles only, exactly as in the OLD UI. It stays
 * client-side deliberately: `GET /v1/workstreams` has no query parameter for it, and inventing one
 * would mean a server round-trip per keystroke to filter a list the browser already holds.
 * Empty groups are dropped so the sidebar never shows a heading with nothing under it.
 */
export function groupWorkstreams<T extends GroupableWorkstream>(workstreams: readonly T[], search: string, now: Date): HistoryGroup<T>[] {
  const query = search.trim().toLowerCase()
  const visible = [...workstreams]
    .filter((workstream) => !query || workstream.title.toLowerCase().includes(query))
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))

  return HISTORY_GROUPS.map(([key, label]) => ({
    key,
    label,
    items: key === 'pinned' ? visible.filter((w) => w.pinned) : visible.filter((w) => !w.pinned && groupOf(w.updatedAt, now) === key),
  })).filter((group) => group.items.length > 0)
}

// ---------- Transcript ----------

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'agent'
  readonly text: string
  readonly completed: boolean
}

interface MessageItemValue {
  readonly role?: unknown
  readonly content?: unknown
  readonly completed?: unknown
}

/**
 * Only `message` items become chat turns. The OLD UI showed no tool calls, no plans and no
 * permission traffic, on the stated grounds that a transcript should say what was said — and that
 * choice is carried over here, even though (unlike the OLD hub, which never received them at all)
 * this engine does project every one of those kinds and could show them.
 *
 * `thought` items are excluded for the same reason and one more: they are the harness thinking out
 * loud, not addressed to anyone.
 *
 * Ordered by `firstWorkstreamSeq` because `GET .../items` pages newest-first and the SSE feed
 * delivers upserts in projector order; neither is reading order, and a streaming message keeps its
 * original sequence as chunks accumulate, so this ordering is stable while it grows.
 */
export function messagesFromItems(items: readonly WorkstreamItem[]): ChatMessage[] {
  return items
    .filter((item) => item.kind === 'message')
    .slice()
    .sort((left, right) => left.firstWorkstreamSeq - right.firstWorkstreamSeq)
    .map((item) => {
      const value = item.value as MessageItemValue
      return {
        id: item.id,
        role: value.role === 'user' ? ('user' as const) : ('agent' as const),
        text: contentBlocksToText(value.content),
        completed: value.completed === true,
      }
    })
}

/**
 * A message's `content` is the raw ACP content-block array, appended chunk by chunk. Text blocks
 * are concatenated with NO separator: consecutive chunks are fragments of one sentence, and joining
 * them with anything at all inserts breaks mid-word. Non-text blocks (images, resources) are
 * skipped rather than stringified — a JSON blob in the middle of a reply is worse than nothing.
 */
function contentBlocksToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

/**
 * What the transcript's DOM should become, expressed against what it currently is.
 *
 * This is the half of the flicker fix worth reasoning about, so it lives here rather than in the
 * renderer: which rows survive a feed frame, which one actually needs its markdown produced again,
 * and which pending echo is really the message that has just come back from the projector. `app.ts`
 * only applies the result to elements.
 *
 * The rule that is not obvious: a row is identified by its id, EXCEPT that a message with no row of
 * its own adopts a spare row of the same role already showing exactly the same text. That pair is
 * always an optimistic echo and the projected message that replaces it — one bubble as far as the
 * person who typed it is concerned, so recreating it would make their own words blink out and back
 * in a few hundred milliseconds after they hit send.
 */
export interface RenderedRow {
  readonly id: string
  readonly role: 'user' | 'agent'
  readonly text: string
}

export interface TranscriptRowPlan {
  readonly message: ChatMessage
  /** Key of the row to reuse; `undefined` means there is none and one must be created. */
  readonly reuse: string | undefined
  /** Whether the markdown has to be rendered again. Always true for a row being created, and false for a row whose text has not moved — which is every row but one while an answer streams in. */
  readonly rerender: boolean
}

export interface TranscriptPlan {
  readonly rows: readonly TranscriptRowPlan[]
  readonly removed: readonly string[]
}

export function planTranscript(rendered: readonly RenderedRow[], messages: readonly ChatMessage[]): TranscriptPlan {
  const spare = new Map(rendered.map((row) => [row.id, row]))
  const rows: TranscriptRowPlan[] = messages.map((message) => {
    const keyed = spare.get(message.id)
    if (!keyed) return { message, reuse: undefined, rerender: true }
    spare.delete(message.id)
    return { message, reuse: keyed.id, rerender: keyed.text !== message.text }
  })

  for (const [index, plan] of rows.entries()) {
    if (plan.reuse !== undefined) continue
    for (const candidate of spare.values()) {
      if (candidate.role !== plan.message.role || candidate.text !== plan.message.text) continue
      spare.delete(candidate.id)
      rows[index] = { message: plan.message, reuse: candidate.id, rerender: false }
      break
    }
  }

  return { rows, removed: [...spare.keys()] }
}

/**
 * The OLD server pushed an explicit `typing` event. The new engine has no such signal and needs
 * none: a Turn open with `status: 'running'` IS the agent working, and both the initial
 * `GET .../turns` and the feed's `status` frames report it.
 */
export function hasRunningTurn(turns: readonly WorkstreamTurn[]): boolean {
  return turns.some((turn) => turn.status === 'running')
}

/**
 * An `invocation` Workstream accepts exactly ONE user-purpose turn; a second prompt is refused with
 * 400 `invocation_cardinality_exceeded`. `discussion` is the only category that takes an ongoing
 * conversation, and the only one this UI creates — but an invocation created by anything else lands
 * in the same sidebar, and a composer that accepts typing only to have the send refused is a worse
 * answer than one that is closed with its reason showing.
 *
 * Counted by PURPOSE, not by total turns: a `handoff` turn is the engine carrying history into a new
 * Session (persona/equipment changes do exactly that), and it does not consume the invocation's one
 * user turn.
 */
export function invocationTurnSpent(category: string, turns: readonly WorkstreamTurn[]): boolean {
  return category === 'invocation' && turns.some((turn) => turn.purpose === 'user')
}

// ---------- Harness configuration (ACP session config options) ----------

export interface ConfigOptionValue {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface ConfigOption {
  readonly id: string
  readonly name: string
  readonly type?: string
  readonly category?: string
  readonly currentValue?: unknown
  readonly options?: readonly ConfigOptionValue[]
}

/**
 * ACP's `category` is the intended way to find the model and reasoning-level selectors ("intended to
 * help Clients distinguish broadly common selectors … MUST NOT be required for correctness", and
 * "Clients MUST handle missing or unknown categories gracefully" — the SDK's own schema doc). The id
 * fallback exists for exactly that: the ids observed live are `model` and `effort`, but neither the
 * id nor the category is guaranteed, and a harness advertising neither simply gets no such selector
 * rather than a hard-coded list this client made up.
 */
export function findConfigOption(options: readonly ConfigOption[], category: string, fallbackId: string): ConfigOption | undefined {
  return options.find((option) => option.category === category) ?? options.find((option) => option.id === fallbackId)
}

interface UnknownItemValue {
  readonly envelope?: { readonly result?: { readonly configOptions?: unknown } }
}

/**
 * Where the model list comes from — and the one genuinely non-obvious read in this client.
 *
 * The harness is authoritative on its own options and advertises them in the `session/new`
 * response; the product API deliberately curates no model list (server.ts, `handleSetConfigOption`)
 * and exposes no "read the current config" route. But every ACP frame is journaled, and the
 * projector folds any frame it does not model first-class into an `unknown` item carrying the whole
 * envelope (packages/store-pg/src/projector.ts: "rather than being silently dropped or
 * half-modeled"). `session/new`'s response is such a frame, so its `configOptions` are already
 * published on `GET /v1/workstreams/{id}/items` — no new endpoint required.
 *
 * Taking the LATEST such envelope is what keeps it current rather than merely initial: a
 * `PUT /v1/sessions/{id}/config-options/{id}` travels the same journaled connection and its
 * response carries the full option set back (the Agent returns all of them because changing one may
 * change the others), so the newest envelope always reflects the newest state.
 *
 * The `agora-web` projector is pinned to stable ACP v1 (ADR 0003), so this bucket is where these
 * frames land by design and not by accident — but it is a generic bucket, so this reads defensively
 * and returns `undefined` rather than asserting a shape.
 *
 * `itemCarriesConfigOptions` is the same recognition applied to ONE item, exported so a client
 * holding a single feed frame can tell in constant time whether the selectors can possibly have
 * changed — which is almost never, and re-rendering them per streamed chunk is exactly the kind of
 * churn that made the transcript flicker.
 */
export function itemCarriesConfigOptions(item: WorkstreamItem): boolean {
  return item.kind === 'unknown' && Array.isArray((item.value as UnknownItemValue).envelope?.result?.configOptions)
}

export function configOptionsFromItems(items: readonly WorkstreamItem[]): readonly ConfigOption[] | undefined {
  let latest: WorkstreamItem | undefined
  for (const item of items) {
    if (!itemCarriesConfigOptions(item)) continue
    if (!latest || item.latestWorkstreamSeq > latest.latestWorkstreamSeq) latest = item
  }
  if (!latest) return undefined
  const raw = (latest.value as UnknownItemValue).envelope?.result?.configOptions as readonly ConfigOption[]
  return raw.map(flattenSelectGroups)
}

/**
 * ACP lets a select advertise its values EITHER flat (`{value, name}`) OR grouped
 * (`{group, name, options:[{value, name}]}`) — `SessionConfigSelectOptions` is
 * `Array<SessionConfigSelectOption> | Array<SessionConfigSelectGroup>`, and nothing says which you
 * will get.
 *
 * Reading only the flat form is not a cosmetic bug. Claude Code groups its models, so every entry
 * had a `group` and no `value` at all: the menu listed group headings as if they were models, and
 * choosing one sent `{"value": undefined}` — which `JSON.stringify` drops entirely, so the request
 * body arrived as `{}` and the server answered "body must be {"value": "<non-empty string>"}".
 * Reported live 2026-08-07 as "j'ai tenté de changer de modèle et ça m'a mis un message d'erreur
 * comme quoi la string était pas bonne".
 *
 * Flattened rather than rendered as sections: the grouping is presentation the OLD UI never had,
 * and a flat list of real values is both correct and closer to what it did.
 */
function flattenSelectGroups(option: ConfigOption): ConfigOption {
  const values = option.options
  if (!Array.isArray(values) || values.length === 0) return option
  const grouped = values as readonly (ConfigOptionValue & { readonly group?: string; readonly options?: readonly ConfigOptionValue[] })[]
  if (!grouped.some((entry) => entry.group !== undefined || Array.isArray(entry.options))) return option
  const flattened = grouped.flatMap((entry) =>
    Array.isArray(entry.options) ? entry.options : entry.value !== undefined ? [entry as ConfigOptionValue] : [],
  )
  return { ...option, options: flattened }
}

/**
 * The option set the selectors actually render, and where it came from.
 *
 * `live` is a running Agent's own advertisement, read from the journal (`configOptionsFromItems`) —
 * authoritative, and the only source that carries real `currentValue`s. `catalogue` is what that
 * Agent advertised the last time ANY Session ran it (`GET /v1/agents/{id}/config-options`), which is
 * how a conversation that has not started yet can offer a model choice at all; before P12 it could
 * not, and the button was rendered disabled.
 *
 * In catalogue mode the only values shown as chosen are the operator's own draft picks. The memo
 * deliberately carries no `currentValue` (it would be some other Session's state), and guessing one
 * would put a model on screen that nothing has agreed to run.
 */
export type ConfigSource = 'live' | 'catalogue' | 'none'

export interface EffectiveConfig {
  readonly source: ConfigSource
  readonly options: readonly ConfigOption[]
}

export function effectiveConfig(
  live: readonly ConfigOption[],
  catalogue: readonly ConfigOption[] | undefined,
  draft: Readonly<Record<string, string | boolean>>,
): EffectiveConfig {
  if (live.length > 0) return { source: 'live', options: live }
  if (!catalogue || catalogue.length === 0) return { source: 'none', options: [] }
  return {
    source: 'catalogue',
    options: catalogue.map((option) => (option.id in draft ? { ...option, currentValue: draft[option.id] } : option)),
  }
}

// ---------- Effort rail ----------

/**
 * Effort is an ordered magnitude, so it is a rail rather than a list (the OLD UI's design). The
 * geometry is shared by the click handler and the arrow keys so a click at 40% and two presses of
 * ArrowRight can never disagree about which level they landed on.
 */
export function railIndexAt(fraction: number, levelCount: number): number {
  if (levelCount <= 1) return 0
  return clampIndex(Math.round(fraction * (levelCount - 1)), levelCount)
}

export function clampIndex(index: number, levelCount: number): number {
  return Math.max(0, Math.min(levelCount - 1, index))
}

/**
 * Where the knob sits. A level the Agent actually reports as current wins; with nothing chosen (the
 * composer of a new conversation, whose catalogue carries no `currentValue`) the rail rests on the
 * harness's own `default` level when it advertises one — Claude Code's effort list starts with
 * exactly that — and only falls back to the first level when it does not.
 *
 * Resting on a level is not choosing one: nothing is sent unless the operator moves the rail, so an
 * untouched conversation runs on whatever the harness itself defaults to.
 */
export function railIndexOf(levels: readonly ConfigOptionValue[], currentValue: unknown): number {
  const current = currentValue === undefined || currentValue === null ? '' : String(currentValue)
  const chosen = levels.findIndex((level) => level.value === current)
  if (chosen >= 0) return chosen
  const fallback = levels.findIndex((level) => level.value === 'default')
  return fallback >= 0 ? fallback : 0
}

// ---------- Agents ----------

/** An Agent that is `unavailable`/`deprecated` is not offered: the server refuses to launch it (`agent_unavailable`), so showing it could only produce a 409 the operator cannot act on. */
export function launchableAgents(agents: readonly PublicAgent[]): readonly PublicAgent[] {
  return agents.filter((agent) => agent.availability === 'enabled')
}

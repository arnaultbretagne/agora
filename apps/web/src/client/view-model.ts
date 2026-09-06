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

/**
 * The shapes this module folds over. They are the UI's OWN view types, not the API's: the projected
 * item the transcript reads and the turn the composer watches. Defining them here rather than
 * importing them is deliberate — S12 removed the API's `Session.phase`, and a view model that
 * imported a phase would be one field away from displaying it.
 */
export interface WorkstreamItem {
  readonly id: string
  readonly sessionId: string
  readonly kind: string
  /** The projected entity's own key — a tool-call id for a permission, and the only tie back to the live request. */
  readonly entityKey: string
  readonly value: Record<string, unknown>
  readonly firstWorkstreamSeq: number
  readonly latestWorkstreamSeq: number
  readonly updatedAt: string
}

export interface WorkstreamTurn {
  readonly id: string
  readonly status: string
  readonly purpose: string
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


/* ------------------------------------------------------------------ *
 *  S12: what the operator is told, and why                            *
 * ------------------------------------------------------------------ */

/**
 * The status vocabulary. Every one of these is DERIVED, at render time, from the operational view
 * and fresh projections — none of them is a stored phase, because no phase exists (ADR 0002/0003).
 *
 * `converged` says "as of <observation time>", never "ready": ready is a promise about the future,
 * and this is a statement about a moment that has already passed.
 */
export type WorkstreamStatusKind = 'no-intent' | 'converged' | 'reconciling' | 'held' | 'delivery-unknown' | 'restricted'

export interface WorkstreamStatus {
  readonly kind: WorkstreamStatusKind
  /** One line, already in the operator's language. Carries the rule id or cause where there is one. */
  readonly label: string
  /** Present when the cause is external and has a remediation the operator can act on (CAPS-004). */
  readonly remediation?: string
  /** True while nothing may be sent: an ambiguous delivery gates the next turn (CONT-005). */
  readonly blocksSending: boolean
}

export interface StatusInputs {
  /** The latest Intent view, or null when the Workstream has never been given one. */
  readonly intent: { readonly work: { readonly blockingCause: string | null; readonly attemptCount: number } | null } | null
  /** An unresolved possibly-accepted prompt, if the last send reported one. */
  readonly deliveryUnknown: boolean
  /** When the status was derived — shown with `converged`, because that claim is about a moment. */
  readonly observedAt: Date
}

/**
 * The one place a status is decided. Order matters and is not arbitrary: an ambiguous delivery is
 * shown ahead of everything else because it is the only state where the operator's next action
 * could duplicate an external effect, and an external restriction is shown ahead of ordinary
 * reconciling because "we are working on it" is false when nothing will happen until someone
 * outside changes something.
 */
export function deriveStatus(inputs: StatusInputs): WorkstreamStatus {
  if (inputs.deliveryUnknown) {
    return {
      kind: 'delivery-unknown',
      label: 'Livraison incertaine : un message a peut-être été reçu.',
      remediation: 'Aucun renvoi automatique. Un renvoi manuel pourrait dupliquer un effet externe déjà produit.',
      blocksSending: true,
    }
  }
  if (inputs.intent === null) return { kind: 'no-intent', label: 'Aucune intention enregistrée.', blocksSending: false }

  const cause = inputs.intent.work?.blockingCause ?? null
  if (cause === null) {
    return { kind: 'converged', label: `Convergé au ${inputs.observedAt.toISOString()}`, blocksSending: false }
  }
  // CAPS-004: an authority the organization has restricted. Nothing this deployment does will lift
  // it, so saying "reconciling" would be a lie about who is acting.
  if (cause.startsWith('capability_restricted') || cause.startsWith('external_restriction')) {
    return {
      kind: 'restricted',
      label: `Restreint par la politique de l’organisation : ${cause}`,
      remediation: 'La levée de cette restriction appartient à l’organisation, pas à ce déploiement.',
      blocksSending: false,
    }
  }
  if (cause.startsWith('HOLD') || cause.includes('hold')) {
    return { kind: 'held', label: `En attente : ${cause}`, blocksSending: false }
  }
  return { kind: 'reconciling', label: `Réconciliation en cours : ${cause}`, blocksSending: false }
}

/* ---------- Permission decisions (S12 Step 4) ---------- */

export interface PermissionOptionView {
  readonly optionId: string
  readonly name: string
}

/** A request the agent is blocked on, exactly as the live channel published it. */
export interface PendingPermissionView {
  readonly permissionId: string
  readonly toolCallId: string | null
  readonly title: string
  readonly options: readonly PermissionOptionView[]
}

/** What this client has answered and is still waiting to see come back on the wire. */
export interface SubmittedPermission {
  readonly permissionId: string
  readonly toolCallId: string | null
  readonly title: string
  readonly optionId: string
  readonly optionName: string
}

/**
 * `asked` — the agent is waiting on the operator.
 * `sent` — an answer left this browser and has NOT been seen on the wire yet.
 * `answered` — the response frame was journaled and projected; only now is there anything to report.
 */
export type PermissionPromptState = 'asked' | 'sent' | 'answered'

export interface PermissionPrompt {
  readonly permissionId: string
  readonly title: string
  readonly options: readonly PermissionOptionView[]
  readonly state: PermissionPromptState
  /** The line to show. For `answered` it describes the projected outcome, never the click. */
  readonly label: string
}

interface PermissionInputs {
  readonly pending: readonly PendingPermissionView[]
  readonly items: readonly WorkstreamItem[]
  readonly submitted: readonly SubmittedPermission[]
}

/**
 * What the operator is shown about permissions, and — the whole point of this derivation — the
 * refusal to show a decision as done because a button was pressed.
 *
 * Clicking "Allow" resolves a promise inside the control plane; the agent learns of it when the
 * response frame is written to the connection, and the UI learns of it when the projector folds
 * that frame into the `permission` item's `decided` status. Between those two moments the honest
 * thing to say is "sent", and that is what `sent` means here. A UI that flipped straight to
 * "granted" would be reporting its own intention as an outcome — the same class of claim
 * `prompt_delivery_unknown` exists to prevent one step earlier in the protocol.
 *
 * The tie between a live request and its projected item is the tool-call id: the pending list says
 * what may still be answered, the projection says what the answer turned out to be.
 */
export function permissionPrompts(inputs: PermissionInputs): PermissionPrompt[] {
  const pendingIds = new Set(inputs.pending.map((request) => request.permissionId))
  const decided = new Map<string, Record<string, unknown>>()
  for (const item of inputs.items) {
    if (item.kind !== 'permission' || item.value['status'] !== 'decided') continue
    decided.set(item.entityKey, item.value)
  }

  const live = inputs.pending.map((request): PermissionPrompt => {
    const sent = inputs.submitted.find((entry) => entry.permissionId === request.permissionId)
    return sent === undefined
      ? { permissionId: request.permissionId, title: request.title, options: request.options, state: 'asked', label: `Autorisation demandée : ${request.title}` }
      // No options once an answer is out: a second click cannot reach the same request, and
      // offering one would suggest the first is still undecided.
      : { permissionId: request.permissionId, title: request.title, options: [], state: 'sent', label: `Réponse envoyée (${sent.optionName}) — en attente de sa prise en compte par le harnais.` }
  })

  // Answered ones this client is responsible for: it asked, so it reports what came back. A
  // permission somebody else answered simply leaves the pending list; it is not this browser's to
  // narrate, and the transcript deliberately shows no permission history (see `messagesFromItems`).
  const settled = inputs.submitted
    .filter((entry) => !pendingIds.has(entry.permissionId))
    .map((entry): PermissionPrompt => {
      const outcome = entry.toolCallId === null ? undefined : decided.get(entry.toolCallId)?.['outcome']
      return {
        permissionId: entry.permissionId,
        title: entry.title,
        options: [],
        state: outcome === undefined ? 'sent' : 'answered',
        label: outcome === undefined
          ? `Réponse envoyée (${entry.optionName}) — en attente de sa prise en compte par le harnais.`
          : `${entry.title} — ${describeOutcome(outcome, entry)}`,
      }
    })

  return [...live, ...settled]
}

/**
 * The outcome as the wire recorded it. `selected` is reported by the option that was actually
 * carried, which is not necessarily the one this browser believes it sent — if they differ, the
 * wire is right and saying so is the point of reading it back.
 */
function describeOutcome(outcome: unknown, submitted: SubmittedPermission): string {
  const value = (outcome ?? {}) as { outcome?: unknown; optionId?: unknown }
  if (value.outcome === 'cancelled') return 'annulée avant d’avoir été tranchée.'
  if (value.outcome === 'selected') {
    const optionId = typeof value.optionId === 'string' ? value.optionId : ''
    const name = optionId === submitted.optionId ? submitted.optionName : optionId
    return `réponse transmise au harnais : « ${name} ».`
  }
  return 'le harnais a répondu, sans dire ce qui a été retenu.'
}

export interface LossExposureView {
  readonly harnessId: string
  readonly factsSinceAnchor: number
  readonly anchoredAt: string
}

/**
 * The loss-exposure banner (CONT-012). A live context with an old Anchor is normal; what is not
 * acceptable is nobody being able to see how much would be lost if it ended now. Returns undefined
 * when there is nothing to say — an Anchor that covers everything, or no Anchor at all, which is a
 * different statement and belongs to the status line, not a banner.
 */
export function lossExposureBanner(exposures: readonly LossExposureView[]): string | undefined {
  const exposed = exposures.filter((exposure) => exposure.factsSinceAnchor > 0)
  if (exposed.length === 0) return undefined
  return exposed
    .map(
      (exposure) =>
        `${exposure.harnessId} : ${String(exposure.factsSinceAnchor)} fait(s) postérieurs au dernier point de reprise (${exposure.anchoredAt}). ` +
        'Ils sont conservés par Agora ; le contexte natif, lui, pourrait ne pas les retrouver.',
    )
    .join(' ')
}

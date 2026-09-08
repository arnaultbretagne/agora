/**
 * agora — the chat surface, ported from the OLD channels-era UI (`/srv/agora/website/public/app.js`)
 * onto this engine's product API. Same shell, same French copy, same interaction model: push
 * sidebar with grouped history, flat message style, one cluster of selectors that lives in the
 * composer until a Session exists and then moves to the topbar.
 *
 * What changed underneath, and why the shape of this file follows from it:
 *
 *  - The OLD hub served one pre-chewed "conversation" object carrying state/kind/model/effort/agent
 *    and pushed everything over a single global WebSocket. This engine publishes those as separate
 *    facts with separate owners; `view-model.ts` holds every re-derivation, so this file stays about
 *    rendering and intent.
 *  - Live updates are per-Workstream SSE (`GET /v1/workstreams/{id}/feed`), not one global socket,
 *    so the OPEN conversation is genuinely live while the sidebar is refreshed on a poll. That is a
 *    real reduction in liveness versus the OLD `snapshot`/`conv`/`conv_deleted` broadcast, and the
 *    engine has no global feed to restore it with.
 *  - Persona and equipment are launch arguments frozen on a Session, so "changing" either opens a
 *    new Session with a Handoff rather than mutating the running one — which is exactly what the
 *    OLD UI already told the user about re-equipping (ADR 0012 §3), now true of the persona too.
 *
 * Rendering is `innerHTML` from escaped strings, as in the OLD UI. Every interpolation of engine or
 * user data goes through `escapeHtml`, and agent prose goes through `renderMarkdown`, which escapes
 * before it wraps — there is no path from untrusted text to markup here.
 *
 * INVARIANT: nothing here ever reads a Command's state. `POST /v1/workstreams` answers 202 with a
 * `commandId`, but a `CreateWorkstream` row never leaves `accepted` (confirmed live across every
 * such row in the database; `PromptSession` settles normally — tracked as its own defect, and it
 * predates this UI). Progress is therefore derived only from facts that do move: the Session's phase
 * and the Turn's status. A "creating…" state gated on a terminal Command would hang forever, so
 * `getCommand` is deliberately absent from `api.ts` rather than merely unused.
 */

import {
  ApiError,
  createWorkstream,
  decidePermission,
  getCatalogue,
  getIntent,
  getWorkstream,
  listItems,
  listPendingPermissions,
  listSessions,
  listWorkstreams,
  patchWorkstream,
  promptSession,
  putIntent,
  subscribeFeed,
  type Catalogue,
  type FeedEvent,
  type IntentRequestBody,
  type PendingPermission,
  type SessionsView,
  type WorkstreamIntentView,
  type WorkstreamRecord,
} from './api.js'
import { icons } from './icons.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import {
  deriveStatus,
  groupWorkstreams,
  hasRunningTurn,
  lossExposureBanner,
  messagesFromItems,
  permissionPrompts,
  planTranscript,
  type ChatMessage,
  type SubmittedPermission,
  type RenderedRow,
  type WorkstreamItem,
  type WorkstreamStatus,
  type WorkstreamTurn,
} from './view-model.js'

/**
 * Recorded on the Session and never resolved: since P11 a Session Runtime's workspace is always an
 * ephemeral per-Pod `emptyDir` (apps/session-runtime-controller/src/pod-spec.ts), so this is a
 * truthful label for what the Session actually gets, not a reference to storage that exists.
 */
const WORKSPACE_REF = 'ephemeral'

/** How often the sidebar re-reads the Workstream list. Only the OPEN Workstream has a real live feed; this is what stands in for the OLD global socket for everything else. */
const LIST_POLL_INTERVAL_MS = 6_000

const MOBILE_QUERY = '(max-width: 700px)'

type MenuKey = 'harness' | 'model' | 'effort' | 'capabilities'

/**
 * A user turn the operator just sent, shown until the projector catches up with it.
 *
 * Purely optimistic now: since 2026-08-07 the projector folds `session/prompt` into a real `user`
 * message (PROJECTOR_VERSION 2026-08-07), so an echo's whole life is the few hundred milliseconds
 * between hitting send and the feed delivering the projected item, after which it is replaced by
 * the durable one.
 *
 * Before that it was the ONLY way a user's own words appeared at all, and because nothing ever
 * replaced them they accumulated at the bottom of the transcript while the Agent's replies ran
 * together above — which is exactly how the conversation looked, and read, when it was reported
 * broken.
 */
interface PendingEcho {
  readonly id: string
  readonly text: string
  readonly seq: number
}

const state = {
  workstreams: new Map<string, WorkstreamRecord>(),
  /** Sessions and loss exposure for the OPEN Workstream (GET /v1/workstreams/{id}/sessions). */
  sessionsView: null as SessionsView | null,
  /** The `updatedAt` a Workstream had when its detail was last fetched, so the poll refetches only what actually moved. */
  detailSeenAt: new Map<string, string>(),
  activeId: null as string | null,
  items: [] as WorkstreamItem[],
  turns: [] as WorkstreamTurn[],
  echoes: [] as PendingEcho[],
  /** The reviewed public values an Intent may name (GET /v1/catalogue). The browser selects; it never invents. */
  catalogue: undefined as Catalogue | undefined,
  /** True while a prompt this client sent is possibly-accepted-response-lost (CONT-005). */
  deliveryUnknown: false,
  /** Permission requests the agent is blocked on, with the options it offered (S12 Step 4). */
  pendingPermissions: [] as PendingPermission[],
  /** Answers this client has sent and not yet seen come back on the wire. Never treated as outcomes. */
  submittedPermissions: [] as SubmittedPermission[],
  search: '',
  theme: localStorage.getItem('agora.theme') ?? 'light',
  sidebarOpen: localStorage.getItem('agora.sidebar') !== 'closed',
  openMenu: null as MenuKey | null,
  feedLive: false,
  /**
   * The Intent being composed. It is a COMPLETE desired state, always: authoring sends every field,
   * because a partial Intent would be a patch, and a patch is a request to guess what the operator
   * left out.
   */
  draft: {
    harness: '',
    capabilities: [] as string[],
    model: '',
    effort: '',
  },
  unsubscribeFeed: undefined as (() => void) | undefined,
  /** Latest Intent event and operational work view for the OPEN Workstream (S2 control plane). */
  intentView: null as WorkstreamIntentView | null,
  /**
   * The first message of a brand-new conversation, held until it can actually be delivered.
   *
   * Starting a conversation from the composer is one gesture but three server-side steps: create the
   * Workstream, author the complete Intent, and prompt. Only the third can be refused for a reason
   * that resolves by waiting — a Pod has to be built, a credential granted, a Session opened — so
   * the message waits here instead of being dropped. It used to be dropped: the text became the
   * title and nothing else, which looked from the operator's side like a send that did nothing.
   */
  pendingPrompt: null as string | null,
}

const isMobile = (): boolean => matchMedia(MOBILE_QUERY).matches

/**
 * Every collection this client stores comes off the wire, and a render pass runs whether or not the
 * fetch that filled it succeeded. Coercing at the boundary — rather than optional-chaining at each
 * of the dozens of read sites — is what makes "state always holds an array" true by construction.
 *
 * Not hypothetical: the first run of `client-boot.test.ts` (which answers every request with a
 * well-formed but empty body) crashed in `renderComposer` because a missing `items` had been stored
 * verbatim and `state.agents.find` was reached from OUTSIDE the try/catch that had already swallowed
 * the real error. A half-rendered app with no visible cause is worse than a toast.
 */
function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : []
}

const $sidebar = document.getElementById('sidebar')
const $main = document.getElementById('main')
const $scrim = document.getElementById('scrim')
const $app = document.getElementById('app')
if (!$sidebar || !$main || !$scrim || !$app) throw new Error('unreachable: the app shell is in index.html')

/* ------------------------------------------------------------------ *
 *  derived state                                                      *
 * ------------------------------------------------------------------ */

function activeWorkstream(): WorkstreamRecord | undefined {
  return state.activeId ? state.workstreams.get(state.activeId) : undefined
}

/** The Session currently holding attribution, if any. There is no phase to read — one exists or it does not. */
function activeSession(): SessionsView['sessions'][number] | undefined {
  return state.sessionsView?.sessions.find((session) => session.attributionEndedAt === null)
}

/**
 * The status shown wherever a Workstream is named. Derived on every render from the operational
 * view and this client's own knowledge of an ambiguous send — never a stored phase, because none
 * exists (ADR 0002/0003).
 */
function statusOf(): WorkstreamStatus {
  return deriveStatus({
    intent: state.intentView === null ? null : { work: state.intentView.work },
    deliveryUnknown: state.deliveryUnknown,
    observedAt: new Date(),
  })
}

/** The harness in force: the Intent's, or the draft's before one is authored. */
function selectedHarness(): string {
  return state.intentView?.intent.harness ?? state.draft.harness ?? ''
}

function selectedModel(): string {
  return state.intentView?.intent.model ?? state.draft.model ?? ''
}

function selectedEffort(): string {
  return state.intentView?.intent.effort ?? state.draft.effort ?? ''
}

function selectedCapabilities(): readonly string[] {
  return state.intentView?.intent.capabilities ?? state.draft.capabilities
}

function harnessEntry(harnessId: string): Catalogue['harnesses'][number] | undefined {
  return state.catalogue?.harnesses.find((harness) => harness.id === harnessId)
}

/** The efforts valid for the SELECTED model — never a flat list, which could offer one the model does not have. */
function effortsForSelection(): readonly string[] {
  return harnessEntry(selectedHarness())?.models.find((model) => model.id === selectedModel())?.efforts ?? []
}

/* ------------------------------------------------------------------ *
 *  shell                                                              *
 * ------------------------------------------------------------------ */

function applyTheme(): void {
  document.documentElement.dataset['theme'] = state.theme
  localStorage.setItem('agora.theme', state.theme)
}

function applySidebar(): void {
  $app!.classList.toggle('sidebar-open', state.sidebarOpen)
  localStorage.setItem('agora.sidebar', state.sidebarOpen ? 'open' : 'closed')
}

/** Collapsing has to re-render the topbar as well: the menu button only exists there while the sidebar is shut, and it is the only way back. */
function setSidebar(open: boolean): void {
  state.sidebarOpen = open
  applySidebar()
  renderTopbar()
}

function toast(text: string, isError = false): void {
  const node = document.createElement('div')
  node.className = `toast ${isError ? 'error' : ''}`
  node.textContent = text
  $main!.append(node)
  setTimeout(() => node.remove(), 4000)
}

/** Problem+json carries the operator-actionable sentence in `detail`; the `title` alone is often just the code restated. */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 *  sidebar                                                            *
 * ------------------------------------------------------------------ */

function renderSidebar(): void {
  const groups = groupWorkstreams([...state.workstreams.values()].map((workstream) => ({ ...workstream, pinned: false })), state.search, new Date())

  $sidebar!.innerHTML = `
    <div class="sidebar-inner">
      <div class="sidebar-header">
        <span class="brand-mark">${icons.brand(24)}</span>
        <span class="brand-name">Agora</span>
        <button class="icon-btn muted" id="theme-toggle" aria-label="Thème" title="Thème clair/sombre">${state.theme === 'dark' ? icons.sun(17) : icons.moon(17)}</button>
        <button class="icon-btn" id="sidebar-close" aria-label="Réduire le panneau">${isMobile() ? icons.x(18) : icons.chevronLeft(18)}</button>
      </div>
      <button class="new-chat" id="new-chat">${icons.plus(17)}<span>Nouvelle conversation</span></button>
      <div class="search-box">${icons.search(16)}<input id="search" placeholder="Rechercher" value="${escapeHtml(state.search)}"></div>
      <div class="conv-list">
        ${groups
          .map(
            (group) => `
          <div>
            <div class="group-label">${group.key === 'pinned' ? icons.star(11, true) : ''}<span>${group.label}</span></div>
            ${group.items
              .map((workstream) => {
                // Only the OPEN Workstream has a status: deriving one for every row would mean
                // fetching an operational view per row, and showing a stale one is worse than
                // showing none.
                const open = workstream.id === state.activeId
                const status = open ? statusOf() : undefined
                return `
              <button class="conv-item ${status ? `state-${status.kind}` : ''} ${open ? 'active' : ''}" data-conv="${escapeHtml(workstream.id)}">
                <span class="conv-dot"${status ? ` title="${escapeHtml(status.label)}"` : ''}></span>
                <span class="conv-title">${escapeHtml(workstream.title)}</span>
              </button>`
              })
              .join('')}
          </div>`,
          )
          .join('')}
      </div>
      <div class="sidebar-footer" id="identity" role="button" tabindex="0" title="Changer d'identité (dev)">
        <span class="avatar-initials">${escapeHtml(identityInitials())}</span>
        <span class="footer-id">
          <span class="footer-name">${escapeHtml(identityName())}</span>
          <span class="footer-plan">Agora · self-hosted</span>
        </span>
      </div>
    </div>`

  $sidebar!.querySelector<HTMLElement>('#sidebar-close')?.addEventListener('click', () => setSidebar(false))
  $sidebar!.querySelector<HTMLElement>('#theme-toggle')?.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark'
    applyTheme()
    renderSidebar()
  })
  $sidebar!.querySelector<HTMLElement>('#new-chat')?.addEventListener('click', newChat)
  const identity = $sidebar!.querySelector<HTMLElement>('#identity')
  identity?.addEventListener('click', promptForPrincipal)
  // It says `role="button"` and takes focus, so it has to answer Enter and Space the way a button
  // does — an element that claims a role and does not honour it is worse than an unlabelled div.
  identity?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      promptForPrincipal()
    }
  })

  const search = $sidebar!.querySelector<HTMLInputElement>('#search')
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value
      renderSidebar()
      // The whole sidebar is replaced on every keystroke (the OLD UI's approach), so focus and the
      // caret have to be restored explicitly or typing stops after one character.
      const refocused = $sidebar!.querySelector<HTMLInputElement>('#search')
      refocused?.focus()
      refocused?.setSelectionRange(refocused.value.length, refocused.value.length)
    })
  }
  for (const node of $sidebar!.querySelectorAll<HTMLElement>('[data-conv]')) {
    node.addEventListener('click', (event) => {
      void selectWorkstream(node.dataset['conv'] ?? '')
    })
  }
}

/**
 * The OLD UI hard-coded "Arnault" in the footer because its server had no identity at all. Here the
 * principal is real: in production oauth2-proxy forwards the verified identity and the browser sends
 * nothing, so this shows the SSO placeholder; when a principal is set by hand (the dev bearer shim
 * this server also accepts) it shows that instead, and the block doubles as the way to change it.
 */
function currentPrincipal(): string {
  return localStorage.getItem('agora.principal') ?? ''
}

function identityName(): string {
  return currentPrincipal() || 'Session SSO'
}

function identityInitials(): string {
  const principal = currentPrincipal()
  if (!principal) return 'ID'
  return principal.slice(0, 2).toUpperCase()
}

function promptForPrincipal(): void {
  const next = prompt('Identifiant (laisser vide pour utiliser le SSO) :', currentPrincipal())
  if (next === null) return
  if (next.trim()) localStorage.setItem('agora.principal', next.trim())
  else localStorage.removeItem('agora.principal')
  renderSidebar()
  void reload()
}

/* ------------------------------------------------------------------ *
 *  topbar                                                             *
 * ------------------------------------------------------------------ */

/**
 * The chip is the DERIVED status, not a stored phase. Its CSS class is the status kind, so an
 * operator reading "Réconciliation en cours : …" and the colour beside it are reading one fact.
 */
function stateChip(): string {
  const status = statusOf()
  return `<span class="chip state ${status.kind}"><span class="dot"></span>${escapeHtml(status.label)}</span>`
}

function renderTopbar(): void {
  const workstream = activeWorkstream()
  const power = state.intentView?.intent.power
  const work = state.intentView?.work
  const powerTitle = work
    ? `due ${new Date(work.dueAt).toLocaleString()} · ${work.attemptCount} tentative(s)${work.blockingCause ? ` · ${work.blockingCause}` : ''} — état opérationnel, pas une preuve de convergence`
    : 'Aucune demande de power enregistrée'
  const bar = $main!.querySelector('.topbar')
  if (!bar) return renderMain()
  bar.innerHTML = `
    <div class="topbar-left">
      ${!state.sidebarOpen || isMobile() ? `<button class="icon-btn" id="menu-btn" aria-label="Menu">${icons.menu(19)}</button>` : ''}
      <span class="topbar-title" id="topbar-title" title="Double-clic pour renommer">${escapeHtml(workstream ? workstream.title : 'Nouvelle conversation')}</span>
    </div>
    <div class="topbar-right">
      ${workstream ? stateChip() : ''}
      ${workstream ? selectorsCluster() : ''}
      ${
        workstream
          ? `<button class="icon-btn muted labelled" id="power-toggle" title="Power ${power === 'on' ? 'off' : 'on'} — ${escapeHtml(powerTitle)}">${icons.power(17)}<span class="power-label">${power === 'on' ? 'ON' : 'OFF'}</span></button>`
          : ''
      }
      ${
        workstream
          ? `<button class="icon-btn muted labelled" id="apply-intent" title="Enregistrer cette intention complète (harnais, capacités, modèle, effort)">Appliquer</button>`
          : ''
      }
      ${workstream ? `<button class="icon-btn muted" id="delete-conv" title="Supprimer la conversation">${icons.trash(17)}</button>` : ''}
      ${isMobile() ? `<button class="icon-btn" id="mobile-new" aria-label="Nouvelle conversation">${icons.plus(19)}</button>` : ''}
    </div>`
  bar.querySelector<HTMLElement>('#menu-btn')?.addEventListener('click', () => setSidebar(true))
  bar.querySelector<HTMLElement>('#mobile-new')?.addEventListener('click', newChat)
  bar.querySelector<HTMLElement>('#power-toggle')?.addEventListener('click', () => void togglePower())
  // Applying keeps the power the Intent already has: this button changes the selections, not whether
  // execution is wanted. Conflating the two is how an operator turns something on by editing a model.
  bar.querySelector<HTMLElement>('#apply-intent')?.addEventListener('click', () => void authorIntent(state.intentView?.intent.power ?? 'off'))
  bar.querySelector<HTMLElement>('#delete-conv')?.addEventListener('click', () => void removeWorkstream(state.activeId))
  bar.querySelector<HTMLElement>('#topbar-title')?.addEventListener('dblclick', () => void renameWorkstream(state.activeId))
  if (workstream) wireSelectors(bar)
}

/* ------------------------------------------------------------------ *
 *  messages                                                           *
 * ------------------------------------------------------------------ */

/**
 * The projected transcript, plus any echo the projector has not caught up with yet.
 *
 * Retired echoes are matched by COUNT, not just by presence: asking the same question twice is
 * ordinary, and a set membership test would have let one projected copy retire both echoes, making
 * the second question vanish from the screen until a refetch brought it back.
 */
function transcript(): ChatMessage[] {
  const projected = messagesFromItems(state.items)
  const remaining = new Map<string, number>()
  for (const message of projected) {
    if (message.role === 'user') remaining.set(message.text, (remaining.get(message.text) ?? 0) + 1)
  }
  const maxSeq = state.items.reduce((max, item) => Math.max(max, item.firstWorkstreamSeq), 0)
  const echoes = state.echoes
    .filter((echo) => {
      const left = remaining.get(echo.text) ?? 0
      if (left === 0) return true
      remaining.set(echo.text, left - 1)
      return false
    })
    .map((echo) => ({ id: echo.id, role: 'user' as const, text: echo.text, completed: true, seq: echo.seq }))
  const ordered = [
    ...projected.map((message, index) => ({ ...message, seq: index })),
    // Echoes are anchored past every projected item so a message just sent lands at the bottom,
    // which is where the person who just typed it is looking.
    ...echoes.map((echo) => ({ ...echo, seq: maxSeq + 1 + echo.seq })),
  ]
  return ordered.sort((left, right) => left.seq - right.seq).map(({ seq: _seq, ...message }) => message)
}

/**
 * The markdown each row currently shows. Keyed by the element itself, so a row that leaves the
 * document takes its entry with it and nothing has to be cleaned up.
 *
 * It exists for two things: skipping the re-render of a row whose text has not moved, and
 * recognising a pending echo as already displaying the words the projected message brings back
 * under a different id.
 */
const renderedText = new WeakMap<HTMLElement, string>()

/**
 * Messaging-app paradigm, carried over verbatim: a bubble = the user speaking (no name, no avatar);
 * the agent's answers sit bare on the conversation background.
 *
 * What the transcript deliberately does NOT show is what the agent DID to answer. The OLD hub had no
 * record of tool calls at all; this engine projects every one of them, and showing them here is now
 * a real option — but the reason they were left out has not changed, so neither has the rendering: a
 * conversation reads as a conversation. Same for equipment, which is a permission held for a whole
 * Session and never evidence that a given turn used it.
 *
 * Why this RECONCILES rather than assigning `innerHTML`, which is what everything else in this file
 * does: a streaming reply arrives as one feed upsert PER CHUNK — the projector appends each
 * `agent_message_chunk` to the same item (packages/store-pg/src/projector.ts) — so this function
 * runs dozens of times a second while an answer is being written. Rebuilding the transcript each
 * time destroyed and recreated every row in the conversation, which re-fired `.msg-row`'s 160 ms
 * fade-in on all of them at once: reported live 2026-08-08 as "l'écran clignote lors d'une réponse".
 * It also dropped any text selection and re-ran layout for the whole list on every chunk.
 *
 * So rows are keyed by message id, and only what actually changed is touched.
 */
function renderMessages(): void {
  const wrap = $main!.querySelector<HTMLElement>('.messages')
  if (!wrap) return
  const workstream = activeWorkstream()
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 140

  if (!workstream) {
    wrap.innerHTML = `
      <div class="empty">
        <span class="brand-mark">${icons.brand(44)}</span>
        <h1>Bonjour.</h1>
      </div>`
    return
  }

  let inner = wrap.querySelector<HTMLElement>('.messages-inner')
  if (!inner) {
    wrap.innerHTML = '<div class="messages-inner"></div>'
    inner = wrap.querySelector<HTMLElement>('.messages-inner')
    if (!inner) return
  }
  reconcileMessages(inner, transcript())
  reconcileTypingRow(inner, hasRunningTurn(state.turns))
  if (nearBottom) wrap.scrollTop = wrap.scrollHeight
}

function messageRow(message: ChatMessage): HTMLElement {
  const row = document.createElement('div')
  row.className = `msg-row ${message.role === 'user' ? 'user' : 'assistant'}`
  row.dataset['id'] = message.id
  row.dataset['role'] = message.role
  row.innerHTML = `<div class="msg-text">${renderMarkdown(message.text)}</div>`
  renderedText.set(row, message.text)
  return row
}

function reconcileMessages(inner: HTMLElement, messages: readonly ChatMessage[]): void {
  const elements = new Map<string, HTMLElement>()
  const rendered: RenderedRow[] = []
  for (const row of Array.from(inner.querySelectorAll<HTMLElement>('.msg-row[data-id]'))) {
    const id = row.dataset['id'] ?? ''
    elements.set(id, row)
    rendered.push({ id, role: row.dataset['role'] === 'user' ? 'user' : 'agent', text: renderedText.get(row) ?? '' })
  }

  const plan = planTranscript(rendered, messages)
  let anchor: ChildNode | null = inner.firstChild
  for (const step of plan.rows) {
    const reused = step.reuse === undefined ? undefined : elements.get(step.reuse)
    const row = reused ?? messageRow(step.message)
    if (reused) {
      // An adopted echo keeps its element and takes the projected message's id with it.
      reused.dataset['id'] = step.message.id
      if (step.rerender) {
        const text = reused.querySelector<HTMLElement>('.msg-text')
        if (text) text.innerHTML = renderMarkdown(step.message.text)
        renderedText.set(reused, step.message.text)
      }
    }
    if (anchor === row) anchor = row.nextSibling
    else inner.insertBefore(row, anchor)
  }

  for (const id of plan.removed) elements.get(id)?.remove()
}

/** Kept out of the keyed pass because it carries no id and must always be last — it is the agent about to speak, not something it has said. */
function reconcileTypingRow(inner: HTMLElement, running: boolean): void {
  const existing = inner.querySelector<HTMLElement>('.msg-row.typing')
  if (!running) {
    existing?.remove()
    return
  }
  if (existing) {
    if (existing !== inner.lastChild) inner.append(existing)
    return
  }
  const row = document.createElement('div')
  row.className = 'msg-row assistant typing'
  row.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>'
  inner.append(row)
}

/**
 * Feed frames arrive far faster than the screen refreshes, so renders triggered BY THE FEED are
 * collapsed to at most one per frame. Anything the operator does themselves still renders
 * synchronously — a click that waits for the next frame reads as a dropped click.
 *
 * The `typeof` guard is not decoration: this module is imported and evaluated under bare node by
 * `test/client-boot.test.ts`, and a missing browser global at module scope is a blank page.
 */
const nextFrame: (run: () => void) => number =
  typeof requestAnimationFrame === 'function' ? (run) => requestAnimationFrame(run) : (run) => setTimeout(run, 16) as unknown as number

let queuedRender = 0
function scheduleMessagesRender(): void {
  if (queuedRender !== 0) return
  queuedRender = nextFrame(() => {
    queuedRender = 0
    renderMessages()
  })
}

/* ------------------------------------------------------------------ *
 *  selectors                                                          *
 * ------------------------------------------------------------------ */

function selectorButton(
  id: string,
  iconName: 'shield' | 'message' | null,
  label: string,
  options: { disabled?: boolean; title?: string } = {},
): string {
  // `aria-expanded` and `aria-controls` are what make this a disclosure rather than a button whose
  // effect is only visible to someone who can see the panel appear (S12 Step 5).
  const expanded = state.openMenu !== null && `sel-${state.openMenu}` === id
  return `
    <div class="selector">
      <button class="selector-btn" id="${id}" aria-haspopup="true" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${id}-menu" ${options.disabled ? 'disabled' : ''}${options.title ? ` title="${escapeHtml(options.title)}"` : ''}>
        ${iconName ? `<span class="sel-icon">${icons[iconName](14)}</span>` : ''}
        <span id="${id}-label">${escapeHtml(label)}</span>
        <span class="sel-chevron">${icons.chevronDown(13)}</span>
      </button>
      <div id="${id}-menu"></div>
    </div>`
}

/**
 * The Intent editor's four selections, in one cluster (S12).
 *
 * Every value comes from `GET /v1/catalogue` — the reviewed public values, the same ones the server
 * validates an Intent against. The browser never invents a harness, a model, an effort or a
 * capability; if it is not offered here it is refused there, which is why the two lists have one
 * source rather than two that agree until they do not.
 *
 * Nothing locks. Changing a selection authors a NEW complete Intent, and what that implies —
 * replacing a Pod, ending a Session, restoring an Anchor — is the rule tables' decision, not this
 * cluster's. A disabled selector would be this file claiming to know that decision.
 */
function selectorsCluster(): string {
  const harness = selectedHarness()
  const model = selectedModel()
  const effort = selectedEffort()
  const capabilities = selectedCapabilities()
  return `
    <div class="selectors">
      ${selectorButton('sel-harness', null, harness || 'Harness', { disabled: (state.catalogue?.harnesses.length ?? 0) === 0 })}
      ${selectorButton('sel-model', null, model || 'Modèle', { disabled: harness === '' })}
      ${selectorButton('sel-effort', null, effort || 'Effort', { disabled: model === '' })}
      ${selectorButton('sel-capabilities', 'shield', capabilities.length === 0 ? 'Aucune capacité' : capabilities.join(', '), {})}
    </div>`
}

function wireSelectors(root: ParentNode): void {
  root.querySelector<HTMLElement>('#sel-harness')?.addEventListener('click', () => toggleMenu('harness'))
  root.querySelector<HTMLElement>('#sel-model')?.addEventListener('click', () => toggleMenu('model'))
  root.querySelector<HTMLElement>('#sel-effort')?.addEventListener('click', () => toggleMenu('effort'))
  root.querySelector<HTMLElement>('#sel-capabilities')?.addEventListener('click', () => toggleMenu('capabilities'))
}

function toggleMenu(which: MenuKey): void {
  state.openMenu = state.openMenu === which ? null : which
  renderMenus()
  syncSelectorExpansion()
  // Opening with the keyboard has to put the caret somewhere inside what just opened, or the next
  // Tab continues past the menu and the person never reaches the options they asked for.
  if (state.openMenu === which) $main!.querySelector<HTMLElement>(`#sel-${which}-menu .menu-row`)?.focus()
}

/**
 * Closes the open menu and returns focus to the control that opened it. `restoreFocus` is what a
 * keyboard user needs and a mouse user never notices: dismissing a panel without it drops the caret
 * back to the top of the document.
 */
function closeMenu(restoreFocus = false): void {
  const which = state.openMenu
  state.openMenu = null
  renderMenus()
  syncSelectorExpansion()
  if (restoreFocus && which !== null) $main!.querySelector<HTMLElement>(`#sel-${which}`)?.focus()
}

/** The triggers are re-rendered far less often than the menus they control, so their state is synced in place. */
function syncSelectorExpansion(): void {
  for (const [key] of MENU_HOSTS) {
    $main!.querySelector<HTMLElement>(`#sel-${key}`)?.setAttribute('aria-expanded', state.openMenu === key ? 'true' : 'false')
  }
}

const MENU_HOSTS: readonly (readonly [MenuKey, string])[] = [
  ['harness', 'sel-harness-menu'],
  ['model', 'sel-model-menu'],
  ['effort', 'sel-effort-menu'],
  ['capabilities', 'sel-capabilities-menu'],
]

/**
 * `attribute` is always a literal chosen in this file — never interpolated from engine or catalogue
 * data. Attribute NAMES sit outside anything `escapeHtml` can protect, so untrusted text there would
 * escape the attribute no matter how the value is quoted.
 */
function menuRow(
  attribute: string,
  value: string,
  name: string,
  options: { selected: boolean; description?: string; icon?: 'shield' | 'message' },
): string {
  return `
    <button class="menu-row ${options.selected ? 'selected' : ''}" ${attribute}="${escapeHtml(value)}">
      ${options.icon ? `<span class="row-icon">${icons[options.icon](16)}</span>` : ''}
      <span class="row-main">
        <span class="row-name">${escapeHtml(name)}</span>
        ${options.description ? `<span class="row-desc">${escapeHtml(options.description)}</span>` : ''}
      </span>
      ${options.selected ? `<span class="row-check">${icons.check(16)}</span>` : ''}
    </button>`
}

function renderMenus(): void {
  for (const [key, hostId] of MENU_HOSTS) {
    const host = $main!.querySelector<HTMLElement>(`#${hostId}`)
    if (!host) continue
    if (state.openMenu !== key) {
      host.innerHTML = ''
      continue
    }
    if (key === 'harness') renderHarnessMenu(host)
    if (key === 'model') renderModelMenu(host)
    if (key === 'effort') renderEffortMenu(host)
    if (key === 'capabilities') renderCapabilitiesMenu(host)
  }

  let backdrop = $main!.querySelector<HTMLElement>('.menu-backdrop')
  if (state.openMenu && !backdrop) {
    backdrop = document.createElement('div')
    backdrop.className = 'menu-backdrop'
    // Click-to-dismiss is a mouse affordance; Escape (wired in `init`) is its keyboard equivalent,
    // and a panel with only the former is a panel a keyboard user cannot get out of.
    backdrop.addEventListener('click', () => closeMenu())
    $main!.append(backdrop)
  } else if (!state.openMenu && backdrop) {
    backdrop.remove()
  }
}

function renderHarnessMenu(host: HTMLElement): void {
  const harnesses = state.catalogue?.harnesses ?? []
  host.innerHTML = `
    <div class="menu"><div class="menu-label">Harness</div>
      ${harnesses.map((harness) => menuRow('data-harness', harness.id, harness.id, { selected: harness.id === selectedHarness() })).join('')}
      ${harnesses.length === 0 ? '<div class="menu-note">Le catalogue ne publie aucun harness.</div>' : ''}
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-harness]')) {
    node.addEventListener('click', () => {
      // One harness's model names are not another's, so a harness change clears both — offering the
      // previous model would offer a value the server is about to refuse.
      state.draft.harness = node.dataset['harness'] ?? ''
      state.draft.model = ''
      state.draft.effort = ''
      state.openMenu = null
      renderComposer()
      renderTopbar()
      renderMenus()
    })
  }
}

function renderModelMenu(host: HTMLElement): void {
  const models = harnessEntry(selectedHarness())?.models ?? []
  host.innerHTML = `
    <div class="menu"><div class="menu-label">Modèle</div>
      ${models.map((model) => menuRow('data-model', model.id, model.id, { selected: model.id === selectedModel() })).join('')}
      ${models.length === 0 ? '<div class="menu-note">Choisissez d’abord un harness.</div>' : ''}
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-model]')) {
    node.addEventListener('click', () => {
      state.draft.model = node.dataset['model'] ?? ''
      // The efforts a model accepts are the model's own; keeping the previous one would offer a
      // value that is valid for a model nobody selected any more.
      state.draft.effort = ''
      state.openMenu = null
      renderComposer()
      renderTopbar()
      renderMenus()
    })
  }
}

function renderEffortMenu(host: HTMLElement): void {
  const efforts = effortsForSelection()
  host.innerHTML = `
    <div class="menu"><div class="menu-label">Effort</div>
      ${efforts.map((effort) => menuRow('data-effort', effort, effort, { selected: effort === selectedEffort() })).join('')}
      ${efforts.length === 0 ? '<div class="menu-note">Choisissez d’abord un modèle.</div>' : ''}
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-effort]')) {
    node.addEventListener('click', () => {
      state.draft.effort = node.dataset['effort'] ?? ''
      state.openMenu = null
      renderComposer()
      renderTopbar()
      renderMenus()
    })
  }
}

/**
 * Capabilities are a FLAT named set (ADR 0001, 006): no profiles, no combinations, no hierarchy —
 * each is an independent fact the Broker either grants or does not. The menu is a multi-select for
 * exactly that reason, and it names capabilities rather than the scopes or endpoints behind them,
 * which are the Broker's alone to decide.
 */
function renderCapabilitiesMenu(host: HTMLElement): void {
  const available = state.catalogue?.capabilities ?? []
  const chosen = selectedCapabilities()
  host.innerHTML = `
    <div class="menu right"><div class="menu-label">Capacités</div>
      ${available
        .map((capability) => menuRow('data-capability', capability, capability, { selected: chosen.includes(capability), icon: 'shield' }))
        .join('')}
      ${available.length === 0 ? '<div class="menu-note">Le catalogue ne publie aucune capacité.</div>' : ''}
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-capability]')) {
    node.addEventListener('click', () => {
      const capability = node.dataset['capability'] ?? ''
      const current = new Set(selectedCapabilities())
      if (current.has(capability)) current.delete(capability)
      else current.add(capability)
      state.draft.capabilities = [...current].sort()
      // The panel stays open: choosing a set is one decision made of several clicks.
      renderComposer()
      renderTopbar()
      renderMenus()
    })
  }
}

/* ------------------------------------------------------------------ *
 *  composer                                                           *
 * ------------------------------------------------------------------ */

/**
 * Why the composer is closed, or undefined when it is open.
 *
 * There is one reason, and it is CONT-005: a previous prompt may have been accepted and its response
 * lost. Sending again could duplicate an external effect the first one already produced, so the
 * composer says so rather than letting the operator find out.
 */
function composerLockReason(): string | undefined {
  const status = statusOf()
  // A held first message outranks the generic reason: what the operator needs to know is that their
  // text is not lost and what it is waiting for.
  if (state.pendingPrompt !== null) {
    return `Votre message part dès que la session est prête. ${status.blocksSending ? `${status.label} ${status.remediation ?? ''}`.trim() : status.label}`.trim()
  }
  return status.blocksSending ? `${status.label} ${status.remediation ?? ''}`.trim() : undefined
}

/** The rendered DOM is the record of which composer is on screen, so no second copy of that state can drift from it. Re-renders only on an actual transition, because re-rendering steals focus mid-typing. */
function syncComposerLock(): void {
  if (Boolean(composerLockReason()) !== Boolean($main!.querySelector('.composer-locked'))) renderComposer()
}

function renderComposer(): void {
  const composer = $main!.querySelector<HTMLElement>('.composer-wrap')
  if (!composer) return
  const previous = composer.querySelector<HTMLTextAreaElement>('#input')?.value ?? ''

  const locked = composerLockReason()
  if (locked) {
    composer.innerHTML = `<div class="composer"><div class="composer-locked">${escapeHtml(locked)}</div></div>`
    return
  }

  composer.innerHTML = `
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Écrivez votre demande…"></textarea>
      <div class="composer-row">
        ${needsIntent() ? selectorsCluster() : ''}
        <button class="send-btn" id="send" aria-label="Envoyer">${icons.send(18)}</button>
      </div>
    </div>`

  const input = composer.querySelector<HTMLTextAreaElement>('#input')
  const send = composer.querySelector<HTMLElement>('#send')
  if (!input || !send) return
  input.value = previous
  const sync = (): void => {
    // Reset to `auto` first: `scrollHeight` on an element already sized to its content reports that
    // size, so without this the box can grow but never shrink again.
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`
    send.classList.toggle('ready', Boolean(input.value.trim()))
  }
  input.addEventListener('input', sync)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void doSend()
    }
  })
  send.addEventListener('click', () => void doSend())
  sync()

  wireSelectors(composer)
}

/**
 * The banner: what the operator must be able to see without asking. A HOLD's cause and its
 * remediation, an ambiguous delivery and its warning, and the native-loss exposure (CONT-012) —
 * which is a real count of facts newer than the newest recovery point, not a mood.
 */
function renderBanner(): void {
  const host = $main!.querySelector<HTMLElement>('.banner')
  if (!host) return
  if (!state.activeId) {
    host.innerHTML = ''
    return
  }
  const status = statusOf()
  const loss = lossExposureBanner(state.sessionsView?.lossExposure ?? [])
  const notes = [
    status.kind === 'converged' || status.kind === 'no-intent' ? '' : `<div class="banner-row ${status.kind}">${escapeHtml(status.label)}${status.remediation ? ` <span class="banner-remediation">${escapeHtml(status.remediation)}</span>` : ''}</div>`,
    loss === undefined ? '' : `<div class="banner-row loss">${escapeHtml(loss)}</div>`,
  ].join('')
  host.innerHTML = notes
}

/**
 * The permission surface (S12 Step 4). It sits between the transcript and the composer because it
 * is a question addressed to the operator right now, not part of the conversation's record — and
 * because that is where the eye already is when something stops.
 *
 * Every option is a real `<button>` inside a `<section role="group">` labelled by the request, so
 * the decision is reachable by keyboard and announced with the question it belongs to; the region
 * is `aria-live="polite"` so a request that arrives while the operator is reading is spoken instead
 * of appearing silently.
 */
function renderPermissions(): void {
  const host = $main!.querySelector<HTMLElement>('.permissions')
  if (!host) return
  const prompts = permissionPrompts({
    pending: state.pendingPermissions,
    items: state.items,
    submitted: state.submittedPermissions,
  })
  if (prompts.length === 0) {
    host.innerHTML = ''
    return
  }
  host.innerHTML = prompts
    .map((prompt) => {
      const labelId = `perm-label-${encodeURIComponent(prompt.permissionId)}`
      const options = prompt.state !== 'asked'
        ? ''
        : `<div class="permission-options">${prompt.options
            .map((option) => `<button class="permission-option" data-permission="${escapeHtml(prompt.permissionId)}" data-option="${escapeHtml(option.optionId)}">${escapeHtml(option.name)}</button>`)
            .join('')}</div>`
      return `<section class="permission ${prompt.state}" role="group" aria-labelledby="${escapeHtml(labelId)}">
        <p class="permission-label" id="${escapeHtml(labelId)}">${escapeHtml(prompt.label)}</p>${options}
      </section>`
    })
    .join('')

  for (const button of host.querySelectorAll<HTMLElement>('.permission-option')) {
    button.addEventListener('click', () => {
      void answerPermission(button.dataset['permission'] ?? '', button.dataset['option'] ?? '')
    })
  }
}

function renderMain(): void {
  $main!.innerHTML = `
    <header class="topbar"></header>
    <div class="banner" role="status" aria-live="polite"></div>
    <div class="messages"></div>
    <div class="permissions" role="region" aria-label="Autorisations" aria-live="polite"></div>
    <div class="composer-wrap"></div>`
  renderTopbar()
  renderBanner()
  renderMessages()
  renderPermissions()
  renderComposer()
  renderMenus()
}

/* ------------------------------------------------------------------ *
 *  actions                                                            *
 * ------------------------------------------------------------------ */

/**
 * Which conversation is open, across a reload. The client already persists the theme, the sidebar
 * and the principal this way; not persisting this one meant every refresh landed on an empty
 * "Nouvelle conversation" and the transcript looked lost — it was not, the client had simply
 * forgotten where it was.
 */
const OPEN_KEY = 'agora.open'

function rememberOpen(workstreamId: string | null): void {
  try {
    if (workstreamId === null) localStorage.removeItem(OPEN_KEY)
    else localStorage.setItem(OPEN_KEY, workstreamId)
  } catch {
    // A browser that refuses storage still works; it just forgets where it was.
  }
}

function newChat(): void {
  unsubscribe()
  state.activeId = null
  rememberOpen(null)
  state.openMenu = null
  state.items = []
  state.turns = []
  state.echoes = []
  state.intentView = null
  state.sessionsView = null
  state.deliveryUnknown = false
  // A permission belongs to the channel it was asked on; neither the pending list nor an answer
  // this client is still waiting on means anything for a different Workstream.
  state.pendingPermissions = []
  state.submittedPermissions = []
  // A draft belongs to the conversation it was typed into: carrying it across would silently
  // author an Intent for a Workstream the operator is no longer looking at.
  state.draft = { harness: '', capabilities: [], model: '', effort: '' }
  if (isMobile()) {
    state.sidebarOpen = false
    applySidebar()
  }
  renderSidebar()
  renderMain()
  $main!.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

function unsubscribe(): void {
  state.unsubscribeFeed?.()
  state.unsubscribeFeed = undefined
  state.feedLive = false
}

async function selectWorkstream(workstreamId: string): Promise<void> {
  if (!workstreamId) return
  unsubscribe()
  state.activeId = workstreamId
  rememberOpen(workstreamId)
  state.openMenu = null
  state.items = []
  state.turns = []
  // Echoes belong to the Workstream they were typed into and cannot be recovered for any other.
  state.echoes = []
  state.intentView = null
  state.sessionsView = null
  state.deliveryUnknown = false
  // A permission belongs to the channel it was asked on; neither the pending list nor an answer
  // this client is still waiting on means anything for a different Workstream.
  state.pendingPermissions = []
  state.submittedPermissions = []
  // A draft belongs to the conversation it was typed into: carrying it across would silently
  // author an Intent for a Workstream the operator is no longer looking at.
  state.draft = { harness: '', capabilities: [], model: '', effort: '' }
  if (isMobile()) {
    state.sidebarOpen = false
    applySidebar()
  }
  renderSidebar()
  renderMain()
  await loadWorkstream(workstreamId)
}

/**
 * The conversation surface: the Workstream record, its projected items and the resumable feed.
 * The transcript is a projection of canonical facts, so it re-reads on select and then follows the
 * feed; no session lifecycle call exists on this API (execution is Intent-driven).
 */
async function loadWorkstream(workstreamId: string): Promise<void> {
  try {
    const record = await getWorkstream(workstreamId)
    state.workstreams.set(workstreamId, record)
    state.echoes = []
    await refreshItems(workstreamId)
    await refreshIntent(workstreamId)
    await refreshSessions(workstreamId)
    await refreshPermissions(workstreamId)
    renderSidebar()
    renderMain()
    subscribe(workstreamId)
  } catch (error) {
    toast(errorText(error), true)
  }
}

/** The projected item, in the shape the transcript folds over. */
function toItem(item: {
  readonly id: string
  readonly sessionId: string
  readonly kind: string
  readonly entityKey: string
  readonly value: Record<string, unknown>
  readonly firstSeq: number
  readonly latestSeq: number
  readonly updatedAt: string
}): WorkstreamItem {
  return {
    id: item.id,
    sessionId: item.sessionId,
    kind: item.kind,
    entityKey: item.entityKey,
    firstWorkstreamSeq: item.firstSeq,
    latestWorkstreamSeq: item.latestSeq,
    value: item.value,
    updatedAt: item.updatedAt,
  }
}

/** The open Workstream's own views, re-read on the same beat as the list, then anything held is sent. */
async function refreshOpenWorkstream(): Promise<void> {
  const workstreamId = state.activeId
  if (workstreamId === null) return
  await refreshIntent(workstreamId)
  await refreshSessions(workstreamId)
  syncComposerLock()
  await flushPendingPrompt()
}

async function refreshItems(workstreamId: string): Promise<void> {
  const page = await listItems(workstreamId)
  if (state.activeId !== workstreamId) return
  state.items = page.items.map((item) => toItem(item))
  renderMessages()
  syncComposerLock()
}

/**
 * The requests the agent is blocked on. Polled off the live channel rather than the projection: a
 * projected `pending` permission proves only that one was ASKED — the channel that could answer it
 * may be long gone, and offering a button that resolves nothing is worse than showing nothing.
 */
async function refreshPermissions(workstreamId: string): Promise<void> {
  try {
    const page = await listPendingPermissions(workstreamId)
    if (state.activeId !== workstreamId) return
    state.pendingPermissions = [...asArray<PendingPermission>(page?.pending)]
  } catch {
    // 503 where the deployment runs without ACP channels, 404 for a Workstream with none. Neither
    // is an operator-facing failure: there is simply nothing to decide.
    state.pendingPermissions = []
  }
  renderPermissions()
}

/**
 * Answers one request. What goes on screen afterwards is `sent`, not `granted`: the decision has
 * left this browser, and the only thing that can say it took effect is the projected outcome
 * (`permissionPrompts`), which arrives over the feed when the response frame is folded.
 */
async function answerPermission(permissionId: string, optionId: string): Promise<void> {
  const workstreamId = state.activeId
  const request = state.pendingPermissions.find((entry) => entry.permissionId === permissionId)
  if (!workstreamId || request === undefined || optionId === '') return
  const option = request.options.find((candidate) => candidate.optionId === optionId)

  state.submittedPermissions = [
    ...state.submittedPermissions.filter((entry) => entry.permissionId !== permissionId),
    {
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      optionId,
      optionName: option?.name ?? optionId,
    },
  ]
  renderPermissions()

  try {
    await decidePermission(workstreamId, permissionId, optionId)
  } catch (error) {
    // The answer never left: drop the optimistic "sent" so the buttons come back rather than
    // leaving the operator watching for an outcome that can never arrive.
    state.submittedPermissions = state.submittedPermissions.filter((entry) => entry.permissionId !== permissionId)
    toast(errorText(error), true)
  }
  await refreshPermissions(workstreamId)
}

/**
 * The Sessions of the open Workstream, and with them the loss exposure CONT-012 insists must be
 * visible: how much of the record is newer than the newest recovery point.
 */
async function refreshSessions(workstreamId: string): Promise<void> {
  try {
    const view = await listSessions(workstreamId)
    if (state.activeId !== workstreamId) return
    state.sessionsView = {
      headSeq: view?.headSeq ?? 0,
      sessions: asArray<SessionsView['sessions'][number]>(view?.sessions),
      lossExposure: asArray<SessionsView['lossExposure'][number]>(view?.lossExposure),
    }
  } catch {
    // A Workstream with no Sessions yet is not an operator-facing error.
    state.sessionsView = null
  }
  renderTopbar()
  renderBanner()
}

/** Feeds carry projector upserts and turn statuses; both are idempotent folds over item ids. */
function applyFeedEvent(workstreamId: string, event: FeedEvent): void {
  if (event.operation === 'upsert' && event.itemId !== null) {
    const item: WorkstreamItem = {
      id: event.itemId,
      sessionId: (event.payload['sessionId'] as string | undefined) ?? '',
      kind: (event.payload['itemKind'] as string | undefined) ?? 'unknown',
      entityKey: (event.payload['entityKey'] as string | undefined) ?? '',
      firstWorkstreamSeq: event.throughSeq,
      latestWorkstreamSeq: event.throughSeq,
      value: event.payload,
      updatedAt: new Date().toISOString(),
    }
    const index = state.items.findIndex((existing) => existing.id === item.id)
    if (index >= 0) state.items[index] = item
    else state.items.push(item)
    scheduleMessagesRender()
    // A permission item moving is the only warning that a request has appeared or been settled;
    // the live list is what says whether it can still be answered here.
    if (item.kind === 'permission') {
      renderPermissions()
      void refreshPermissions(workstreamId)
    }
    return
  }
  if (event.operation === 'status') {
    const commandId = event.payload['commandId'] as string | undefined
    const status = event.payload['status'] as WorkstreamTurn['status'] | undefined
    if (!commandId || !status) return
    const index = state.turns.findIndex((turn) => turn.id === commandId)
    if (index >= 0) {
      const existing = state.turns[index]
      if (existing) state.turns[index] = { ...existing, status }
    } else {
      state.turns.push({
        id: commandId,
        purpose: 'user',
        status,
      })
    }
    renderMessages()
    syncComposerLock()
    return
  }
  if (event.operation === 'reset') {
    void loadWorkstream(workstreamId)
  }
}

function subscribe(workstreamId: string): void {
  state.unsubscribeFeed?.()
  state.unsubscribeFeed = subscribeFeed(
    workstreamId,
    0,
    (event: FeedEvent) => {
      if (state.activeId !== workstreamId) return
      applyFeedEvent(workstreamId, event)
    },
    (status) => {
      state.feedLive = status === 'connected'
    },
  )
}

async function refreshIntent(workstreamId: string): Promise<void> {
  try {
    state.intentView = await getIntent(workstreamId)
  } catch {
    // A Workstream without any Intent event yet has nothing to show — not an operator-facing error.
    state.intentView = null
  }
  renderTopbar()
  renderBanner()
}

/** The complete desired state S2 can author. S7's real catalogue replaces the fixed selections. */
/**
 * The COMPLETE desired state, from what is on screen. Never a patch: the API takes a whole Intent,
 * and a partial one would be a request for the server to guess what the operator left out.
 *
 * Turning power off keeps every other selection (001 Intent: "previously accepted retained
 * selections can be carried in the complete off Intent"), so turning it back on does not silently
 * land on a different model than the one that was running.
 */
function composedIntent(power: 'on' | 'off'): IntentRequestBody | { readonly missing: readonly string[] } {
  const harness = selectedHarness()
  const model = selectedModel()
  const effort = selectedEffort()
  const missing = [
    ...(harness === '' ? ['harness'] : []),
    ...(model === '' ? ['modèle'] : []),
    ...(effort === '' ? ['effort'] : []),
  ]
  if (missing.length > 0) return { missing }
  return { power, harness, capabilities: [...selectedCapabilities()], model, effort, persona: 'default' }
}

async function authorIntent(power: 'on' | 'off'): Promise<void> {
  const workstreamId = state.activeId
  if (!workstreamId) return
  const intent = composedIntent(power)
  if ('missing' in intent) {
    // Named, not generic: an operator who is told "incomplete" has to guess which selector.
    toast(`Intention incomplète : choisissez ${intent.missing.join(', ')}.`, true)
    return
  }
  try {
    const result = await putIntent(workstreamId, intent)
    await refreshIntent(workstreamId)
    await refreshSessions(workstreamId)
    toast(result.status === 'created' ? `Intention enregistrée (power ${power}).` : 'Cette intention était déjà enregistrée.')
  } catch (error) {
    // 409 (a reused key with different content) and 422 (a value the catalogue does not offer) both
    // arrive with a Problem `detail` that says which — showing it beats restating the status code.
    toast(errorText(error), true)
  }
}

async function togglePower(): Promise<void> {
  await authorIntent(state.intentView?.intent.power === 'on' ? 'off' : 'on')
}

/**
 * True while the equipment still has to be composed: a conversation that does not exist yet, and —
 * the case this was missing — one that exists with no Intent recorded against it.
 *
 * Those exist. Anything that creates a Workstream and then fails to author its Intent leaves one,
 * and until this the UI offered no way back: the selectors rendered only for a conversation that
 * did not exist yet, so an Intent-less one could not be equipped, and every message sent into it
 * came back "Aucune intention enregistrée" with nothing on screen to act on. A dead end reached by
 * pressing send.
 */
function needsIntent(): boolean {
  return activeWorkstream() === undefined || state.intentView === null
}

async function doSend(): Promise<void> {
  const input = $main!.querySelector<HTMLTextAreaElement>('textarea')
  const text = (input?.value ?? '').trim()
  if (!text || !input) return
  input.value = ''
  input.dispatchEvent(new Event('input'))

  try {
    if (!state.activeId) await startWorkstream(text)
    else if (state.intentView === null) await equipAndHold(state.activeId, text)
    else if (state.intentView.intent.power !== 'on') await powerOnAndHold(state.activeId, text)
    else await sendPrompt(state.activeId, text)
  } catch (error) {
    toast(errorText(error), true)
  }
}

/**
 * Writing to a conversation that is off asks for it back. Anything else makes the operator perform
 * the reconciliation by hand: before this, sending into a powered-off conversation reached a Pod
 * that does not exist and answered with the transport's own words — "the harness bridge is not
 * reachable" — which describes the machine's problem, not theirs, and left the message nowhere.
 */
async function powerOnAndHold(workstreamId: string, text: string): Promise<void> {
  state.pendingPrompt = text
  syncComposerLock()
  await authorIntent('on')
  await refreshIntent(workstreamId)
  if (state.intentView?.intent.power !== 'on') {
    state.pendingPrompt = null
    syncComposerLock()
    restoreComposerText(text)
    return
  }
  syncComposerLock()
}

/** Authors the composed Intent for an existing conversation that has none, and holds the message. */
async function equipAndHold(workstreamId: string, text: string): Promise<void> {
  const intent = composedIntent('on')
  if ('missing' in intent) {
    toast(`Intention incomplète : choisissez ${intent.missing.join(', ')}.`, true)
    restoreComposerText(text)
    return
  }
  state.pendingPrompt = text
  syncComposerLock()
  try {
    await putIntent(workstreamId, intent)
  } catch (error) {
    // Holding a message behind an Intent that was never recorded is the dead end again, one step
    // further in: the composer would lock on "waiting" for something that is not coming. Give the
    // text back and let the operator see the selectors.
    state.pendingPrompt = null
    toast(errorText(error), true)
    syncComposerLock()
    restoreComposerText(text)
    return
  }
  await refreshIntent(workstreamId)
  await refreshSessions(workstreamId)
  syncComposerLock()
}

/**
 * One gesture, three steps: the Workstream, its complete Intent (powered on — asking for a
 * conversation is asking for a live one), and the message itself, which is held until the engine can
 * accept it. The equipment is checked FIRST, before anything is created: a conversation with no
 * Intent is a row the operator then has to clean up by hand.
 */
async function startWorkstream(text: string): Promise<void> {
  const intent = composedIntent('on')
  if ('missing' in intent) {
    toast(`Intention incomplète : choisissez ${intent.missing.join(', ')}.`, true)
    restoreComposerText(text)
    return
  }
  const created = await createWorkstream({ title: text })
  state.workstreams.set(created.id, created)
  state.activeId = created.id
  state.items = []
  state.turns = []
  state.echoes = []
  state.intentView = null
  state.sessionsView = null
  state.pendingPrompt = text
  rememberOpen(created.id)
  renderSidebar()
  renderMain()
  try {
    await putIntent(created.id, intent)
  } catch (error) {
    // The Workstream exists but has no Intent. Give the text back rather than holding it behind
    // something that is not coming: the composer keeps its selectors for an Intent-less
    // conversation, so sending again authors it.
    state.pendingPrompt = null
    toast(errorText(error), true)
    await loadWorkstream(created.id)
    restoreComposerText(text)
    return
  }
  await loadWorkstream(created.id)
}

/** Puts text back where the operator typed it, when the send could not happen at all. */
function restoreComposerText(text: string): void {
  const input = $main!.querySelector<HTMLTextAreaElement>('#input')
  if (!input) return
  input.value = text
  input.dispatchEvent(new Event('input'))
  input.focus()
}

/**
 * Delivers the held first message once the Workstream can actually take it — which is exactly when
 * the rule tables say CONVERGED, the same condition the server's own admission check applies. Called
 * after every refresh of the open Workstream, so it happens on its own rather than on a click.
 */
async function flushPendingPrompt(): Promise<void> {
  const text = state.pendingPrompt
  const workstreamId = state.activeId
  if (text === null || workstreamId === null) return
  if (statusOf().kind !== 'converged') return
  state.pendingPrompt = null
  try {
    await sendPrompt(workstreamId, text)
  } catch (error) {
    // Held again rather than lost: the next refresh tries once more, and the composer keeps saying
    // the message is still waiting.
    state.pendingPrompt = text
    // "Admission not granted" is not a failure, it is "not yet": this client's view of convergence
    // is up to one poll old, and the server re-derives it at the instant of the send. Putting a red
    // toast on screen for a race that resolves itself in six seconds would teach the operator to
    // ignore toasts. Anything else is still worth saying out loud.
    if (error instanceof ApiError && error.problem.status === 409 && /admission/i.test(error.problem.title)) return
    toast(errorText(error), true)
  }
}

async function sendPrompt(workstreamId: string, text: string): Promise<void> {
  state.echoes.push({ id: `echo-${Date.now()}`, text, seq: state.echoes.length })
  renderMessages()
  try {
    const result = await promptSession(workstreamId, text)
    // A send that was accepted clears the gate: whatever was ambiguous is no longer blocking.
    state.deliveryUnknown = false
    // The optimistic running turn: its status updates arrive on the feed.
    state.turns.push({ id: result.commandId, purpose: 'user', status: 'running' })
    syncComposerLock()
  } catch (error) {
    // The echo dies with the failure: the command was not even reserved.
    state.echoes = state.echoes.filter((echo) => echo.text !== text || state.items.some((item) => item.kind === 'message'))
    // CONT-005: the server refuses because a PREVIOUS prompt may already have been accepted. That is
    // not this send failing — it is the composer learning that it must not send at all until
    // recovery resolves the earlier one. No automatic retry, ever.
    if (error instanceof ApiError && error.problem.status === 409 && /delivery/i.test(error.problem.title)) {
      state.deliveryUnknown = true
      renderTopbar()
      renderBanner()
      syncComposerLock()
    }
    renderMessages()
    throw error
  }
}

async function renameWorkstream(workstreamId: string | null): Promise<void> {
  if (!workstreamId) return
  const workstream = state.workstreams.get(workstreamId)
  if (!workstream) return
  const title = prompt('Titre de la conversation :', workstream.title)
  if (!title || title === workstream.title) return
  try {
    const updated = await patchWorkstream(workstreamId, { title })
    state.workstreams.set(workstreamId, updated)
    renderSidebar()
    renderTopbar()
  } catch (error) {
    toast(errorText(error), true)
  }
}

/** Deletion extinguishes execution first (continuity: storage and retention) and has no API in S4 — the button says so instead of failing silently. */
async function removeWorkstream(workstreamId: string | null): Promise<void> {
  if (!workstreamId) return
  toast('La suppression n’est pas disponible sur l’API actuelle.', true)
}

/* ------------------------------------------------------------------ *
 *  loading                                                            *
 * ------------------------------------------------------------------ */

/**
 * S2 list refresh: one GET of the owned Workstreams. The legacy per-Workstream detail read is gone
 * with the detail endpoint itself — everything the sidebar shows is on the record now.
 */
async function refreshList(): Promise<void> {
  const records = asArray<import('./api.js').WorkstreamRecord>(await listWorkstreams())
  const seen = new Set<string>()
  for (const record of records) {
    seen.add(record.id)
    state.workstreams.set(record.id, record)
  }
  for (const id of [...state.workstreams.keys()]) {
    if (seen.has(id)) continue
    state.workstreams.delete(id)
    state.detailSeenAt.delete(id)
  }
  renderSidebar()
  if (state.activeId) renderTopbar()
}

async function reload(): Promise<void> {
  try {
    // The catalogue first: without it the Intent editor has nothing to offer, and offering values
    // this client made up is exactly what the contract forbids.
    //
    // Coerced at the boundary, like every other collection here: a well-formed but EMPTY response is
    // a real case (the boot test answers every request with one), and storing it verbatim would put
    // `undefined.length` in a render path where the failure has no visible cause.
    const catalogue = await getCatalogue()
    state.catalogue = {
      revisionId: catalogue?.revisionId ?? null,
      capabilities: asArray<string>(catalogue?.capabilities),
      harnesses: asArray<Catalogue['harnesses'][number]>(catalogue?.harnesses).map((harness) => ({
        id: harness?.id ?? '',
        models: asArray<Catalogue['harnesses'][number]['models'][number]>(harness?.models).map((model) => ({
          id: model?.id ?? '',
          efforts: asArray<string>(model?.efforts),
        })),
      })),
    }
  } catch (error) {
    toast(errorText(error), true)
  }
  try {
    await refreshList()
  } catch (error) {
    toast(errorText(error), true)
  }
  renderSidebar()
  renderMain()
  // Back where the operator was. Only if it still exists: a Workstream deleted from another tab
  // must not leave this one pointed at nothing.
  let remembered: string | null = null
  try {
    remembered = localStorage.getItem(OPEN_KEY)
  } catch {
    remembered = null
  }
  if (remembered !== null && state.workstreams.has(remembered)) await selectWorkstream(remembered)
  else if (remembered !== null) rememberOpen(null)
}

async function init(): Promise<void> {
  applyTheme()
  if (isMobile()) state.sidebarOpen = false
  applySidebar()
  $scrim!.addEventListener('click', () => setSidebar(false))
  // The sidebar is a push panel on desktop and a drawer on mobile, and the close button's glyph
  // differs between them — crossing the breakpoint has to re-render, not just restyle.
  matchMedia(MOBILE_QUERY).addEventListener('change', () => {
    renderSidebar()
    renderTopbar()
  })

  // Escape closes whatever is open, from anywhere — including from inside the menu, which is where
  // the focus is when a keyboard user wants out of it.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.openMenu !== null) {
      event.preventDefault()
      closeMenu(true)
    }
  })

  renderSidebar()
  renderMain()
  await reload()

  setInterval(() => {
    void refreshList().catch(() => {
      // The poll is best-effort: a transient failure must not put a toast on screen every 6 seconds.
    })
    // And the OPEN Workstream's own state, which the feed does not carry: the feed publishes items
    // and turn statuses, while power, the blocking cause, the loss exposure and whether a Session
    // exists all live on the Intent and Sessions views. Polling only the list left an operator
    // watching a screen that did not move while the engine built a Pod, granted a credential and
    // opened a Session — with a composer still locked on a reason from a minute ago.
    void refreshOpenWorkstream().catch(() => {})
  }, LIST_POLL_INTERVAL_MS)
}

void init()

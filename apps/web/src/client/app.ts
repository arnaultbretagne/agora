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
  activateSession,
  createWorkstream,
  deleteWorkstream,
  getAgentConfigOptions,
  getEquipmentCatalogue,
  getSession,
  getWorkstream,
  listAgents,
  listItems,
  listTurns,
  listWorkstreams,
  openSession,
  patchWorkstream,
  probeAgentConfigOptions,
  promptSession,
  setConfigOption,
  subscribeFeed,
  suspendSession,
  type AgentConfigOptions,
  type ConfigValue,
  type EquipmentCatalogue,
  type EquipmentResourceRequest,
  type FeedEvent,
  type PublicAgent,
  type RequestedConfigOption,
  type Session,
  type Workstream,
  type WorkstreamItem,
  type WorkstreamTurn,
} from './api.js'
import { icons } from './icons.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import {
  clampIndex,
  configOptionsFromItems,
  currentSession,
  effectiveConfig,
  findConfigOption,
  groupWorkstreams,
  hasRunningTurn,
  invocationTurnSpent,
  launchableAgents,
  messagesFromItems,
  railIndexAt,
  railIndexOf,
  runtimeStateOfPhase,
  STATE_LABELS,
  type ChatMessage,
  type ConfigOption,
  type ConfigSource,
  type RuntimeState,
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

type MenuKey = 'harness' | 'model' | 'agent' | 'equipment'

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
  workstreams: new Map<string, Workstream>(),
  /** Sessions per Workstream, from `GET /v1/workstreams/{id}` — the only source of a Session's phase, which the list endpoint does not carry. */
  sessions: new Map<string, readonly Session[]>(),
  /** The `updatedAt` a Workstream had when its detail was last fetched, so the poll refetches only what actually moved. */
  detailSeenAt: new Map<string, string>(),
  activeId: null as string | null,
  items: [] as WorkstreamItem[],
  turns: [] as WorkstreamTurn[],
  echoes: [] as PendingEcho[],
  configOptions: [] as readonly ConfigOption[],
  agents: [] as readonly PublicAgent[],
  catalogue: undefined as EquipmentCatalogue | undefined,
  search: '',
  theme: localStorage.getItem('agora.theme') ?? 'light',
  sidebarOpen: localStorage.getItem('agora.sidebar') !== 'closed',
  openMenu: null as MenuKey | null,
  feedLive: false,
  /**
   * What each Agent last advertised it can be configured with, keyed by `agentId` — the composer's
   * only possible source of a model list, since ACP publishes options in a `session/new` response
   * and a conversation that has not started has no such response to read.
   */
  agentConfig: new Map<string, AgentConfigOptions>(),
  /** Agents whose empty run this page has already asked for, so a failing one is not re-requested on every render. */
  probeRequested: new Set<string>(),
  /** Draft selections for the NEXT Session — what the selectors offer before one exists, and what a persona/equipment change would launch. */
  draft: {
    agentId: '',
    persona: '',
    equipment: [] as EquipmentResourceRequest[],
    /** Model/effort choices made before any Session exists; sent with the create so the FIRST turn already runs on them. */
    config: {} as Record<string, ConfigValue>,
  },
  unsubscribeFeed: undefined as (() => void) | undefined,
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

function activeWorkstream(): Workstream | undefined {
  return state.activeId ? state.workstreams.get(state.activeId) : undefined
}

function activeSession(): Session | undefined {
  return state.activeId ? currentSession(state.sessions.get(state.activeId) ?? []) : undefined
}

function runtimeStateOf(workstreamId: string): RuntimeState {
  return runtimeStateOfPhase(currentSession(state.sessions.get(workstreamId) ?? [])?.phase)
}

/** The Agent in force once a Session exists, the draft before that — the harness is frozen at Session creation, which is why the selector locks. */
function selectedAgentId(): string {
  return activeSession()?.agentId ?? state.draft.agentId
}

function selectedAgent(): PublicAgent | undefined {
  const agentId = selectedAgentId()
  return state.agents.find((agent) => agent.agentId === agentId)
}

/** Falls back to the draft only when no Session exists: a Session's own `persona` is what it is actually running as, and an empty one means the harness default. */
function selectedPersona(): string {
  const session = activeSession()
  return session ? (session.persona ?? '') : state.draft.persona
}

function agentLabel(agentId: string): string {
  return state.agents.find((agent) => agent.agentId === agentId)?.label ?? agentId
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
  const groups = groupWorkstreams([...state.workstreams.values()], state.search, new Date())

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
                const runtimeState = runtimeStateOf(workstream.id)
                return `
              <button class="conv-item state-${runtimeState} ${workstream.id === state.activeId ? 'active' : ''}" data-conv="${escapeHtml(workstream.id)}">
                <span class="conv-dot" title="${escapeHtml(STATE_LABELS[runtimeState])}"></span>
                <span class="conv-title">${escapeHtml(workstream.title)}</span>
                <span class="conv-star ${workstream.pinned ? 'pinned' : ''}" data-pin="${escapeHtml(workstream.id)}" role="button" aria-label="Épingler">${icons.star(14, workstream.pinned)}</span>
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
  $sidebar!.querySelector<HTMLElement>('#identity')?.addEventListener('click', promptForPrincipal)

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
      if ((event.target as HTMLElement).closest('[data-pin]')) return
      void selectWorkstream(node.dataset['conv'] ?? '')
    })
  }
  for (const node of $sidebar!.querySelectorAll<HTMLElement>('[data-pin]')) {
    node.addEventListener('click', (event) => {
      event.stopPropagation()
      void togglePin(node.dataset['pin'] ?? '')
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

function stateChip(workstreamId: string): string {
  const runtimeState = runtimeStateOf(workstreamId)
  return `<span class="chip state ${runtimeState}"><span class="dot"></span>${escapeHtml(STATE_LABELS[runtimeState])}</span>`
}

function renderTopbar(): void {
  const workstream = activeWorkstream()
  const bar = $main!.querySelector('.topbar')
  if (!bar) return renderMain()
  bar.innerHTML = `
    <div class="topbar-left">
      ${!state.sidebarOpen || isMobile() ? `<button class="icon-btn" id="menu-btn" aria-label="Menu">${icons.menu(19)}</button>` : ''}
      <span class="topbar-title" id="topbar-title" title="Double-clic pour renommer">${escapeHtml(workstream ? workstream.title : 'Nouvelle conversation')}</span>
    </div>
    <div class="topbar-right">
      ${workstream ? stateChip(workstream.id) : ''}
      ${workstream ? selectorsCluster() : ''}
      ${
        workstream && runtimeStateOf(workstream.id) !== 'dormant'
          ? `<button class="icon-btn muted" id="stop-session" title="Arrêter la session (l’historique est conservé, la conversation reprend au prochain message)">${icons.power(17)}</button>`
          : ''
      }
      ${workstream ? `<button class="icon-btn muted" id="delete-conv" title="Supprimer la conversation">${icons.trash(17)}</button>` : ''}
      ${isMobile() ? `<button class="icon-btn" id="mobile-new" aria-label="Nouvelle conversation">${icons.plus(19)}</button>` : ''}
    </div>`
  bar.querySelector<HTMLElement>('#menu-btn')?.addEventListener('click', () => setSidebar(true))
  bar.querySelector<HTMLElement>('#mobile-new')?.addEventListener('click', newChat)
  bar.querySelector<HTMLElement>('#stop-session')?.addEventListener('click', () => void stopSession(state.activeId))
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

  // Messaging-app paradigm, carried over verbatim: a bubble = the user speaking (no name, no
  // avatar); the agent's answers sit bare on the conversation background.
  //
  // What the transcript deliberately does NOT show is what the agent DID to answer. The OLD hub had
  // no record of tool calls at all; this engine projects every one of them, and showing them here
  // is now a real option — but the reason they were left out has not changed, so neither has the
  // rendering: a conversation reads as a conversation. Same for equipment, which is a permission
  // held for a whole Session and never evidence that a given turn used it.
  wrap.innerHTML = `
    <div class="messages-inner">
      ${transcript()
        .map(
          (message) => `
        <div class="msg-row ${message.role === 'user' ? 'user' : 'assistant'}">
          <div class="msg-text">${renderMarkdown(message.text)}</div>
        </div>`,
        )
        .join('')}
      ${
        hasRunningTurn(state.turns)
          ? `
        <div class="msg-row assistant typing">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>`
          : ''
      }
    </div>`
  if (nearBottom) wrap.scrollTop = wrap.scrollHeight
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
  return `
    <div class="selector">
      <button class="selector-btn" id="${id}" ${options.disabled ? 'disabled' : ''}${options.title ? ` title="${escapeHtml(options.title)}"` : ''}>
        ${iconName ? `<span class="sel-icon">${icons[iconName](14)}</span>` : ''}
        <span id="${id}-label">${escapeHtml(label)}</span>
        <span class="sel-chevron">${icons.chevronDown(13)}</span>
      </button>
      <div id="${id}-menu"></div>
    </div>`
}

/**
 * The options the selectors work on: a live Agent's own advertisement when one is running, and
 * otherwise the memo of what the selected harness last advertised (`state.agentConfig`), which is
 * what makes the model choice reachable in a conversation that has not started yet.
 */
function currentConfig(): { readonly source: ConfigSource; readonly options: readonly ConfigOption[] } {
  const catalogue = state.agentConfig.get(selectedAgentId())
  return effectiveConfig(state.configOptions, (catalogue?.options as readonly ConfigOption[] | undefined) ?? undefined, state.draft.config)
}

function modelOption(): ConfigOption | undefined {
  return findConfigOption(currentConfig().options, 'model', 'model')
}

function effortOption(): ConfigOption | undefined {
  return findConfigOption(currentConfig().options, 'thought_level', 'effort')
}

/** `Défaut` rather than a guessed value: before anything is chosen the harness's own default is what will run, and naming a specific model here would claim a decision nobody made. */
function configValueName(option: ConfigOption | undefined): string {
  if (!option) return '—'
  if (option.currentValue === undefined || option.currentValue === null) return 'Défaut'
  const current = String(option.currentValue)
  return option.options?.find((value) => value.value === current)?.name ?? current
}

function equipmentLabel(): string {
  if (state.draft.equipment.length === 0) return 'Aucun équipement'
  const resources = asArray<EquipmentCatalogue['resources'][number]>(state.catalogue?.resources)
  return state.draft.equipment
    .map((requested) => {
      const resource = resources.find((entry) => entry.resource === requested.resource)
      const access = resource?.accessLevels.find((level) => level.access === requested.access)
      return `${resource?.label ?? requested.resource} · ${access?.label ?? requested.access}`
    })
    .join(', ')
}

/**
 * The harness/model/persona/equipment cluster. It lives in the COMPOSER while no Session exists and
 * MOVES to the topbar once one does, which is why it is one function called from both places.
 *
 * The harness still locks once a Session exists — the Agent is frozen on it, and changing it means a
 * new Session. The MODEL no longer does. It used to be disabled until a live ACP connection existed,
 * on the reasoning that only a running harness can say what it offers; that is true of the values
 * but not of the choice, and it left the selector dead exactly where an operator most wants it (a
 * brand-new conversation) and again once the idle reaper took the Runtime back. The list now comes
 * from what the harness itself last advertised, and the choice is durable until something is running
 * to receive it (P12). It is only disabled when this client genuinely has nothing to show — an Agent
 * never launched and not yet probed — and then it says so rather than being silently grey.
 */
function selectorsCluster(): string {
  const session = activeSession()
  const agent = selectedAgent()
  const persona = selectedPersona()
  const config = currentConfig()
  const catalogue = state.agentConfig.get(selectedAgentId())
  const noOptions = config.options.length === 0
  const reason =
    catalogue?.state === 'probing'
      ? 'Démarrage à vide du harness pour lire ses options…'
      : catalogue?.state === 'unavailable'
        ? `Options indisponibles : ${catalogue.detail ?? 'le démarrage à vide a échoué'}`
        : 'Options inconnues tant que ce harness n’a jamais démarré.'
  return `
    <div class="selectors">
      ${selectorButton('sel-harness', null, agentLabel(selectedAgentId()) || 'Harness', { disabled: Boolean(session) })}
      ${selectorButton('sel-model', null, noOptions ? 'Modèle' : configValueName(modelOption()), {
        disabled: noOptions,
        ...(noOptions ? { title: reason } : {}),
      })}
      ${agent && agent.personas.length > 0 ? selectorButton('sel-agent', 'message', persona || 'Agent', {}) : ''}
      ${selectorButton('sel-equipment', 'shield', equipmentLabel(), {})}
    </div>`
}

function wireSelectors(root: ParentNode): void {
  root.querySelector<HTMLElement>('#sel-harness')?.addEventListener('click', () => toggleMenu('harness'))
  root.querySelector<HTMLElement>('#sel-model')?.addEventListener('click', () => toggleMenu('model'))
  root.querySelector<HTMLElement>('#sel-agent')?.addEventListener('click', () => toggleMenu('agent'))
  root.querySelector<HTMLElement>('#sel-equipment')?.addEventListener('click', () => toggleMenu('equipment'))
}

/**
 * Effort is an ordered magnitude, so it renders as a rail rather than a list (the OLD UI's design):
 * coral fill and knob at the selected level, faint coral dots for the levels ahead, dark notches for
 * the ones crossed. The levels are whatever the harness advertises for this option — never a list
 * this client keeps.
 */
function effortRail(option: ConfigOption): string {
  const levels = option.options ?? []
  const span = Math.max(1, levels.length - 1)
  const index = railIndexOf(levels, option.currentValue)
  const at = (position: number): string => `${(position / span) * 100}%`
  const dots = levels
    .map((_level, position) =>
      position === index
        ? ''
        : `<div class="effort__dot" style="left:${at(position)};background:${position < index ? 'rgba(0,0,0,.28)' : 'rgba(204,120,92,.55)'}"></div>`,
    )
    .join('')
  const label = escapeHtml(levels[index]?.name ?? String(option.currentValue ?? ''))
  return `
    <div class="effort">
      <div class="effort__head">
        <span class="effort__label">${escapeHtml(option.name)}</span>
        <span class="effort__value">${label}</span>
      </div>
      <div class="effort__rail" tabindex="0" role="slider" aria-label="${escapeHtml(option.name)}"
           aria-valuemin="0" aria-valuemax="${span}" aria-valuenow="${index}" aria-valuetext="${label}">
        <div class="effort__track"></div>
        <div class="effort__fill" style="width:${at(index)}"></div>
        ${dots}
        <div class="effort__knob" style="left:${at(index)}"></div>
      </div>
    </div>`
}

function toggleMenu(which: MenuKey): void {
  state.openMenu = state.openMenu === which ? null : which
  renderMenus()
}

function closeMenu(): void {
  state.openMenu = null
  renderMenus()
}

const MENU_HOSTS: readonly (readonly [MenuKey, string])[] = [
  ['harness', 'sel-harness-menu'],
  ['model', 'sel-model-menu'],
  ['agent', 'sel-agent-menu'],
  ['equipment', 'sel-equipment-menu'],
]

/**
 * `attribute` is always a literal chosen in this file — never interpolated from engine or harness
 * data. Attribute NAMES sit outside anything `escapeHtml` can protect, so untrusted text there would
 * escape the attribute no matter how the value is quoted; `data-value` is the escape hatch for rows
 * that need to carry a second, arbitrary payload.
 */
function menuRow(
  attribute: string,
  value: string,
  name: string,
  options: { selected: boolean; description?: string; icon?: 'shield' | 'message'; value?: string },
): string {
  return `
    <button class="menu-row ${options.selected ? 'selected' : ''}" ${attribute}="${escapeHtml(value)}"${options.value === undefined ? '' : ` data-value="${escapeHtml(options.value)}"`}>
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
    if (key === 'agent') renderPersonaMenu(host)
    if (key === 'equipment') renderEquipmentMenu(host)
  }

  let backdrop = $main!.querySelector<HTMLElement>('.menu-backdrop')
  if (state.openMenu && !backdrop) {
    backdrop = document.createElement('div')
    backdrop.className = 'menu-backdrop'
    backdrop.addEventListener('click', closeMenu)
    $main!.append(backdrop)
  } else if (!state.openMenu && backdrop) {
    backdrop.remove()
  }
}

function renderHarnessMenu(host: HTMLElement): void {
  const agents = launchableAgents(state.agents)
  host.innerHTML = `
    <div class="menu"><div class="menu-label">Harness</div>
      ${agents.map((agent) => menuRow('data-agent-id', agent.agentId, agent.label, { selected: agent.agentId === selectedAgentId(), description: agent.description })).join('')}
      ${agents.length === 0 ? '<div class="menu-note">Aucun harness disponible.</div>' : ''}
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-agent-id]')) {
    node.addEventListener('click', () => {
      // Switching harness clears the persona: personas are reviewed per Agent, so one Agent's name
      // is not a name the next one would accept (the server refuses it with `persona_unavailable`).
      state.draft.agentId = node.dataset['agentId'] ?? ''
      state.draft.persona = ''
      // Config options are the new harness's own vocabulary — one harness's `effort` values are not
      // another's, and carrying them over would offer a model this Agent does not have.
      state.draft.config = {}
      state.openMenu = null
      renderComposer()
      renderTopbar()
      renderMenus()
      void loadAgentConfig(state.draft.agentId)
    })
  }
}

function renderModelMenu(host: HTMLElement): void {
  const config = currentConfig()
  const model = modelOption()
  const effort = effortOption()
  const others = config.options.filter((option) => option !== model && option !== effort && Array.isArray(option.options))
  host.innerHTML = `
    <div class="menu"><div class="menu-label">${escapeHtml(model?.name ?? 'Modèle')}</div>
      ${
        config.source === 'catalogue'
          ? '<div class="menu-note">Ces options seront appliquées au démarrage de la session.</div>'
          : ''
      }
      ${(model?.options ?? [])
        .map((value) =>
          menuRow('data-config-value', value.value, value.name, {
            selected: model?.currentValue !== undefined && model.currentValue !== null && value.value === String(model.currentValue),
          }),
        )
        .join('')}
      ${effort ? `<div class="menu-sep"></div>${effortRail(effort)}` : ''}
      ${others
        .map((option, index) =>
          [
            '<div class="menu-sep"></div>',
            `<div class="menu-label">${escapeHtml(option.name)}</div>`,
            // The row carries the option's INDEX, never its id. An ACP option id is harness-supplied
            // free text, and building an attribute NAME out of it (`data-other-${id}`) would put
            // untrusted data outside any quoting `escapeHtml` can apply — an id containing a quote or
            // a space escapes the attribute entirely. An index is generated here, so it cannot.
            ...(option.options ?? []).map((value) =>
              menuRow('data-other-index', String(index), value.name, {
                selected: value.value === String(option.currentValue ?? ''),
                value: value.value,
              }),
            ),
          ].join(''),
        )
        .join('')}
    </div>`

  for (const node of host.querySelectorAll<HTMLElement>('[data-config-value]')) {
    // The panel stays open on purpose: effort is chosen right after the model, in the same decision.
    node.addEventListener('click', () => void applyConfigOption(model?.id ?? 'model', node.dataset['configValue'] ?? ''))
  }
  for (const node of host.querySelectorAll<HTMLElement>('[data-other-index]')) {
    const option = others[Number(node.dataset['otherIndex'])]
    if (!option) continue
    node.addEventListener('click', () => void applyConfigOption(option.id, node.dataset['value'] ?? ''))
  }

  const rail = host.querySelector<HTMLElement>('.effort__rail')
  if (rail && effort) {
    const levels = effort.options ?? []
    const currentIndex = railIndexOf(levels, effort.currentValue)
    const commit = (index: number): void => {
      const level = levels[clampIndex(index, levels.length)]
      if (level) void applyConfigOption(effort.id, level.value)
    }
    rail.addEventListener('click', (event) => {
      const box = rail.getBoundingClientRect()
      commit(railIndexAt((event.clientX - box.left) / box.width, levels.length))
    })
    rail.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault()
        commit(currentIndex + 1)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault()
        commit(currentIndex - 1)
      }
    })
  }
}

/**
 * The persona is a launch argument, so unlike the OLD system this cannot be changed in place — but
 * it is still never locked, because the engine has a real answer for changing it: open a new Session
 * with a Handoff, which keeps the conversation continuous. The note says that before the click, the
 * same way the OLD UI warned that re-equipping spawned a new run.
 */
function renderPersonaMenu(host: HTMLElement): void {
  const agent = selectedAgent()
  const persona = selectedPersona()
  host.innerHTML = `
    <div class="menu right"><div class="menu-label">Agent</div>
      ${menuRow('data-persona', '', 'Défaut', { selected: !persona, description: 'Aucun agent', icon: 'message' })}
      ${(agent?.personas ?? []).map((name) => menuRow('data-persona', name, name, { selected: name === persona, icon: 'message' })).join('')}
      ${activeSession() ? '<div class="menu-note">Changer d’agent démarre une nouvelle session (l’historique est transféré).</div>' : ''}
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-persona]')) {
    node.addEventListener('click', () => void choosePersona(node.getAttribute('data-persona') ?? ''))
  }
}

/**
 * Equipment (docs/specs/10): a closed catalogue of resources, each with the access levels the Broker
 * will actually grant. The browser names a resource and an access level and nothing else — never a
 * scope, a token or an endpoint, which are the Broker's alone to decide.
 *
 * The OLD UI offered named profiles; this engine has no such combination ("No combined profiles" —
 * capability facts are independent rows), so the menu offers each resource's levels directly, plus
 * the way back to none.
 */
function renderEquipmentMenu(host: HTMLElement): void {
  const catalogue = state.catalogue
  const chosen = state.draft.equipment
  host.innerHTML = `
    <div class="menu right"><div class="menu-label">Équipement</div>
      ${menuRow('data-equipment', '', 'Aucun équipement', { selected: chosen.length === 0, description: 'Conversation seule', icon: 'shield' })}
      ${(catalogue?.resources ?? [])
        .map((resource) =>
          resource.accessLevels
            .map((level) =>
              menuRow('data-equipment', `${resource.resource}:${level.access}`, `${resource.label} · ${level.label}`, {
                selected: chosen.some((entry) => entry.resource === resource.resource && entry.access === level.access),
                description: level.description ?? resource.description,
                icon: 'shield',
              }),
            )
            .join(''),
        )
        .join('')}
      ${
        activeSession()
          ? '<div class="menu-note">Changer l’équipement démarre une nouvelle session. L’API ne publie pas l’équipement en vigueur : cette sélection décrit la prochaine session.</div>'
          : ''
      }
    </div>`
  for (const node of host.querySelectorAll<HTMLElement>('[data-equipment]')) {
    node.addEventListener('click', () => void chooseEquipment(node.getAttribute('data-equipment') ?? ''))
  }
}

/* ------------------------------------------------------------------ *
 *  composer                                                           *
 * ------------------------------------------------------------------ */

/** The sentence shown in place of the composer when the Workstream cannot take another turn, or `undefined` when it can — see `invocationTurnSpent` for why this case exists at all. */
function composerLockReason(): string | undefined {
  const workstream = activeWorkstream()
  if (!workstream || !invocationTurnSpent(workstream.category, state.turns)) return undefined
  return 'Invocation : un seul tour est permis, il a déjà eu lieu.'
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
        ${activeWorkstream() ? '' : selectorsCluster()}
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

function renderMain(): void {
  $main!.innerHTML = `
    <header class="topbar"></header>
    <div class="messages"></div>
    <div class="composer-wrap"></div>`
  renderTopbar()
  renderMessages()
  renderComposer()
  renderMenus()
}

/* ------------------------------------------------------------------ *
 *  actions                                                            *
 * ------------------------------------------------------------------ */

function newChat(): void {
  unsubscribe()
  state.activeId = null
  state.openMenu = null
  state.items = []
  state.turns = []
  state.echoes = []
  state.configOptions = []
  state.draft.persona = ''
  state.draft.equipment = []
  // A draft belongs to the conversation it was typed into: carrying it across would silently
  // reconfigure a Session the operator is no longer looking at.
  state.draft.config = {}
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
  state.openMenu = null
  state.items = []
  state.turns = []
  // Echoes belong to the Workstream they were typed into and cannot be recovered for any other.
  state.echoes = []
  state.configOptions = []
  state.draft.persona = ''
  state.draft.equipment = []
  // A draft belongs to the conversation it was typed into: carrying it across would silently
  // reconfigure a Session the operator is no longer looking at.
  state.draft.config = {}
  if (isMobile()) {
    state.sidebarOpen = false
    applySidebar()
  }
  renderSidebar()
  renderMain()
  await loadWorkstream(workstreamId)
}

async function loadWorkstream(workstreamId: string): Promise<void> {
  try {
    const detail = await getWorkstream(workstreamId)
    const { sessions, projectionHead: _head, ...workstream } = detail
    state.workstreams.set(workstreamId, workstream)
    state.sessions.set(workstreamId, asArray<Session>(sessions))
    state.detailSeenAt.set(workstreamId, workstream.updatedAt)

    const [itemsPage, turnsPage] = await Promise.all([listItems(workstreamId), listTurns(workstreamId)])
    if (state.activeId !== workstreamId) return
    state.items = [...asArray<WorkstreamItem>(itemsPage.items)]
    state.turns = [...asArray<WorkstreamTurn>(turnsPage.turns)]
    state.echoes = []
    state.configOptions = configOptionsFromItems(state.items) ?? []
    renderSidebar()
    renderMain()
    subscribe(workstreamId, itemsPage.feedPosition)
  } catch (error) {
    toast(errorText(error), true)
  }
}

/**
 * Resumes from the feed position the item page was consistent with, so nothing between the snapshot
 * and the subscription is missed or replayed (docs/specs/14). `reset` means the client's cursor is
 * ahead of what the feed still retains — the only correct response is to refetch, not to guess.
 */
function subscribe(workstreamId: string, after: number): void {
  state.unsubscribeFeed = subscribeFeed(
    workstreamId,
    after,
    (event: FeedEvent) => {
      if (state.activeId !== workstreamId) return
      applyFeedEvent(workstreamId, event)
    },
    (status) => {
      state.feedLive = status === 'connected'
    },
  )
}

function applyFeedEvent(workstreamId: string, event: FeedEvent): void {
  if (event.operation === 'upsert') {
    const item = event.payload as unknown as WorkstreamItem
    const index = state.items.findIndex((existing) => existing.id === item.id)
    if (index >= 0) state.items[index] = item
    else state.items.push(item)
    // A `PUT config-options` response travels the same journaled connection as `session/new`, so the
    // freshest advertised option set arrives here too — the model panel needs no separate refresh.
    state.configOptions = configOptionsFromItems(state.items) ?? state.configOptions
    // The Agent naming its own session arrives as a `session_info` item, and the displayed title is
    // derived from it server-side — so this is the moment the conversation stops being called after
    // its first message. Re-read it now rather than waiting up to 6 s for the sidebar poll.
    if (item.kind === 'session_info') void refreshWorkstreamTitle(workstreamId)
    renderMessages()
    renderTopbar()
    renderMenus()
    return
  }
  if (event.operation === 'remove') {
    const itemId = (event.payload as { itemId?: string }).itemId
    state.items = state.items.filter((item) => item.id !== itemId)
    renderMessages()
    return
  }
  if (event.operation === 'status') {
    const subjectId = event.payload['subjectId'] as string | undefined
    const status = (event.payload['state'] as { status?: WorkstreamTurn['status'] } | undefined)?.status
    if (!subjectId || !status) return
    const index = state.turns.findIndex((turn) => turn.id === subjectId)
    if (index >= 0) {
      const existing = state.turns[index]
      if (existing) state.turns[index] = { ...existing, status }
    } else {
      void refreshTurns(workstreamId)
    }
    renderMessages()
    // An invocation's single turn opening is what closes its composer, and that arrives here.
    syncComposerLock()
    return
  }
  if (event.operation === 'reset') {
    void loadWorkstream(workstreamId)
  }
}

/** A conversation renames itself once its Agent has a subject for it; only the title is re-read, so this cannot disturb the transcript being rendered. */
async function refreshWorkstreamTitle(workstreamId: string): Promise<void> {
  try {
    const detail = await getWorkstream(workstreamId)
    const { sessions: _sessions, projectionHead: _head, ...workstream } = detail
    state.workstreams.set(workstreamId, workstream)
    renderSidebar()
    renderTopbar()
  } catch {
    // The next sidebar poll re-reads it anyway; a failed title refresh is not worth a toast.
  }
}

/** A `status` frame for a Turn this page has never seen carries no start time or ordinal, so the turn list is refetched rather than half-invented from the frame. */
async function refreshTurns(workstreamId: string): Promise<void> {
  try {
    const page = await listTurns(workstreamId)
    if (state.activeId !== workstreamId) return
    state.turns = [...asArray<WorkstreamTurn>(page.turns)]
    renderMessages()
    syncComposerLock()
  } catch {
    // A failed turn refresh costs a typing indicator, nothing more — the next frame retries.
  }
}

async function doSend(): Promise<void> {
  const input = $main!.querySelector<HTMLTextAreaElement>('textarea')
  const text = (input?.value ?? '').trim()
  if (!text || !input) return
  input.value = ''
  input.dispatchEvent(new Event('input'))

  try {
    if (!state.activeId) await startWorkstream(text)
    else await sendPrompt(state.activeId, text)
  } catch (error) {
    toast(errorText(error), true)
  }
}

function draftConfigOptions(): readonly RequestedConfigOption[] {
  return Object.entries(state.draft.config).map(([optionId, value]) => ({ optionId, value }))
}

/**
 * What a new Session for THIS conversation should be launched with: whatever is on screen.
 *
 * A persona or equipment change opens a new Session (both are frozen launch arguments), and without
 * this the conversation would silently drop back to the harness default model the moment the
 * operator changed something unrelated to it.
 */
function carriedConfigOptions(): readonly RequestedConfigOption[] {
  const config = currentConfig()
  if (config.source === 'catalogue') return draftConfigOptions()
  const carried: RequestedConfigOption[] = []
  for (const option of [modelOption(), effortOption()]) {
    if (!option || option.currentValue === undefined || option.currentValue === null) continue
    const value = option.currentValue
    if (typeof value === 'string' || typeof value === 'boolean') carried.push({ optionId: option.id, value })
  }
  return carried
}

async function startWorkstream(text: string): Promise<void> {
  const agentId = selectedAgentId()
  if (!agentId) {
    toast('Choisissez un harness avant d’envoyer.', true)
    return
  }
  const catalogue = state.catalogue
  if (!catalogue) {
    toast('Catalogue d’équipement indisponible — réessayez.', true)
    return
  }
  const persona = state.draft.persona
  const created = await createWorkstream({
    category: 'discussion',
    agentId,
    ...(persona ? { persona } : {}),
    workspace: { workspaceRef: WORKSPACE_REF },
    // The catalogue version comes from the server's own catalogue on every load: the Broker rejects
    // a stale one outright, and a client-side literal drifting from it is a bug this repo has
    // already been bitten by once.
    equipment: { catalogueVersion: catalogue.version, resources: state.draft.equipment },
    prompt: [{ type: 'text', text }],
    // Only what the operator actually chose. An untouched selector sends nothing, so the harness's
    // own default applies rather than a value this client picked for display.
    ...(draftConfigOptions().length > 0 ? { configOptions: draftConfigOptions() } : {}),
  })
  state.workstreams.set(created.workstream.id, created.workstream)
  state.sessions.set(created.workstream.id, [created.session])
  state.activeId = created.workstream.id
  state.items = []
  state.turns = []
  state.echoes = [{ id: `echo-${Date.now()}`, text, seq: 0 }]
  state.configOptions = []
  renderSidebar()
  renderMain()
  await loadWorkstream(created.workstream.id)
}

async function sendPrompt(workstreamId: string, text: string): Promise<void> {
  const session = activeSession()
  if (!session) {
    toast('Cette conversation n’a pas de session courante.', true)
    return
  }
  state.echoes.push({ id: `echo-${Date.now()}`, text, seq: state.echoes.length })
  renderMessages()
  try {
    await promptSession(session.id, [{ type: 'text', text }])
  } catch (error) {
    // `runtime_unavailable` is not a failure, it is a suspended Session: config and transcript live
    // on the Agora Session, but the ACP connection lives on a Pod that may be long gone. Waking it
    // is what the OLD system did implicitly on every send, so the operator should not have to know
    // the difference.
    if (error instanceof ApiError && error.problem.code === 'runtime_unavailable') {
      toast('Réveil de la session…')
      await activateSession(session.id)
      await waitForReady(session.id)
      await promptSession(session.id, [{ type: 'text', text }])
      await loadWorkstream(workstreamId)
      return
    }
    throw error
  }
}

/** Bounded because a Runtime that never reaches `ready` must surface as an error the operator can see, not as a spinner that never resolves. A cold Pod took ~10 s when this was last measured live. */
async function waitForReady(sessionId: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const session = await getSession(sessionId)
    if (session.phase === 'ready' || session.phase === 'busy') return
    if (session.phase === 'failed') throw new Error(session.failure?.detail ?? 'La session a échoué au démarrage.')
  }
  throw new Error('La session n’a pas démarré à temps.')
}

/**
 * One click, three situations, all of which used to be "nothing happens" or "an error":
 *
 *  - no Session yet — the choice is a draft, sent with the create so the first turn already runs on
 *    it (it used to `return` immediately, which is why the composer's selector did nothing);
 *  - a live Session — a real `session/set_config_option`, whose full response is authoritative;
 *  - a Session whose Runtime was reclaimed — the engine records it and applies it on the next
 *    resume, answering `pending` instead of the `runtime_unavailable` 409 that used to surface as a
 *    red toast.
 */
async function applyConfigOption(optionId: string, value: string): Promise<void> {
  // Every call site reads a `data-*` attribute with a `?? ''` fallback, so a row rendered without
  // its value sends an empty string and the server answers "body must be {"value": "<non-empty
  // string>"}" — which reaches the operator as a message about strings and says nothing about what
  // actually went wrong. Reported live 2026-08-07 ("ça m'a mis un message d'erreur comme quoi la
  // string était pas bonne"), and not reproducible afterwards, which is exactly why the failure
  // needs to name itself rather than be inferred from the server's generic complaint.
  if (!value) {
    toast(`Option « ${optionId} » : aucune valeur à appliquer (le menu a été rendu sans valeur).`, true)
    return
  }

  const session = activeSession()
  if (!session) {
    state.draft.config[optionId] = value
    renderComposer()
    renderTopbar()
    renderMenus()
    return
  }

  try {
    const result = await setConfigOption(session.id, optionId, value)
    if (result.pending) {
      // No Runtime to tell right now — but the choice IS durable, so it is shown as chosen rather
      // than silently reverting to what the last live session happened to be on.
      state.configOptions = state.configOptions.map((option) => (option.id === optionId ? { ...option, currentValue: value } : option))
      toast('Réglage enregistré — il prendra effet au prochain message.')
    } else if (Array.isArray(result.configOptions)) {
      // The Agent hands back its whole option set, which is authoritative — including any OTHER
      // option its answer changed. Trusting it beats patching the one entry this client asked about.
      state.configOptions = result.configOptions as readonly ConfigOption[]
    }
    renderComposer()
    renderTopbar()
    renderMenus()
  } catch (error) {
    toast(errorText(error), true)
  }
}

/**
 * Both persona and equipment changes take this path, because on this engine they are the same act:
 * a new Session on the same Workstream, launched with the new envelope. `activate: true` is what
 * makes the engine treat it as a continuation (it computes the missing range and dispatches the
 * Handoff) rather than a restart.
 */
async function relaunchSession(reason: string): Promise<void> {
  const workstreamId = state.activeId
  const catalogue = state.catalogue
  if (!workstreamId || !catalogue) return
  const agentId = selectedAgentId()
  const persona = state.draft.persona
  closeMenu()
  toast(reason)
  try {
    const carried = carriedConfigOptions()
    await openSession(workstreamId, {
      agentId,
      ...(persona ? { persona } : {}),
      workspace: { workspaceRef: WORKSPACE_REF },
      equipment: { catalogueVersion: catalogue.version, resources: state.draft.equipment },
      activate: true,
      ...(carried.length > 0 ? { configOptions: carried } : {}),
    })
    await loadWorkstream(workstreamId)
  } catch (error) {
    toast(errorText(error), true)
  }
}

async function choosePersona(persona: string): Promise<void> {
  if (persona === selectedPersona()) {
    closeMenu()
    return
  }
  state.draft.persona = persona
  if (!activeSession()) {
    closeMenu()
    renderComposer()
    renderTopbar()
    renderMenus()
    return
  }
  await relaunchSession('Nouvelle session avec cet agent…')
}

async function chooseEquipment(token: string): Promise<void> {
  const [resource, access] = token.split(':')
  const next: EquipmentResourceRequest[] = resource && access ? [{ resource, access }] : []
  const unchanged =
    next.length === state.draft.equipment.length && next.every((entry, index) => {
      const previous = state.draft.equipment[index]
      return previous?.resource === entry.resource && previous.access === entry.access
    })
  state.draft.equipment = next
  if (!activeSession()) {
    closeMenu()
    renderComposer()
    renderTopbar()
    renderMenus()
    return
  }
  if (unchanged) {
    closeMenu()
    return
  }
  await relaunchSession('Nouvelle session avec cet équipement…')
}

async function togglePin(workstreamId: string): Promise<void> {
  const workstream = state.workstreams.get(workstreamId)
  if (!workstream) return
  try {
    const updated = await patchWorkstream(workstreamId, { pinned: !workstream.pinned })
    state.workstreams.set(workstreamId, updated)
    renderSidebar()
  } catch (error) {
    toast(errorText(error), true)
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

/**
 * The manual twin of the engine's idle reaper: both end in the same durable suspension, so this is
 * "give the Runtime back", not "throw the conversation away". Custody is captured and the Anchor
 * committed before the Pod goes, so the next message resumes exactly where this left off — which is
 * why the confirm text promises the history stays and why this is a separate button from delete.
 *
 * It exists because waiting for the idle timeout is not always acceptable: Session Runtimes are
 * capped per namespace, and on 2026-08-07 four abandoned Sessions held every slot and made the
 * platform refuse all new work. An operator needs a way to hand a slot back immediately.
 */
async function stopSession(workstreamId: string | null): Promise<void> {
  if (!workstreamId) return
  const session = currentSession(state.sessions.get(workstreamId) ?? [])
  if (!session) return
  if (!confirm('Arrêter la session ? L’historique est conservé et la conversation reprendra au prochain message.')) return
  try {
    await suspendSession(session.id)
    toast('Session arrêtée — elle reprendra au prochain message.')
    await loadWorkstream(workstreamId)
  } catch (error) {
    toast(errorText(error), true)
  }
}

async function removeWorkstream(workstreamId: string | null): Promise<void> {
  if (!workstreamId) return
  if (!confirm('Supprimer définitivement cette conversation (historique compris) ?')) return
  try {
    await deleteWorkstream(workstreamId)
    // Deletion is accepted asynchronously (202): the row is marked deleting and disappears from the
    // list once the engine has torn its Sessions down. Dropping it locally now matches what the next
    // poll will report and keeps the click from feeling ignored.
    state.workstreams.delete(workstreamId)
    state.sessions.delete(workstreamId)
    state.detailSeenAt.delete(workstreamId)
    if (state.activeId === workstreamId) newChat()
    else renderSidebar()
  } catch (error) {
    toast(errorText(error), true)
  }
}

/* ------------------------------------------------------------------ *
 *  loading                                                            *
 * ------------------------------------------------------------------ */

/**
 * The list endpoint carries no Session phase, so the state dot needs one detail read per Workstream.
 * Refetched only when a Workstream's `updatedAt` moved since the last read (the journal bumps it on
 * every event, so provisioning and prompting both show up) or when its phase has never been read —
 * which keeps a steady-state poll to a single request.
 */
async function refreshList(): Promise<void> {
  const items = asArray<Workstream>((await listWorkstreams()).items)
  const seen = new Set<string>()
  const stale: string[] = []
  for (const workstream of items) {
    seen.add(workstream.id)
    if (state.detailSeenAt.get(workstream.id) !== workstream.updatedAt) stale.push(workstream.id)
    state.workstreams.set(workstream.id, workstream)
  }
  for (const id of [...state.workstreams.keys()]) {
    if (seen.has(id)) continue
    state.workstreams.delete(id)
    state.sessions.delete(id)
    state.detailSeenAt.delete(id)
  }
  renderSidebar()

  await Promise.all(
    stale.map(async (workstreamId) => {
      try {
        const detail = await getWorkstream(workstreamId)
        state.sessions.set(workstreamId, asArray<Session>(detail.sessions))
        state.detailSeenAt.set(workstreamId, detail.updatedAt)
      } catch {
        // A Workstream that vanished between the list and the detail read is simply gone; the next
        // poll drops it. Nothing here is worth interrupting the operator over.
      }
    }),
  )
  renderSidebar()
  if (state.activeId) renderTopbar()
}

/**
 * Loads what an Agent says it can be configured with, and — the first time nothing is known — asks
 * the engine to run it empty once to find out (the operator's own decision: never a model list this
 * client declares).
 *
 * The empty run is asked for AT MOST once per Agent per page: it materializes a real Runtime, and a
 * render loop that kept asking would spend the run namespace's whole quota on a question. While it
 * runs, the poll below picks the answer up.
 */
async function loadAgentConfig(agentId: string, allowProbe = true): Promise<void> {
  if (!agentId) return
  try {
    let view = await getAgentConfigOptions(agentId)
    if (view.state === 'unknown' && allowProbe && !state.probeRequested.has(agentId)) {
      state.probeRequested.add(agentId)
      view = await probeAgentConfigOptions(agentId)
    }
    state.agentConfig.set(agentId, view)
    renderComposer()
    renderTopbar()
    renderMenus()
    if (view.state === 'probing') {
      // A cold Runtime takes ~10 s to answer; re-read rather than block the UI on it.
      setTimeout(() => void loadAgentConfig(agentId, false), 4_000)
    }
  } catch {
    // A missing catalogue costs the model selector, nothing else — the conversation still runs on
    // the harness default, and a toast on every page load would be noise.
  }
}

async function reload(): Promise<void> {
  try {
    const [agentsPage, catalogue] = await Promise.all([listAgents(), getEquipmentCatalogue()])
    state.agents = asArray<PublicAgent>(agentsPage.items)
    // A catalogue without resources is not usable for anything — keeping it would let a create go
    // out with an undefined `catalogueVersion`, which the Broker refuses anyway, at the cost of a
    // far less obvious error than the toast `startWorkstream` raises when this is absent.
    state.catalogue = Array.isArray(catalogue?.resources) ? catalogue : undefined
    const available = launchableAgents(state.agents)
    if (!available.some((agent) => agent.agentId === state.draft.agentId)) state.draft.agentId = available[0]?.agentId ?? ''
    void loadAgentConfig(selectedAgentId())
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

  renderSidebar()
  renderMain()
  await reload()

  setInterval(() => {
    void refreshList().catch(() => {
      // The poll is best-effort: a transient failure must not put a toast on screen every 6 seconds.
    })
  }, LIST_POLL_INTERVAL_MS)
}

void init()

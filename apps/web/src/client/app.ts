import {
  ApiError,
  createWorkstream,
  getEquipmentCatalogue,
  getWorkstream,
  listAgents,
  listItems,
  listTurns,
  listWorkstreams,
  subscribeFeed,
  type FeedEvent,
  type WorkstreamItem,
} from './api.js'
import { renderError, renderItem, renderTurnBadge } from './render.js'

const root = document.getElementById('app')
if (!root) throw new Error('unreachable: #app is in index.html')

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}

// ---------- Principal (fake-auth shim, see server.ts) ----------

function currentPrincipal(): string {
  return localStorage.getItem('agora.principal') ?? ''
}

function renderPrincipalBar(): HTMLElement {
  const input = el('input', { id: 'principal-input', type: 'text', value: currentPrincipal(), 'aria-label': 'Acting as principal' })
  input.placeholder = 'principal id (e.g. alice)'
  input.addEventListener('change', () => {
    localStorage.setItem('agora.principal', input.value.trim())
  })
  const label = el('label', { for: 'principal-input' }, ['Acting as: '])
  return el('div', { class: 'principal-bar' }, [label, input])
}

// ---------- Workstream list ----------

async function renderWorkstreamList(): Promise<HTMLElement> {
  const container = el('div', { class: 'workstream-list-page' })
  container.append(el('h1', {}, ['Workstreams']), el('a', { class: 'button', href: '#/new' }, ['+ New Workstream']))

  try {
    const { items } = await listWorkstreams()
    const list = el(
      'ul',
      { class: 'workstream-list' },
      items.map((ws) =>
        el('li', {}, [
          el('a', { href: `#/w/${ws.id}` }, [ws.title || '(untitled)']),
          el('span', { class: 'muted' }, [` — ${ws.category}, role: ${ws.role}`]),
        ]),
      ),
    )
    container.append(items.length > 0 ? list : el('p', { class: 'muted' }, ['No Workstreams yet.']))
  } catch (error) {
    container.append(renderError(errorToProblem(error)))
  }
  return container
}

// ---------- New Workstream form ----------

async function renderNewWorkstreamForm(): Promise<HTMLElement> {
  const container = el('div', { class: 'new-workstream-page' })
  container.append(el('h1', {}, ['New Workstream']))

  const agentSelect = el('select', { id: 'agent-select', required: 'required' })
  // The Broker's own grant-issuance strictly rejects a stale catalogueVersion (real bug hit live:
  // a hard-coded client-side literal drifted from @agora/equipment-policy's real current version,
  // and the server's own /v1/equipment-catalogue was ALSO a hard-coded stub predating the Broker —
  // both fixed in this same pass). Fetched once here, same lifecycle as the agent list below.
  let catalogueVersion = ''
  try {
    const { items } = await listAgents()
    for (const agent of items.filter((a) => a.availability === 'enabled')) {
      agentSelect.append(el('option', { value: agent.agentId }, [agent.label]))
    }
    catalogueVersion = (await getEquipmentCatalogue()).version
  } catch (error) {
    container.append(renderError(errorToProblem(error)))
  }

  const promptInput = el('textarea', { id: 'prompt-input', required: 'required', rows: '4' })
  const workspaceInput = el('input', { id: 'workspace-input', type: 'text', value: 'pvc-default' })
  const status = el('div', { role: 'status', class: 'form-status' })

  const form = el('form', { class: 'new-workstream-form' }, [
    el('label', { for: 'agent-select' }, ['Agent']),
    agentSelect,
    el('label', { for: 'workspace-input' }, ['Workspace reference']),
    workspaceInput,
    el('label', { for: 'prompt-input' }, ['Initial prompt']),
    promptInput,
    el('button', { type: 'submit' }, ['Create']),
    status,
  ])

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    status.textContent = 'Creating…'
    void createWorkstream({
      category: 'discussion',
      agentId: agentSelect.value,
      workspace: { workspaceRef: workspaceInput.value },
      equipment: { catalogueVersion, resources: [] },
      prompt: promptInput.value.trim() ? [{ type: 'text', text: promptInput.value.trim() }] : [],
    })
      .then((result) => {
        location.hash = `#/w/${result.workstream.id}`
      })
      .catch((error: unknown) => {
        status.replaceChildren(renderError(errorToProblem(error)))
      })
  })

  container.append(form)
  return container
}

// ---------- Workstream detail ----------

async function renderWorkstreamDetail(workstreamId: string): Promise<HTMLElement> {
  const container = el('div', { class: 'workstream-detail-page' })
  const header = el('div', { class: 'detail-header' })
  const sessionsBox = el('div', { class: 'sessions-box' })
  const turnsBox = el('div', { class: 'turns-box', 'aria-live': 'polite' })
  const itemsBox = el('div', { class: 'items-list', 'aria-live': 'polite', 'aria-label': 'Workstream activity' })
  container.append(header, sessionsBox, turnsBox, itemsBox)

  let detail
  try {
    detail = await getWorkstream(workstreamId)
  } catch (error) {
    container.append(renderError(errorToProblem(error)))
    return container
  }

  header.append(el('h1', {}, [detail.title || '(untitled)']), el('a', { href: '#/' }, ['← All Workstreams']))
  sessionsBox.append(
    el(
      'ul',
      { class: 'sessions' },
      detail.sessions.map((session) =>
        el('li', {}, [`Session #${session.ordinal} — Agent: ${session.agentId} — phase: ${session.phase}${session.current ? ' (current)' : ''}`]),
      ),
    ),
  )

  const itemNodes = new Map<string, HTMLElement>()
  const turnNodes = new Map<string, HTMLElement>()

  function upsertItem(item: WorkstreamItem): void {
    const node = renderItem(item)
    const existing = itemNodes.get(item.id)
    if (existing) existing.replaceWith(node)
    else itemsBox.append(node)
    itemNodes.set(item.id, node)
  }

  try {
    const [{ items }, { turns }] = await Promise.all([listItems(workstreamId), listTurns(workstreamId)])
    for (const item of items) upsertItem(item)
    for (const turn of turns) {
      const node = renderTurnBadge(turn)
      turnsBox.append(node)
      turnNodes.set(turn.id, node)
    }

    const feedStatus = el('p', { class: 'feed-status muted', role: 'status' }, ['Live'])
    header.append(feedStatus)

    let feedAfter = 0 // resumable from 0 is safe here — a first page-load re-lists current state anyway
    const unsubscribe = subscribeFeed(
      workstreamId,
      feedAfter,
      (event: FeedEvent) => {
        feedAfter = event.position
        if (event.operation === 'upsert') {
          upsertItem(event.payload as unknown as WorkstreamItem)
        } else if (event.operation === 'remove') {
          const itemId = (event.payload as { itemId: string }).itemId
          itemNodes.get(itemId)?.remove()
          itemNodes.delete(itemId)
        } else if (event.operation === 'reset') {
          feedStatus.textContent = 'Resynchronizing…'
          void renderWorkstreamDetail(workstreamId).then((fresh) => {
            container.replaceWith(fresh)
          })
        } else if (event.operation === 'status') {
          const state = event.payload['state'] as { status?: string; stopReason?: string | null } | undefined
          const subjectId = event.payload['subjectId'] as string
          if (state?.status) {
            const existing = turnNodes.get(subjectId)
            const text = `Turn — ${state.status}${state.stopReason ? ` (${state.stopReason})` : ''}`
            if (existing) existing.textContent = text
            else {
              const node = el('div', { class: `turn-badge status-${state.status}`, role: 'status' }, [text])
              turnsBox.append(node)
              turnNodes.set(subjectId, node)
            }
          }
        }
      },
      (status) => {
        feedStatus.textContent = status === 'connected' ? 'Live' : 'Reconnecting…'
      },
    )
    window.addEventListener('hashchange', unsubscribe, { once: true })
  } catch (error) {
    itemsBox.append(renderError(errorToProblem(error)))
  }

  return container
}

// ---------- Errors ----------

function errorToProblem(error: unknown): { title: string; code: string; detail?: string } {
  if (error instanceof ApiError) return error.problem
  return { title: 'Something went wrong', code: 'client_error', detail: error instanceof Error ? error.message : String(error) }
}

// ---------- Router ----------

async function render(): Promise<void> {
  const hash = location.hash.replace(/^#/, '') || '/'
  let page: HTMLElement
  const newWorkstreamMatch = /^\/new$/.exec(hash)
  const detailMatch = /^\/w\/([^/]+)$/.exec(hash)
  if (newWorkstreamMatch) page = await renderNewWorkstreamForm()
  else if (detailMatch?.[1]) page = await renderWorkstreamDetail(detailMatch[1])
  else page = await renderWorkstreamList()

  root!.replaceChildren(renderPrincipalBar(), page)
}

window.addEventListener('hashchange', () => void render())
void render()

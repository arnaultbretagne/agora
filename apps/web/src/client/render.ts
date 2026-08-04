import type { WorkstreamItem, WorkstreamTurn } from './api.js'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}

/** Verbose/raw data goes behind a native `<details>` disclosure — collapsed by default, never discarded, fully keyboard/screen-reader operable with no custom JS. */
function disclosure(summary: string, content: Node | string): HTMLElement {
  const details = el('details', { class: 'disclosure' })
  details.append(el('summary', {}, [summary]), typeof content === 'string' ? el('pre', { class: 'raw' }, [content]) : content)
  return details
}

function contentBlocksText(blocks: readonly unknown[] | undefined): Node[] {
  if (!blocks) return []
  return blocks.map((block) => {
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      return el('p', { class: 'content-block' }, [record['text']])
    }
    return disclosure(`${String(record['type'] ?? 'content')} block`, JSON.stringify(block, null, 2))
  })
}

function renderMessage(item: WorkstreamItem): HTMLElement {
  const value = item.value as { role: string; content: unknown[]; chunkCount: number; completed: boolean }
  const card = el('article', { class: `item item-${item.kind}`, 'data-item-id': item.id, 'aria-label': `${value.role} message` })
  card.append(
    el('header', { class: 'item-header' }, [
      el('span', { class: 'role-badge' }, [value.role]),
      el('span', { class: 'status-badge' }, [value.completed ? 'complete' : 'streaming…']),
    ]),
    ...contentBlocksText(value.content),
  )
  return card
}

function renderToolCall(item: WorkstreamItem): HTMLElement {
  const value = item.value as {
    toolCallId: string
    name: string | null
    title: string | null
    kind: string | null
    status: string
    content: unknown[] | null
    rawInput: unknown
    rawOutput: unknown
    locations: { path: string; line: number | null }[]
  }
  const card = el('article', { class: 'item item-tool_call', 'data-item-id': item.id, 'aria-label': `tool call: ${value.title ?? value.toolCallId}` })
  card.append(
    el('header', { class: 'item-header' }, [
      el('span', { class: 'role-badge' }, ['tool_call']),
      el('span', { class: 'status-badge' }, [value.status]),
      ...(value.kind ? [el('span', { class: 'kind-badge' }, [value.kind])] : []),
    ]),
    el('p', {}, [value.title ?? value.name ?? value.toolCallId]),
  )
  if (value.locations.length > 0) {
    card.append(el('ul', { class: 'locations' }, value.locations.map((loc) => el('li', {}, [loc.line ? `${loc.path}:${loc.line}` : loc.path]))))
  }
  if (value.content) card.append(...contentBlocksText(value.content))
  if (value.rawInput !== undefined) card.append(disclosure('Raw input', JSON.stringify(value.rawInput, null, 2)))
  if (value.rawOutput !== undefined) card.append(disclosure('Raw output', JSON.stringify(value.rawOutput, null, 2)))
  return card
}

function renderPlan(item: WorkstreamItem): HTMLElement {
  const value = item.value as { entries: { content: string; priority: string; status: string }[]; removed: boolean }
  const card = el('article', { class: 'item item-plan', 'data-item-id': item.id, 'aria-label': 'plan' })
  card.append(el('header', { class: 'item-header' }, [el('span', { class: 'role-badge' }, ['plan'])]))
  if (value.removed) {
    card.append(el('p', {}, ['(plan removed)']))
  } else {
    card.append(
      el(
        'ol',
        { class: 'plan-entries' },
        value.entries.map((entry) => el('li', { class: `priority-${entry.priority} status-${entry.status}` }, [`[${entry.status}] ${entry.content}`])),
      ),
    )
  }
  return card
}

function renderPermission(item: WorkstreamItem): HTMLElement {
  const value = item.value as {
    title: string | null
    options: { optionId: string; name: string }[]
    status: string
    outcome: string | null
    selectedOptionId: string | null
  }
  const card = el('article', { class: 'item item-permission', 'data-item-id': item.id, 'aria-label': 'permission request' })
  card.append(
    el('header', { class: 'item-header' }, [el('span', { class: 'role-badge' }, ['permission']), el('span', { class: 'status-badge' }, [value.status])]),
    el('p', {}, [value.title ?? 'Permission requested']),
    el(
      'ul',
      { class: 'permission-options' },
      value.options.map((option) => el('li', { class: option.optionId === value.selectedOptionId ? 'selected' : '' }, [option.name ?? option.optionId])),
    ),
  )
  return card
}

/** Low-frequency contractual-value kinds (elicitation/terminal/usage/session_info/handoff) and unknown share one generic, always-inspectable rendering — never a data loss point. */
function renderGeneric(item: WorkstreamItem): HTMLElement {
  const card = el('article', { class: `item item-${item.kind}`, 'data-item-id': item.id, 'aria-label': `${item.kind} event` })
  card.append(el('header', { class: 'item-header' }, [el('span', { class: 'role-badge' }, [item.kind])]), disclosure('Details', JSON.stringify(item.value, null, 2)))
  return card
}

export function renderItem(item: WorkstreamItem): HTMLElement {
  switch (item.kind) {
    case 'message':
    case 'thought':
      return renderMessage(item)
    case 'tool_call':
      return renderToolCall(item)
    case 'plan':
      return renderPlan(item)
    case 'permission':
      return renderPermission(item)
    default:
      return renderGeneric(item)
  }
}

export function renderTurnBadge(turn: WorkstreamTurn): HTMLElement {
  const badge = el('div', { class: `turn-badge status-${turn.status}`, role: 'status' }, [
    `Turn ${turn.turnOrdinal} — ${turn.status}${turn.stopReason ? ` (${turn.stopReason})` : ''}`,
  ])
  return badge
}

export function renderError(problem: { title: string; code: string; detail?: string }): HTMLElement {
  const box = el('div', { class: 'error-box', role: 'alert' }, [el('p', {}, [problem.title])])
  if (problem.detail) box.append(disclosure('More information', problem.detail))
  return box
}

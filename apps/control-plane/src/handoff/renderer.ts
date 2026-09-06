// The opening Handoff renderer (S9 Step 5 — continuity.md "Handoff and seed policy",
// contracts/policies/handoff-seed-v1.md). Folds the canonical facts in `(W, H]` into the exact
// bytes that will be delivered as an ACP embedded resource, and digests them.
//
// Determinism is the whole contract. The digest this produces is what a custody driver later looks
// for as evidence of delivery (CONT-004, CONT-006), so a rendering that varies by one byte is a
// rendering that can never be proven delivered. Nothing about the renderer's environment reaches
// the output: no locale, no clock, no target harness, no fetch order. The only inputs are the facts
// and the policy revision.
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { factsBetween, type FactRecord } from '@agora/journal'

export const SEED_POLICY_REVISION = 'handoff-seed-v1'

/** Byte budgets, from the policy. A budget is refused, never quietly stretched. */
export const BUDGETS = {
  oneThought: 8 * 1024,
  allThoughts: 64 * 1024,
  oneToolResult: 32 * 1024,
  allToolResults: 128 * 1024,
  wholeResource: 512 * 1024,
  essentialWhenDegraded: 384 * 1024,
} as const

export interface RenderedHandoff {
  readonly uri: string
  readonly text: string
  readonly digest: string
  readonly policyRevision: string
  readonly w: number
  readonly h: number
  /** True when the range did not fit and the policy's overflow path was taken. Needs confirmation before dispatch. */
  readonly degraded: boolean
}

export interface RenderRequest {
  readonly workstreamId: string
  readonly commandId: string
  readonly w: number
  readonly h: number
}

export class UnresolvableReferenceError extends Error {
  constructor(readonly reference: string) {
    // Failing visibly rather than dropping it: a lossy rendering whose digest looks like a complete
    // one is exactly the thing this policy exists to prevent.
    super(`the Handoff references ${reference}, which cannot be resolved; the rendering is refused`)
    this.name = 'UnresolvableReferenceError'
  }
}

interface Frame {
  readonly method?: unknown
  readonly params?: {
    readonly sessionId?: unknown
    readonly prompt?: readonly { readonly type?: unknown; readonly text?: unknown; readonly resource?: unknown }[]
    readonly update?: {
      readonly sessionUpdate?: unknown
      readonly content?: { readonly type?: unknown; readonly text?: unknown }
      readonly entries?: unknown
      readonly title?: unknown
      readonly status?: unknown
      readonly rawOutput?: unknown
      readonly content_?: unknown
    }
    readonly [key: string]: unknown
  }
}

/** One rendered block, kept separate until the budget decides what survives. */
interface Item {
  readonly seq: number
  readonly essential: boolean
  readonly kind: 'user' | 'agent' | 'thought' | 'plan' | 'tool' | 'permission' | 'handoff' | 'unknown'
  readonly text: string
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Truncates on a Unicode scalar boundary and says exactly what was cut. `Array.from` iterates code
 * points, so a surrogate pair is never split; cutting mid-code-point would produce bytes that
 * digest differently on a platform that repairs them differently.
 */
function truncate(text: string, limit: number, seq: number): string {
  if (utf8Length(text) <= limit) return text
  const marker = ` […] [truncated by ${SEED_POLICY_REVISION}] original_bytes=${String(utf8Length(text))} sha256=${digestOf(text)} seq=${String(seq)}`
  let kept = ''
  for (const codePoint of text) {
    if (utf8Length(kept) + utf8Length(codePoint) + utf8Length(marker) > limit) break
    kept += codePoint
  }
  return kept + marker
}

function textOfBlocks(blocks: readonly { readonly type?: unknown; readonly text?: unknown }[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

function parseFrame(fact: FactRecord): Frame | null {
  // The payload column holds the raw frame text as jsonb (ADR 0004); pg returns it parsed.
  if (fact.payload === null || typeof fact.payload !== 'object') return null
  return fact.payload as Frame
}

/**
 * Whether this prompt frame is itself a Handoff. A Handoff carries an embedded resource under the
 * `agora://` scheme, and re-expanding it would grow every later Handoff by every earlier one.
 */
function handoffUriOf(frame: Frame): string | null {
  for (const block of frame.params?.prompt ?? []) {
    const resource = block.resource as { uri?: unknown } | undefined
    if (typeof resource?.uri === 'string' && resource.uri.startsWith('agora://')) return resource.uri
  }
  return null
}

/** The item each fact contributes, or null when the policy excludes it. */
function itemFor(fact: FactRecord, state: { thoughtBudget: number; toolBudget: number }): Item | null {
  if (fact.kind !== 'acp.envelope') return null // session.opened/ended/provenance: bootstrap bookkeeping

  const frame = parseFrame(fact)
  if (frame === null) return null
  const method = fact.acp?.method ?? (typeof frame.method === 'string' ? frame.method : null)

  if (method === 'session/prompt' && fact.acp?.rpcKind === 'request') {
    const handoffUri = handoffUriOf(frame)
    if (handoffUri !== null) {
      // Card metadata only, never nested content.
      return { seq: fact.seq, essential: false, kind: 'handoff', text: `handoff: ${handoffUri} (${SEED_POLICY_REVISION})` }
    }
    return { seq: fact.seq, essential: true, kind: 'user', text: `user: ${textOfBlocks(frame.params?.prompt)}` }
  }

  if (method === 'session/update') {
    const update = frame.params?.update
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk':
        return { seq: fact.seq, essential: true, kind: 'agent', text: `agent: ${typeof update.content?.text === 'string' ? update.content.text : ''}` }
      case 'user_message_chunk':
        // The agent's own replay of a received message. Included only where no prompt request in the
        // range already carries it — decided by the caller's de-duplication, below.
        return { seq: fact.seq, essential: true, kind: 'user', text: `user: ${typeof update.content?.text === 'string' ? update.content.text : ''}` }
      case 'agent_thought_chunk': {
        const body = typeof update.content?.text === 'string' ? update.content.text : ''
        if (state.thoughtBudget <= 0) return null
        const capped = truncate(body, Math.min(BUDGETS.oneThought, state.thoughtBudget), fact.seq)
        state.thoughtBudget -= utf8Length(capped)
        return { seq: fact.seq, essential: false, kind: 'thought', text: `thought (prior agent): ${capped}` }
      }
      case 'plan':
        // Only the LAST plan in the range survives; superseded revisions are dropped by the fold.
        return { seq: fact.seq, essential: true, kind: 'plan', text: `plan: ${stableJson(update.entries)}` }
      case 'tool_call':
      case 'tool_call_update': {
        const title = typeof update.title === 'string' ? update.title : 'tool'
        const status = typeof update.status === 'string' ? update.status : 'unknown'
        const result = typeof update.content?.text === 'string' ? update.content.text : ''
        if (state.toolBudget <= 0) return { seq: fact.seq, essential: false, kind: 'tool', text: `tool: ${title} [${status}]` }
        const capped = truncate(result, Math.min(BUDGETS.oneToolResult, state.toolBudget), fact.seq)
        state.toolBudget -= utf8Length(capped)
        return { seq: fact.seq, essential: false, kind: 'tool', text: `tool: ${title} [${status}] ${capped}`.trimEnd() }
      }
      default:
        return manifestEntry(fact, `session/update:${String(update?.sessionUpdate ?? 'unknown')}`)
    }
  }

  if (method === 'session/request_permission') {
    return { seq: fact.seq, essential: false, kind: 'permission', text: `permission: ${stableJson(frame.params?.['toolCall'])}` }
  }

  // Transport and bootstrap frames the policy names as excluded.
  if (
    method === 'initialize' ||
    method === 'session/new' ||
    method === 'session/resume' ||
    method === 'session/load' ||
    method === 'session/cancel' ||
    method === 'session/set_session_config' ||
    fact.acp?.rpcKind === 'response'
  ) {
    return null
  }

  return manifestEntry(fact, method ?? 'unknown')
}

/** An unnamed frame is recorded honestly — kind, position, digest — and its payload is not injected. */
function manifestEntry(fact: FactRecord, label: string): Item {
  return {
    seq: fact.seq,
    essential: false,
    kind: 'unknown',
    text: `unrendered: ${label} seq=${String(fact.seq)} sha256=${digestOf(stableJson(fact.payload))}`,
  }
}

/**
 * JSON with object keys in a fixed order. `JSON.stringify` preserves insertion order, which is the
 * order the driver happened to parse the row in — stable in practice, but not something the policy
 * can promise, so it is made explicit here.
 */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableJson(member)}`).join(',')}}`
}

export function handoffUri(workstreamId: string, commandId: string): string {
  return `agora://workstreams/${workstreamId}/handoffs/${commandId}`
}

/**
 * Renders the opening Handoff for `(W, H]`. An empty range renders nothing at all — `null`, not an
 * empty resource: CONT-002 says a cross-seeded first Session sends no Handoff, and an empty one
 * would still be a turn that has to be admitted, dispatched and proven.
 */
export async function renderHandoff(client: pg.Pool | pg.PoolClient, request: RenderRequest): Promise<RenderedHandoff | null> {
  if (request.h <= request.w) return null

  // `(W, H]` — exclusive at W. factsBetween is inclusive at both ends, so the lower bound is W + 1:
  // fact W is the last one the context already had, and re-sending it would tell the context
  // something it was already told.
  const facts = await factsBetween(client, request.workstreamId, request.w + 1, request.h)
  const state = { thoughtBudget: BUDGETS.allThoughts, toolBudget: BUDGETS.allToolResults }

  const items: Item[] = []
  const promptedText = new Set<string>()
  for (const fact of facts) {
    const item = itemFor(fact, state)
    if (item === null) continue
    if (item.kind === 'user') {
      // A message that arrived as a prompt request AND was replayed as a user_message_chunk is one
      // message: rendering it twice would tell the next context it was said twice.
      if (promptedText.has(item.text)) continue
      promptedText.add(item.text)
    }
    items.push(item)
  }

  // Only the final plan state survives (the policy's own rule): earlier revisions describe states
  // nothing acted on, and spending the budget on them costs the messages that were.
  const lastPlanSeq = items.filter((item) => item.kind === 'plan').at(-1)?.seq
  const folded = items.filter((item) => item.kind !== 'plan' || item.seq === lastPlanSeq)

  const header = `agora handoff ${SEED_POLICY_REVISION} range=(${String(request.w)},${String(request.h)}]`
  const body = folded.map((item) => item.text).join('\n')
  const whole = `${header}\n${body}\n`

  if (utf8Length(whole) <= BUDGETS.wholeResource) {
    return { uri: handoffUri(request.workstreamId, request.commandId), text: whole, digest: digestOf(whole), policyRevision: SEED_POLICY_REVISION, w: request.w, h: request.h, degraded: false }
  }

  return degrade(request, facts, folded, header)
}

/**
 * The overflow path. A manifest of everything, the most recent essential items complete inside
 * 384 KiB, and bounded previews with digests for the rest — marked degraded, which the dispatcher
 * must have confirmed before it sends anything.
 */
function degrade(request: RenderRequest, facts: readonly FactRecord[], items: readonly Item[], header: string): RenderedHandoff {
  const manifest = facts.map((fact) => `manifest: seq=${String(fact.seq)} kind=${fact.kind} sha256=${digestOf(stableJson(fact.payload))}`).join('\n')

  const essential: string[] = []
  let used = 0
  for (const item of [...items].reverse()) {
    if (!item.essential) continue
    const size = utf8Length(item.text) + 1
    if (used + size > BUDGETS.essentialWhenDegraded) break
    essential.unshift(item.text)
    used += size
  }
  const kept = new Set(essential)
  const previews = items
    .filter((item) => !kept.has(item.text))
    .map((item) => `preview: seq=${String(item.seq)} ${truncate(item.text, 256, item.seq)}`)
    .join('\n')

  const text = `${header} fidelity=degraded\n${manifest}\n${essential.join('\n')}\n${previews}\n`
  return {
    uri: handoffUri(request.workstreamId, request.commandId),
    text,
    digest: digestOf(text),
    policyRevision: SEED_POLICY_REVISION,
    w: request.w,
    h: request.h,
    degraded: true,
  }
}

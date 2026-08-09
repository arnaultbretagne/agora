import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getCheckpoint } from './projections.js'
import { PROJECTOR_NAME, readWorkstreamItem, type WireWorkstreamItem } from './projector.js'

/**
 * `contracts/policies/handoff-seed-v1.md` — the ONLY normative source for the numbers/rules below.
 * Do not change this file's behavior without updating that policy doc (docs/specs/06 "Seed
 * policy": "versioned and auditable").
 */
export const HANDOFF_SEED_POLICY_VERSION = 'handoff-v1'

const THOUGHT_ITEM_CAP_BYTES = 8 * 1024
const THOUGHT_TOTAL_CAP_BYTES = 64 * 1024
const TOOL_RESULT_ITEM_CAP_BYTES = 32 * 1024
const TOOL_RESULT_TOTAL_CAP_BYTES = 128 * 1024
const RESOURCE_TOTAL_CAP_BYTES = 512 * 1024
const ESSENTIAL_RESERVED_CAP_BYTES = 384 * 1024

export class HandoffNotReadyError extends Error {
  constructor(
    readonly checkpointThroughSeq: number,
    readonly requiredThroughSeq: number,
  ) {
    super(`projector checkpoint (through ${checkpointThroughSeq}) has not yet reached the handoff source range (through ${requiredThroughSeq})`)
    this.name = 'HandoffNotReadyError'
  }
}

export interface BuiltHandoffContent {
  readonly uri: string
  readonly text: string
  readonly sha256: Uint8Array
  readonly sizeBytes: number
  readonly fidelity: 'complete' | 'degraded'
}

/** docs/specs/06 "Truncation ... adds ... explicit `[truncated by handoff-v1]` marker", on a Unicode boundary. */
function truncateUtf8(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean; readonly originalBytes: number } {
  const full = Buffer.from(text, 'utf8')
  if (full.length <= maxBytes) return { text, truncated: false, originalBytes: full.length }
  let end = maxBytes
  // Back up off any UTF-8 continuation byte (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (full[end]! & 0xc0) === 0x80) end -= 1
  return { text: full.subarray(0, end).toString('utf8'), truncated: true, originalBytes: full.length }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function extractText(blocks: readonly unknown[] | null | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      const b = block as { type?: string; text?: string; resource?: { text?: string } }
      if (b?.type === 'text' && typeof b.text === 'string') return b.text
      if (b?.type === 'resource' && typeof b.resource?.text === 'string') return b.resource.text
      return b?.type ? `[${b.type} content]` : '[content]'
    })
    .join('')
}

interface RenderedBlock {
  readonly itemId: string
  readonly kind: string
  readonly heading: string
  /** Full, untruncated body text (budget capping happens during assembly, not here). */
  readonly body: string
  readonly essential: boolean
  readonly budget: 'thought' | 'tool_result' | 'none'
  readonly digest: string
}

function renderItem(item: WireWorkstreamItem): RenderedBlock {
  const v = item.value as Record<string, unknown>
  switch (item.kind) {
    case 'message': {
      const role = v['role'] === 'user' ? 'User message' : 'Agent message'
      const body = extractText(v['content'] as unknown[])
      return { itemId: item.id, kind: item.kind, heading: role, body, essential: true, budget: 'none', digest: sha256Hex(body) }
    }
    case 'thought': {
      const body = extractText(v['content'] as unknown[])
      return {
        itemId: item.id,
        kind: item.kind,
        heading: 'Agent thought (prior Agent)',
        body,
        essential: false,
        budget: 'thought',
        digest: sha256Hex(body),
      }
    }
    case 'plan': {
      const entries = (v['entries'] as { content: string; priority: string; status: string }[] | undefined) ?? []
      const body = entries.map((e, i) => `${i + 1}. [${e.priority}] ${e.status} — ${e.content}`).join('\n')
      return { itemId: item.id, kind: item.kind, heading: 'Plan (latest state)', body, essential: true, budget: 'none', digest: sha256Hex(body) }
    }
    case 'tool_call': {
      const title = (v['title'] as string | null) ?? (v['name'] as string | null) ?? 'tool call'
      const status = (v['status'] as string | null) ?? 'unknown'
      const rawInput = v['rawInput'] !== undefined && v['rawInput'] !== null ? JSON.stringify(v['rawInput']) : undefined
      const resultText = extractText(v['content'] as unknown[])
      const lines = [`Tool call: ${title}`, `status: ${status}`]
      if (rawInput) lines.push(`input: ${rawInput}`)
      if (resultText) lines.push(`result: ${resultText}`)
      const body = lines.join('\n')
      return {
        itemId: item.id,
        kind: item.kind,
        heading: `Tool call: ${title}`,
        body,
        essential: true,
        budget: 'tool_result',
        digest: sha256Hex(body),
      }
    }
    case 'permission': {
      const title = (v['title'] as string | null) ?? 'permission request'
      const outcome = (v['outcome'] as string | null) ?? (v['status'] as string)
      const body = `${title}: ${outcome}`
      return { itemId: item.id, kind: item.kind, heading: 'Permission decision', body, essential: true, budget: 'none', digest: sha256Hex(body) }
    }
    case 'handoff': {
      // docs/specs/06 "Previous Handoffs: Card metadata only; their copied resource content is not nested."
      const body = `source=(${v['sourceFromSeq']},${v['sourceThroughSeq']}] policy=${v['seedPolicyVersion']} digest=${v['digest']} fidelity=${v['fidelity']}`
      return { itemId: item.id, kind: item.kind, heading: 'Prior Handoff', body, essential: false, budget: 'none', digest: sha256Hex(body) }
    }
    case 'terminal': {
      const body = `command=${v['command'] ?? 'unknown'} status=${v['status'] ?? 'unknown'}`
      return { itemId: item.id, kind: item.kind, heading: 'Terminal', body, essential: false, budget: 'none', digest: sha256Hex(body) }
    }
    default: {
      // usage/session_info/elicitation/unknown: manifest entry only, never raw payload by default.
      const body = `kind=${item.kind} position=${item.firstWorkstreamSeq}`
      return { itemId: item.id, kind: item.kind, heading: `${item.kind} (manifest only)`, body, essential: false, budget: 'none', digest: sha256Hex(body) }
    }
  }
}

function manifestLine(block: RenderedBlock, seq: number): string {
  return `- [${seq}] ${block.kind} item=${block.itemId} digest=${block.digest}`
}

/**
 * docs/specs/06 "Handoff representation" + "Seed policy" + `handoff-seed-v1.md`. Deterministic:
 * same (workstreamId, sourceFromSeq, sourceThroughSeq, projector version) always renders
 * byte-identical text — no wall-clock time, locale or UI state ever enters the output.
 *
 * Reads from the PROJECTION (docs/specs/06 explicitly allows either that OR folding canonical
 * events directly), gated by the projector's own checkpoint actually having reached
 * `sourceThroughSeq` — callers needing a guarantee must check the checkpoint first (this throws
 * `HandoffNotReadyError` rather than silently building from a stale/incomplete cache).
 */
export async function buildHandoffContent(
  client: PoolClient,
  input: { readonly workstreamId: string; readonly commandId: string; readonly sourceFromSeq: number; readonly sourceThroughSeq: number },
): Promise<BuiltHandoffContent> {
  const checkpoint = await getCheckpoint(client, PROJECTOR_NAME, input.workstreamId)
  if (checkpoint.throughWorkstreamSeq < input.sourceThroughSeq) {
    throw new HandoffNotReadyError(checkpoint.throughWorkstreamSeq, input.sourceThroughSeq)
  }

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM projection.workstream_items
     WHERE workstream_id = $1 AND first_workstream_seq > $2 AND first_workstream_seq <= $3
     ORDER BY first_workstream_seq ASC`,
    [input.workstreamId, input.sourceFromSeq, input.sourceThroughSeq],
  )

  const blocks: RenderedBlock[] = []
  for (const row of rows) {
    const item = await readWorkstreamItem(client, row.id)
    if (item) blocks.push(renderItem(item))
  }

  const uri = `agora://workstreams/${input.workstreamId}/handoffs/${input.commandId}`
  const header = `# Workstream handoff (${HANDOFF_SEED_POLICY_VERSION})\n# Source range: (${input.sourceFromSeq}, ${input.sourceThroughSeq}]\n`

  // Pass 1: render every block at full fidelity, applying only per-item/running-total budgets
  // (thought/tool-result caps) — never the overall 512 KiB cap yet.
  let thoughtsTotal = 0
  let toolResultsTotal = 0
  const rendered: string[] = []
  for (const block of blocks) {
    let body = block.body
    if (block.budget === 'thought') {
      const itemCapped = truncateUtf8(body, THOUGHT_ITEM_CAP_BYTES)
      const remaining = Math.max(0, THOUGHT_TOTAL_CAP_BYTES - thoughtsTotal)
      const totalCapped = truncateUtf8(itemCapped.text, remaining)
      const bytes = Buffer.byteLength(totalCapped.text, 'utf8')
      thoughtsTotal += bytes
      body = totalCapped.text
      if (itemCapped.truncated || totalCapped.truncated || bytes === 0) {
        body = `${body}\n[truncated by handoff-v1: original ${itemCapped.originalBytes} bytes, item=${block.itemId}, sha256=${sha256Hex(block.body)}]`
      }
    } else if (block.budget === 'tool_result') {
      const itemCapped = truncateUtf8(body, TOOL_RESULT_ITEM_CAP_BYTES)
      const remaining = Math.max(0, TOOL_RESULT_TOTAL_CAP_BYTES - toolResultsTotal)
      const totalCapped = itemCapped.truncated ? itemCapped : truncateUtf8(itemCapped.text, remaining)
      const bytes = Buffer.byteLength(totalCapped.text, 'utf8')
      toolResultsTotal += bytes
      body = totalCapped.text
      if (itemCapped.truncated || totalCapped.truncated) {
        body = `${body}\n[truncated by handoff-v1: original ${itemCapped.originalBytes} bytes, item=${block.itemId}, sha256=${sha256Hex(block.body)}]`
      }
    }
    rendered.push(`## ${block.heading}\n${body}`)
  }

  const fullText = header + rendered.join('\n\n')
  const fullBytes = Buffer.byteLength(fullText, 'utf8')

  if (fullBytes <= RESOURCE_TOTAL_CAP_BYTES) {
    const text = fullText
    return { uri, text, sha256: new Uint8Array(createHash('sha256').update(text, 'utf8').digest()), sizeBytes: Buffer.byteLength(text, 'utf8'), fidelity: 'complete' }
  }

  // Overflow (docs/specs/06 "Source range exceeds size policy"): a deterministic manifest of every
  // source item, then complete MOST-RECENT essential items filling the reserved budget, older
  // essential items and all non-essential ones reduced to a manifest reference. Never a model summary.
  const manifest = blocks.map((b, i) => manifestLine(b, i)).join('\n')
  const essentialReversed = [...blocks].reverse().filter((b) => b.essential)
  const included = new Set<string>()
  let essentialUsed = 0
  for (const block of essentialReversed) {
    const piece = `## ${block.heading}\n${block.body}`
    const bytes = Buffer.byteLength(piece, 'utf8')
    if (essentialUsed + bytes > ESSENTIAL_RESERVED_CAP_BYTES) continue
    essentialUsed += bytes
    included.add(block.itemId)
  }

  const degradedSections = blocks.map((block) => {
    if (included.has(block.itemId)) return `## ${block.heading}\n${block.body}`
    return `## ${block.heading} [not included — see manifest, item=${block.itemId}, digest=${block.digest}]`
  })

  const degradedText = [
    header,
    `# fidelity=degraded: essential content exceeded the ${RESOURCE_TOTAL_CAP_BYTES}-byte policy budget`,
    '## Manifest (all source items, in order)',
    manifest,
    ...degradedSections,
  ].join('\n\n')

  return {
    uri,
    text: degradedText,
    sha256: new Uint8Array(createHash('sha256').update(degradedText, 'utf8').digest()),
    sizeBytes: Buffer.byteLength(degradedText, 'utf8'),
    fidelity: 'degraded',
  }
}

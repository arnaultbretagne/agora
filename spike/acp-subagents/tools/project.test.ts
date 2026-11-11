// Spike only: the captured lines through Agora's real log, as production would take them once
// `clientCapabilities.subagents` is declared. A Lab (Agora in this process, the real bridge, the mock agent
// on FakeKube) opens one Workstream per scenario; the mock writes the scenario's received lines byte for
// byte (`/raw`), its parent's session id replaced by the mock's own, every child's left as captured, each
// agent request given an id of its own. Then: what the log kept, what the core projector made of each child
// line, and what the client's conversion (apps/web messagesOf) shows.
//   cd packages/log && node test/run.ts ../../spike/acp-subagents/tools/project.test.ts
// Lines that came after the prompt's answer (a background child's) go in the same turn: the log attaches a
// line outside any turn to the session's last turn (state.ts), so the projection is the same.
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { CoreProjection, encode, type Entry } from '../../../packages/log/src/index.ts'
import { base64, opened } from '../../../packages/log/test/support.ts'
import { apply, empty, type ThreadRow } from '../../../apps/web/src/agora/objects.ts'
import { messagesOf } from '../../../apps/web/src/agora/view.ts'

const ROOT = new URL('../', import.meta.url)
const CAPTURES = process.env.SPIKE_CAPTURES?.split(',') ?? ['claude-caps', 'claude-baseline', 'claude-caps-2', 'codex-caps', 'codex-baseline', 'codex-caps-2']
const OUT = new URL('projection/', ROOT)

type M = Record<string, any>
interface Rec { seq: number; t: number; dir: 'in' | 'out'; label: string; line: string }

/**
 * A scenario's received lines from its prompt on: notifications and the agent's requests, not answers, of its
 * parent's session and its descendants' — those that came later, under the next scenario's label, included.
 */
function scenarioLines(recs: Rec[], label: string): { parent: string; lines: M[] } | null {
  const prompt = recs.find((r) => r.label.split('#')[0] === label && r.dir === 'out' && JSON.parse(r.line).method === 'session/prompt')
  if (!prompt) return null
  const parent = String(JSON.parse(prompt.line).params.sessionId)
  const tree = new Set([parent])
  const lines: M[] = []
  for (const r of recs) {
    if (r.dir !== 'in' || r.seq <= prompt.seq) continue
    const m = JSON.parse(r.line) as M
    const u = m.params?.update
    if (u?.sessionUpdate === 'subagent_update' && tree.has(String(m.params.sessionId))) tree.add(String(u.sessionId))
    if (typeof m.method === 'string' && tree.has(String(m.params?.sessionId))) lines.push(m)
  }
  return { parent, lines }
}

const rowsOf = (entries: readonly Entry[]): { rows: ThreadRow[]; changedBy: Map<string, Set<string>> } => {
  const projection = new CoreProjection()
  const rows: ThreadRow[] = []
  const changedBy = new Map<string, Set<string>>()
  let position = 0n
  for (const entry of entries)
    for (const id of projection.apply([entry])) {
      const o = projection.objects.get(id)!
      rows.push({ type: 'live', position: String(++position), operation: 'upsert', kind: o.kind, id, object: o.object as Record<string, unknown> })
      const set = changedBy.get(entry.position) ?? new Set<string>()
      set.add(id)
      changedBy.set(entry.position, set)
    }
  return { rows, changedBy }
}

test('the captured lines through the log, the projector and the client conversion', { timeout: 600_000 }, async (t) => {
  const { lab } = await opened(t, { workstreams: { maxActive: 100 } })
  mkdirSync(OUT, { recursive: true })
  const summary: Record<string, unknown> = {}
  for (const capture of CAPTURES) {
    let recs: Rec[]
    try {
      recs = readFileSync(new URL(`captures/${capture}.jsonl`, ROOT), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec)
    } catch {
      continue
    }
    const labels = [...new Set(recs.map((r) => r.label.split('#')[0]!))].filter((l) => !['setup', 'initialize', 'end'].includes(l))
    for (const label of labels) {
      const scenario = scenarioLines(recs, label)
      if (!scenario || scenario.lines.length === 0) continue
      const ws = await lab.workstream()
      const e = await lab.open(ws)
      let n = 0
      const raw = scenario.lines.map((m) => {
        const copy = structuredClone(m)
        if (copy.params?.sessionId === scenario.parent) copy.params.sessionId = e.acpId
        for (const k of ['senderSessionId', 'recipientSessionId'] as const) if (copy.params?.update?.[k] === scenario.parent) copy.params.update[k] = e.acpId
        if ('id' in copy) copy.id = `spike-${String(++n)}`
        return JSON.stringify(copy)
      })
      const answer = await lab.write(ws, `/raw ${base64(...raw)}`)
      if (!answer.accepted) throw new Error(`${capture}/${label}: Write refused ${String(answer.reason)}`)
      await lab.turn(ws, ['done', 'failed', 'cancelled'], 60_000)
      const entries = await lab.entries(ws)
      const diagnostics = await lab.store.writer.query('SELECT reason, count(*)::int AS n FROM diagnostics WHERE workstream=$1 GROUP BY reason', [ws])
      const received = entries.filter((x) => x.kind === 'acp' && x.direction === 'in' && (x.method === 'session/update' || x.method === 'session/request_permission'))
      const childLines = received.filter((x) => (x.content.params as M)?.sessionId !== e.acpId)
      const { rows, changedBy } = rowsOf(entries)
      let state = empty
      for (const row of rows) state = apply(state, row)
      state = { ...state, complete: true }
      const objects = new Map([...state.objects.values()].map((o) => [o.id, o]))
      // What each child line became: the object it changed, by type.
      const became: Record<string, Record<string, number>> = {}
      const sessionOf = new Set<string>()
      for (const x of childLines) {
        const u = (x.content.params as M).update as M | undefined
        const kind = String(u?.sessionUpdate ?? x.method)
        sessionOf.add(String(x.session))
        for (const id of changedBy.get(x.position) ?? []) {
          const o = objects.get(id)
          if (!o || o.kind !== 'element') continue
          const type = String(o.object.type) + (o.object.type === 'acp' ? `:${String(((o.object.line as M)?.params?.update?.sessionUpdate) ?? (o.object.line as M)?.method)}` : '')
          became[kind] ??= {}
          became[kind]![type] = (became[kind]![type] ?? 0) + 1
        }
      }
      const turns = [...objects.values()].filter((o) => o.kind === 'turn')
      // What the Workstream's view (the model picker, the context ring) holds at the end: a child's
      // config_option_update or usage_update counts as the parent's (state.ts takes the execution's session).
      const view = [...objects.values()].find((o) => o.kind === 'workstream')?.object as M | undefined
      const settings = Array.isArray(view?.settings) ? (view.settings as M[]).map((x) => `${String(x.id)}=${String(x.currentValue ?? x.value ?? '')}`) : view?.settings
      const lastChildConfig = [...childLines].reverse().find((x) => (x.content.params as M)?.update?.sessionUpdate === 'config_option_update')
      const lastChildUsage = [...childLines].reverse().find((x) => (x.content.params as M)?.update?.sessionUpdate === 'usage_update')
      const messages = messagesOf(state)
      const shown = messages.map((m) => ({
        role: m.role,
        parts: Array.isArray(m.content)
          ? (m.content as M[]).map((p) => (p.type === 'text' ? `text: ${String(p.text).slice(0, 140)}` : p.type === 'tool-call' ? `tool-call: ${String(p.toolName)} ${JSON.stringify((p.artifact as M)?.title ?? '')}` : String(p.type)))
          : [String(m.content).slice(0, 140)],
      }))
      // Its execution stopped: one mock agent at a time.
      await lab.command(ws, 'Stop', { execution: e.id })
      const key = `${capture}/${label}`
      summary[key] = {
        lines: scenario.lines.length,
        kept: received.length,
        diagnostics: diagnostics.rows,
        childLines: childLines.length,
        childLinesSession: [...sessionOf].map((s) => (s === String(e.session) ? 'the parent session' : s)),
        turns: turns.length,
        viewSettings: settings,
        viewUsage: view?.usage,
        lastChildConfigIds: lastChildConfig ? ((lastChildConfig.content.params as M).update.configOptions as M[]).map((o) => o.id) : null,
        lastChildUsage: lastChildUsage ? { used: (lastChildUsage.content.params as M).update.used, size: (lastChildUsage.content.params as M).update.size } : null,
        became,
        shown,
      }
      writeFileSync(new URL(`${capture}--${label}.entries.json`, OUT), encode({ capture, label, parent: e.acpId, entries }))
      console.log(`${key}: ${String(scenario.lines.length)} lines, kept ${String(received.length)}, refused ${JSON.stringify(diagnostics.rows)}, child lines ${String(childLines.length)} → ${JSON.stringify(became)}`)
    }
  }
  writeFileSync(new URL('summary.json', OUT), JSON.stringify(summary, null, 1))
})

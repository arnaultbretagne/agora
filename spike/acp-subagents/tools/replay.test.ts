// The lines captured from the real adapters, through the native sub-agents' code: Agora in this process (a Lab), the
// mock agent writing each scenario's received lines byte for byte (`/raw`), its parent's session id replaced by the
// mock's own, every child's left as captured. Then what the log, the fold and the projection made of them.
// Run from a checkout of the branch that holds that code (feat/native-subagents), whose test support it loads:
//   cd <checkout>/packages/log && SUPPORT=$PWD/test/support.ts CAPTURES=<captures dir> NAMES=claude-caps-0.106.0,codex-caps-2.6.0 node test/run.ts <this file>
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type M = Record<string, any>
interface Rec { seq: number; t: number; dir: 'in' | 'out'; label: string; line: string }
const { base64, opened } = (await import(process.env.SUPPORT!)) as { base64: (...values: string[]) => string; opened: (t: unknown, options: unknown) => Promise<{ lab: any; db: any }> }
const DIR = process.env.CAPTURES!
const NAMES = process.env.NAMES!.split(',')

function scenarioLines(recs: Rec[], label: string): { parent: string; lines: M[]; announced: Map<string, string> } | null {
  const prompt = recs.find((r) => r.label.split('#')[0] === label && r.dir === 'out' && JSON.parse(r.line).method === 'session/prompt')
  if (!prompt) return null
  const parent = String(JSON.parse(prompt.line).params.sessionId)
  const tree = new Set([parent])
  const announced = new Map<string, string>()
  const lines: M[] = []
  for (const r of recs) {
    if (r.dir !== 'in' || r.seq <= prompt.seq) continue
    const m = JSON.parse(r.line) as M
    const u = m.params?.update
    if (u?.sessionUpdate === 'subagent_update' && tree.has(String(m.params.sessionId))) {
      tree.add(String(u.sessionId))
      announced.set(String(u.sessionId), String(m.params.sessionId))
    }
    if (typeof m.method === 'string' && tree.has(String(m.params?.sessionId))) lines.push(m)
  }
  return { parent, lines, announced }
}

test('the adapters’ captured lines through the native sub-agents’ code', { timeout: 900_000 }, async (t) => {
  const { lab, db } = await opened(t, { workstreams: { maxActive: 100 } })
  const summary: Record<string, unknown> = {}
  for (const capture of NAMES) {
    const recs = readFileSync(join(DIR, `${capture}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec)
    const labels = [...new Set(recs.map((r) => r.label.split('#')[0]!))].filter((l) => !['setup', 'initialize', 'end'].includes(l))
    for (const label of labels) {
      const scenario = scenarioLines(recs, label)
      if (!scenario || scenario.lines.length === 0) continue
      const ws = await lab.workstream()
      const e = await lab.open(ws)
      const before = (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')?.object as M | undefined
      let n = 0
      const raw = scenario.lines.map((m) => {
        const copy = structuredClone(m)
        if (copy.params?.sessionId === scenario.parent) copy.params.sessionId = e.acpId
        for (const k of ['senderSessionId', 'recipientSessionId'] as const) if (copy.params?.update?.[k] === scenario.parent) copy.params.update[k] = e.acpId
        if ('id' in copy) copy.id = `replay-${String(++n)}`
        return JSON.stringify(copy)
      })
      const answer = await lab.write(ws, `/raw ${base64(...raw)}`)
      if (!answer.accepted) throw new Error(`${capture}/${label}: Write refused ${String(answer.reason)}`)
      await lab.turn(ws, ['done', 'failed', 'cancelled'], 120_000)
      await lab.workstreams.projections.run(ws)
      const diagnostics = (await lab.store.writer.query('SELECT reason, count(*)::int AS n FROM diagnostics WHERE workstream=$1 GROUP BY reason', [ws])).rows
      const hosted = (await db.admin.query('SELECT id, parent, depth FROM workstreams WHERE host=$1 ORDER BY depth, id', [ws])).rows as { id: string; parent: string; depth: number }[]
      const host = await lab.workstreams.projections.objects(ws)
      const view = host.find((o) => o.kind === 'workstream')?.object as M | undefined
      const lines = host.filter((o) => o.kind === 'element' && o.object.type === 'subagent').map((o) => o.object as M)
      const generic = host.filter((o) => o.kind === 'element' && o.object.type === 'acp').map((o) => String((o.object.line as M)?.params?.update?.sessionUpdate ?? (o.object.line as M)?.method))
      const children = []
      for (const child of hosted) {
        const objects = await lab.workstreams.projections.objects(child.id)
        const v = objects.find((o) => o.kind === 'workstream')?.object as M | undefined
        const turns = objects.filter((o) => o.kind === 'turn').map((o) => String(o.object.status))
        const types: Record<string, number> = {}
        for (const o of objects.filter((x) => x.kind === 'element')) types[String(o.object.type)] = (types[String(o.object.type)] ?? 0) + 1
        children.push({ depth: child.depth, under: child.parent === ws ? 'host' : 'a sub-stream', state: v?.state, subagent: v?.subagent, title: v?.title, cancel: v?.native?.cancel, turns, elements: types })
      }
      // The host's view holds what its own session said last, never what a child's did.
      const lastOf = (kind: string, own: boolean) => [...scenario.lines].reverse().find((m) => m.params?.update?.sessionUpdate === kind && (m.params.sessionId === scenario.parent) === own)?.params.update as M | undefined
      const values = (options: unknown) => (Array.isArray(options) ? (options as M[]).map((o) => `${String(o.id ?? o.configId)}=${String(o.currentValue)}`).join(',') : null)
      const num = (v: unknown) => String((v as M | undefined)?.value ?? v)
      const ownUsage = lastOf('usage_update', true)
      const childUsage = lastOf('usage_update', false)
      const ownConfig = lastOf('config_option_update', true)
      const childConfig = lastOf('config_option_update', false)
      const usageIs = ownUsage ? (num(view?.usage?.used) === String(ownUsage.used) && num(view?.usage?.size) === String(ownUsage.size) ? 'its own' : 'NOT its own') : JSON.stringify(view?.usage) === JSON.stringify(before?.usage) ? 'as before' : 'CHANGED with no line of its own'
      const settingsAre = ownConfig ? (values(view?.settings) === values(ownConfig.configOptions) ? 'its own' : 'NOT its own') : values(view?.settings) === values(before?.settings) ? 'as before' : 'CHANGED with no line of its own'
      const stable = `usage ${usageIs}${childUsage ? ` (a child said ${String(childUsage.used)}/${String(childUsage.size)})` : ''}; settings ${settingsAre}${childConfig ? ` (a child said ${String(values(childConfig.configOptions))})` : ''}`
      summary[`${capture}/${label}`] = {
        lines: scenario.lines.length,
        announced: scenario.announced.size,
        subStreams: hosted.length,
        diagnostics,
        hostLines: lines.map((l) => `${String(l.title)}: ${String(l.state)}`),
        hostGeneric: generic,
        hostViewUntouched: stable,
        children,
      }
      console.log(`${capture}/${label}: ${String(scenario.lines.length)} lines, announced ${String(scenario.announced.size)}, sub-streams ${String(hosted.length)}, refused ${JSON.stringify(diagnostics)}, host: ${stable}, children ${JSON.stringify(children.map((c) => [c.depth, c.subagent, c.turns.join('+'), c.elements]))}`)
      await lab.command(ws, 'Stop', { execution: e.id })
    }
  }
  writeFileSync(join(DIR, '..', 'replay-summary.json'), JSON.stringify(summary, null, 1))
})

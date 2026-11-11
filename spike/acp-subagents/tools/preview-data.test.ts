// Spike only: the preview's data, made from the captured lines by Agora's real log and projector.
// Each thread is a Lab Workstream (the real writer, the real bridge, the mock agent writing captured lines
// byte for byte with `/raw`), folded by the core projector into the rows the client reads; the replay's own
// traces are then put back to what was captured: the prompt's text, the harness's name. The tree's states
// are read from the captured `subagent_update`s at a given moment.
//   cd packages/log && node test/run.ts ../../spike/acp-subagents/tools/preview-data.test.ts
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { CoreProjection, type Entry } from '../../../packages/log/src/index.ts'
import { base64, opened, type Lab } from '../../../packages/log/test/support.ts'
import type { ThreadRow } from '../../../apps/web/src/agora/objects.ts'

const ROOT = new URL('../', import.meta.url)
const OUT = new URL('preview/src/data/', ROOT)
type M = Record<string, any>
interface Rec { seq: number; t: number; dir: 'in' | 'out'; label: string; line: string }
const load = (capture: string): Rec[] => readFileSync(new URL(`captures/${capture}.jsonl`, ROOT), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec)

/** The scenario's prompt and every received line of its session tree after it, with the tree. */
function scenario(recs: Rec[], label: string) {
  const prompt = recs.find((r) => r.label.split('#')[0] === label && r.dir === 'out' && JSON.parse(r.line).method === 'session/prompt')!
  const pm = JSON.parse(prompt.line) as M
  const parent = String(pm.params.sessionId)
  const parentOf = new Map<string, string>()
  const lines: { t: number; seq: number; m: M }[] = []
  for (const r of recs) {
    if (r.dir !== 'in' || r.seq <= prompt.seq) continue
    const m = JSON.parse(r.line) as M
    const s = String(m.params?.sessionId)
    const u = m.params?.update
    const inTree = s === parent || parentOf.has(s)
    if (u?.sessionUpdate === 'subagent_update' && inTree && !parentOf.has(u.sessionId)) parentOf.set(String(u.sessionId), s)
    if (typeof m.method === 'string' && inTree) lines.push({ t: r.t - prompt.t, seq: r.seq, m })
  }
  return { parent, prompt: String(pm.params.prompt[0].text), lines, parentOf }
}

const rowsOf = (entries: readonly Entry[]): ThreadRow[] => {
  const projection = new CoreProjection()
  const rows: ThreadRow[] = []
  let position = 0n
  for (const entry of entries)
    for (const id of projection.apply([entry])) {
      const o = projection.objects.get(id)!
      rows.push({ type: 'live', position: String(++position), operation: 'upsert', kind: o.kind, id, object: o.object as Record<string, unknown> })
    }
  return rows
}

/** The lines of one session (`own`), as the mock's own session, through the Lab; the rows folded from them. */
async function thread(lab: Lab, lines: M[], own: string): Promise<ThreadRow[]> {
  const ws = await lab.workstream()
  const e = await lab.open(ws)
  let n = 0
  const raw = lines.map((m) => {
    const copy = structuredClone(m)
    if (copy.params?.sessionId === own) copy.params.sessionId = e.acpId
    for (const k of ['senderSessionId', 'recipientSessionId'] as const) if (copy.params?.update?.[k] === own) copy.params.update[k] = e.acpId
    if ('id' in copy) copy.id = `spike-${String(++n)}`
    return JSON.stringify(copy)
  })
  const answer = await lab.write(ws, `/raw ${base64(...raw)}`)
  if (!answer.accepted) throw new Error(`Write refused: ${String(answer.reason)}`)
  await lab.turn(ws, ['done', 'failed', 'cancelled'], 60_000)
  const entries = await lab.entries(ws)
  await lab.command(ws, 'Stop', { execution: e.id })
  // Each object's last row only: the client keeps the last upsert of each, so the final state is the same.
  const rows = rowsOf(entries)
  const last = new Map(rows.map((r, i) => [`${r.kind} ${String(r.id)}`, i]))
  return rows.filter((r, i) => last.get(`${r.kind} ${String(r.id)}`) === i)
}

/** The replay's traces put back: the prompt's text (or a task `from` a parent), the harness's name, no mock. */
function restore(rows: ThreadRow[], harness: string, user: { text: string; from?: string } | null): ThreadRow[] {
  return rows.flatMap((row) => {
    const o = row.object as M
    if (row.kind === 'element' && o.type === 'user') {
      if (user === null) return []
      return [{ ...row, object: { ...o, content: [{ type: 'text', text: user.text }], ...(user.from ? { from: user.from } : {}) } }]
    }
    // A child's thread opens on no Session of its own: no notice.
    if (row.kind === 'notice') return user === null || user.from ? [] : [{ ...row, object: { ...o, harness } }]
    if (row.kind === 'workstream') return [{ ...row, object: { ...o, harness, pool: null } }]
    if (row.kind === 'turn' && o.harness) return [{ ...row, object: { ...o, harness } }]
    return [row]
  })
}

const stateAt = (lines: { t: number; m: M }[], child: string, t: number) => {
  let state: M | null = null
  let capabilities: M | null = null
  let title = '', description = ''
  for (const x of lines) {
    const u = x.m.params?.update
    if (x.t > t || u?.sessionUpdate !== 'subagent_update' || u.sessionId !== child) continue
    if ('state' in u) state = u.state
    if ('capabilities' in u) capabilities = u.capabilities
    if (typeof u.title === 'string') title = u.title
    if (typeof u.description === 'string') description = u.description
  }
  return { state, capabilities, title, description }
}

const titleOf = (recs: Rec[], session: string): string => {
  let title = ''
  for (const r of recs) {
    const m = JSON.parse(r.line) as M
    const u = m.params?.update
    if (m.params?.sessionId === session && u?.sessionUpdate === 'session_info_update' && typeof u.title === 'string') title = u.title
  }
  return title
}

test('the preview data, from the captured lines', { timeout: 600_000 }, async (t) => {
  const { lab } = await opened(t, { workstreams: { maxActive: 100 } })
  mkdirSync(OUT, { recursive: true })
  const claudeCaps = load('claude-caps'), claudeBase = load('claude-baseline'), claudeCaps2 = load('claude-caps-2'), codexCaps = load('codex-caps')

  // ---- The parent's thread, Claude Code, "one sub-agent it waits for": today, declared, and with a child line.
  const today = scenario(claudeBase, 'a-one-waited')
  const declared = scenario(claudeCaps, 'a-one-waited')
  const own = declared.lines.filter((x) => x.m.params.sessionId === declared.parent)
  const children = [...declared.parentOf.keys()].map((id) => {
    const at = declared.lines.find((x) => x.m.params?.update?.sessionUpdate === 'subagent_update' && x.m.params.update.sessionId === id)!
    // Where its line goes: after the parent's parts that came before its announcement.
    const before = new Set(own.filter((x) => x.seq < at.seq && ['agent_message_chunk', 'tool_call'].includes(x.m.params.update?.sessionUpdate)).map((x) => x.m.params.update.messageId ?? x.m.params.update.toolCallId))
    return { id, ...stateAt(declared.lines, id, Infinity), partsBefore: before.size, announcedAt: at.t }
  })
  const threads = {
    today: { prompt: today.prompt, lines: today.lines.length, rows: restore(await thread(lab, today.lines.map((x) => x.m), today.parent), 'claude-code', { text: today.prompt }) },
    declared: { prompt: declared.prompt, lines: declared.lines.length, rows: restore(await thread(lab, declared.lines.map((x) => x.m), declared.parent), 'claude-code', { text: declared.prompt }) },
    proposed: { prompt: declared.prompt, lines: own.length, rows: restore(await thread(lab, own.map((x) => x.m), declared.parent), 'claude-code', { text: declared.prompt }), children },
    childClaude: null as unknown,
    childCodex: null as unknown,
  }

  // ---- A child's own thread: Claude Code's while it runs (before its cancel), Codex's once it is idle.
  const f2 = scenario(claudeCaps2, 'f2-cancel-child')
  const claudeChild = [...f2.parentOf.keys()][0]!
  const cancelAt = claudeCaps2.find((r) => r.dir === 'out' && JSON.parse(r.line).method === 'session/cancel')!
  const promptAt = claudeCaps2.find((r) => r.label.startsWith('f2-') && r.dir === 'out' && JSON.parse(r.line).method === 'session/prompt')!
  const cut = cancelAt.t - promptAt.t - 1
  const claudeOwn = f2.lines.filter((x) => x.m.params.sessionId === claudeChild && x.t <= cut)
  const task = claudeOwn.find((x) => x.m.params.update?.sessionUpdate === 'session_message')?.m.params.update
  threads.childClaude = {
    id: claudeChild,
    parentTitle: titleOf(claudeCaps2, f2.parent),
    at: cut,
    ...stateAt(f2.lines, claudeChild, cut),
    task: task ? (task.content as M[]).map((b) => b.text).join('') : null,
    lines: claudeOwn.length,
    rows: restore(await thread(lab, claudeOwn.filter((x) => x.m.params.update?.sessionUpdate !== 'session_message').map((x) => x.m), claudeChild), 'claude-code', { text: task ? (task.content as M[]).map((b) => b.text).join('') : '', from: 'parent' }),
  }
  const ca = scenario(codexCaps, 'a-one-waited')
  const codexChild = [...ca.parentOf.keys()][0]!
  const codexOwn = ca.lines.filter((x) => x.m.params.sessionId === codexChild)
  threads.childCodex = {
    id: codexChild,
    parentTitle: titleOf(codexCaps, ca.parent),
    at: codexOwn.at(-1)!.t,
    ...stateAt(ca.lines, codexChild, Infinity),
    task: null,
    lines: codexOwn.length,
    rows: restore(await thread(lab, codexOwn.map((x) => x.m), codexChild), 'codex', null),
  }
  writeFileSync(new URL('threads.json', OUT), JSON.stringify(threads))

  // ---- The tree: three captured parents at a moment each, their children's states then.
  const moment = (recs: Rec[], capture: string, label: string, at: number) => {
    const s = scenario(recs, label)
    return {
      capture,
      label,
      at,
      title: titleOf(recs, s.parent),
      children: [...s.parentOf.entries()].map(([id, parent]) => ({ id, parent: parent === s.parent ? null : parent, ...stateAt(s.lines, id, at) })).filter((c) => c.state !== null || c.title !== ''),
    }
  }
  const d = scenario(claudeCaps, 'd-nested')
  const dAt = d.lines.find((x) => x.m.params?.update?.sessionUpdate === 'subagent_update' && x.m.params.update.title === 'Compute 7 times 8')!.t + 1
  const e = scenario(claudeCaps, 'e-permission')
  const eAt = e.lines.find((x) => x.m.params?.update?.state?.state === 'requires_action')!.t + 1
  const b = scenario(codexCaps, 'b-two-parallel')
  const bAt = b.lines.filter((x) => x.m.params?.update?.state?.state === 'idle')[0]!.t + 1
  const tree = [moment(claudeCaps, 'claude-caps', 'd-nested', dAt), moment(claudeCaps, 'claude-caps', 'e-permission', eAt), moment(codexCaps, 'codex-caps', 'b-two-parallel', bAt)]
  writeFileSync(new URL('tree.json', OUT), JSON.stringify(tree, null, 1))
  console.log(JSON.stringify({ tree: tree.map((x) => ({ title: x.title, at: x.at, children: x.children.map((c) => `${c.title}:${JSON.stringify(c.state)}`) })), children, claude: { cut, lines: claudeOwn.length }, codex: codexOwn.length }, null, 1))
})

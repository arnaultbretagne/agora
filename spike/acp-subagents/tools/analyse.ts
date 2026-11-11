// Spike only: what the captured lines hold, per scenario. For each child: the fields of its
// `subagent_update`s, its states in order, the update kinds under its own session id, the participants
// of its session messages; the volume of each child against its parent; and Agora's own validator
// (packages/log/src/acp.ts) on every line, correlated as the log correlates it.
//   node analyse.ts <capture.jsonl> [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { validate } from '../../../packages/log/src/acp.ts'

interface Rec { seq: number; t: number; dir: 'in' | 'out'; label: string; line: string }
const [file, flag, jsonOut] = process.argv.slice(2) as [string, string?, string?]
const recs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec)
type M = Record<string, any>
const parsed = recs.map((r) => ({ ...r, m: JSON.parse(r.line) as M, bytes: Buffer.byteLength(r.line) }))

// ---- Agora's validator, every line, correlated by id as the store does.
const requests = new Map<string, { method: string; direction: 'in' | 'out' }>()
const verdicts: Record<string, number> = {}
const refused: { seq: number; dir: string; reason: string; kind: string }[] = []
const extensions: Record<string, number> = {}
for (const r of parsed) {
  const m = r.m
  const isRequest = typeof m.method === 'string' && 'id' in m
  const key = `${r.dir}:${JSON.stringify(m.id)}`
  if (isRequest) requests.set(key, { method: m.method, direction: r.dir })
  const correlated = !('method' in m) && 'id' in m ? requests.get(`${r.dir === 'in' ? 'out' : 'in'}:${JSON.stringify(m.id)}`) : undefined
  const v = validate(r.line, r.dir, correlated)
  const kind = m.params?.update?.sessionUpdate ?? m.method ?? correlated?.method ?? '?'
  if (v.ok) {
    verdicts.ok = (verdicts.ok ?? 0) + 1
    if (v.envelope.extension) extensions[kind] = (extensions[kind] ?? 0) + 1
  } else {
    verdicts[v.reason] = (verdicts[v.reason] ?? 0) + 1
    refused.push({ seq: r.seq, dir: r.dir, reason: v.reason, kind })
  }
}

// ---- The tree, from the announcements.
const parentOf = new Map<string, string>()
for (const r of parsed) {
  const u = r.m.params?.update
  if (u?.sessionUpdate === 'subagent_update' && typeof u.sessionId === 'string' && !parentOf.has(u.sessionId)) parentOf.set(u.sessionId, r.m.params.sessionId)
}
const roots = new Map<string, string>() // session → its scenario label (the parents opened by the client)
for (const r of parsed) {
  const res = r.m.result
  if (r.dir === 'in' && typeof res?.sessionId === 'string') roots.set(res.sessionId, r.label.split('#')[0]!)
}
for (const r of parsed) if (r.dir === 'out' && ['session/resume', 'session/load'].includes(r.m.method)) roots.set(r.m.params.sessionId, r.label.split('#')[0]!)
const rootOf = (s: string): string => {
  let x = s
  for (let i = 0; i < 10 && parentOf.has(x); i++) x = parentOf.get(x)!
  return x
}
const sessionOfLine = (m: M): string | null => (typeof m.params?.sessionId === 'string' ? m.params.sessionId : null)

interface Child {
  id: string
  parent: string
  depth: number
  announcedAt: number
  fieldsFirst: string[]
  fieldsAll: string[]
  title?: string
  description?: string
  capabilities: unknown[]
  cwd: unknown[]
  states: { t: number; state: unknown }[]
  ownKinds: Record<string, number>
  ownLines: number
  ownBytes: number
  parentStreamLines: number
  parentStreamBytes: number
  permissions: { t: number; sessionId: string; toolCall?: string }[]
  messages: { where: string; dir: string; fields: string[]; text: string }[]
  toolSessionRefs: number
  firstOwnLineAt: number | null
  firstOwnKind: string | null
}
const children = new Map<string, Child>()
for (const [id, parent] of parentOf) {
  let depth = 1
  for (let x = parent; parentOf.has(x); x = parentOf.get(x)!) depth++
  children.set(id, { id, parent, depth, announcedAt: -1, fieldsFirst: [], fieldsAll: [], capabilities: [], cwd: [], states: [], ownKinds: {}, ownLines: 0, ownBytes: 0, parentStreamLines: 0, parentStreamBytes: 0, permissions: [], messages: [], toolSessionRefs: 0, firstOwnLineAt: null, firstOwnKind: null })
}
const perScenario = new Map<string, { parentLines: number; parentBytes: number; childLines: number; childBytes: number; announceLines: number; announceBytes: number; total: number; totalBytes: number }>()
const textOf = (c: unknown): string => (Array.isArray(c) ? c : [c]).map((b: any) => (b?.type === 'text' ? String(b.text) : `[${String(b?.type)}]`)).join('')
for (const r of parsed) {
  const m = r.m
  const s = sessionOfLine(m)
  const u = m.params?.update
  const scenario = r.label.split('#')[0]!
  const v = perScenario.get(scenario) ?? { parentLines: 0, parentBytes: 0, childLines: 0, childBytes: 0, announceLines: 0, announceBytes: 0, total: 0, totalBytes: 0 }
  perScenario.set(scenario, v)
  v.total++
  v.totalBytes += r.bytes
  if (u?.sessionUpdate === 'subagent_update') {
    const c = children.get(u.sessionId)!
    const keys = Object.keys(u).filter((k) => k !== 'sessionUpdate')
    if (c.announcedAt < 0) {
      c.announcedAt = r.t
      c.fieldsFirst = keys
    }
    for (const k of keys) if (!c.fieldsAll.includes(k)) c.fieldsAll.push(k)
    if ('title' in u) c.title = u.title
    if ('description' in u) c.description = u.description
    if ('capabilities' in u) c.capabilities.push(u.capabilities)
    if ('cwd' in u) c.cwd.push(u.cwd)
    if ('state' in u) c.states.push({ t: r.t, state: u.state })
    c.parentStreamLines++
    c.parentStreamBytes += r.bytes
    v.announceLines++
    v.announceBytes += r.bytes
    continue
  }
  if (s !== null && children.has(s)) {
    const c = children.get(s)!
    const kind = u?.sessionUpdate ?? m.method
    c.ownKinds[kind] = (c.ownKinds[kind] ?? 0) + 1
    c.ownLines++
    c.ownBytes += r.bytes
    if (c.firstOwnLineAt === null) {
      c.firstOwnLineAt = r.t
      c.firstOwnKind = kind
    }
    if (m.method === 'session/request_permission') c.permissions.push({ t: r.t, sessionId: s, toolCall: m.params?.toolCall?.toolCallId })
    v.childLines++
    v.childBytes += r.bytes
  } else {
    v.parentLines++
    v.parentBytes += r.bytes
  }
  if (u?.sessionUpdate === 'session_message' || u?.sessionUpdate === 'session_message_chunk') {
    const owner = children.get(u.recipientSessionId) ?? children.get(u.senderSessionId) ?? (s && children.get(s))
    if (owner) owner.messages.push({ where: s === owner.id ? 'child stream' : 'parent stream', dir: u.sessionUpdate, fields: Object.keys(u).filter((k) => !['sessionUpdate', 'content'].includes(k)), text: textOf(u.content).slice(0, 160) })
  }
  if ((u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') && Array.isArray(u.content))
    for (const b of u.content) if (b?.type === 'session' && children.has(b.sessionId)) children.get(b.sessionId)!.toolSessionRefs++
}

// ---- What the parent's stream holds without children: the tool lines that launch them.
const launches: { scenario: string; t: number; session: string; kind: string; name: unknown; title: unknown; status: unknown; meta: unknown }[] = []
for (const r of parsed) {
  const u = r.m.params?.update
  if (!u || !['tool_call', 'tool_call_update'].includes(u.sessionUpdate)) continue
  const name = u._meta?.claudeCode?.toolName ?? u.name ?? u.kind
  if (!/agent|task|spawn|wait|collab|send_input|close/i.test(`${String(name)} ${String(u.title ?? '')}`)) continue
  launches.push({ scenario: r.label.split('#')[0]!, t: r.t, session: String(r.m.params.sessionId), kind: u.sessionUpdate, name, title: u.title, status: u.status, meta: u._meta ? Object.keys(u._meta) : null })
}

const report = {
  file,
  lines: parsed.length,
  bytes: parsed.reduce((a, r) => a + r.bytes, 0),
  validator: { verdicts, refused, extensions },
  children: [...children.values()].map((c) => ({ ...c, root: roots.get(rootOf(c.id)) ?? rootOf(c.id) })),
  perScenario: Object.fromEntries(perScenario),
  launches,
}
if (flag === '--json' && jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1))

console.log(`${file}: ${String(report.lines)} lines, ${String(report.bytes)} bytes`)
console.log(`validator: ${JSON.stringify(verdicts)}; taken as extensions: ${JSON.stringify(extensions)}`)
for (const x of refused.slice(0, 12)) console.log(`  refused #${String(x.seq)} ${x.dir} ${x.kind}: ${x.reason}`)
for (const c of report.children) {
  console.log(`\n[${c.root}] child ${c.id} (depth ${String(c.depth)}, parent ${c.parent === rootOf(c.id) ? 'root' : c.parent})`)
  console.log(`  first subagent_update fields: ${c.fieldsFirst.join(', ')}; all: ${c.fieldsAll.join(', ')}`)
  console.log(`  title ${JSON.stringify(c.title)} description ${JSON.stringify(c.description)} capabilities ${JSON.stringify(c.capabilities)} cwd ${JSON.stringify(c.cwd)}`)
  console.log(`  states: ${c.states.map((s) => `${String(s.t)}ms ${JSON.stringify(s.state)}`).join(' → ')}`)
  console.log(`  announced at ${String(c.announcedAt)}ms; its first own line at ${String(c.firstOwnLineAt)}ms (${String(c.firstOwnKind)})`)
  console.log(`  own stream: ${String(c.ownLines)} lines, ${String(c.ownBytes)} bytes: ${JSON.stringify(c.ownKinds)}; on the parent's stream: ${String(c.parentStreamLines)} subagent_update lines, ${String(c.parentStreamBytes)} bytes; tool content session refs: ${String(c.toolSessionRefs)}`)
  for (const msg of c.messages) console.log(`  ${msg.dir} on the ${msg.where}: fields ${msg.fields.join(', ')} — ${JSON.stringify(msg.text)}`)
  for (const p of c.permissions) console.log(`  permission at ${String(p.t)}ms under ${p.sessionId}`)
}
console.log('\nper scenario (lines/bytes): parent stream | children own | subagent_update on parent')
for (const [k, v] of perScenario) console.log(`  ${k}: ${String(v.parentLines)}/${String(v.parentBytes)} | ${String(v.childLines)}/${String(v.childBytes)} | ${String(v.announceLines)}/${String(v.announceBytes)} (total ${String(v.total)}/${String(v.totalBytes)})`)
console.log('\nlaunch/wait tool lines:')
for (const l of launches) console.log(`  [${l.scenario}] ${String(l.t)}ms ${l.session.slice(0, 12)} ${l.kind} name=${String(l.name)} title=${JSON.stringify(l.title)} status=${String(l.status)}`)

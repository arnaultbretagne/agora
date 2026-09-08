// Where the time goes, over a REAL conversation of several turns (S13).
//
// One message and one answer proves nothing about a product people talk to: the costs that matter
// — the admission sweep re-run per message, a bridge connection per turn, a projection that lands
// only when the turn ends — are per-turn costs, and the third turn is where a conversation first
// breaks. This measures every step of every turn and prints them as a table.
//
//   CONTROL_PLANE_URL=http://… OWNER=you@example.com WORKSTREAM=<id> TURNS=5 node scripts/measure-turns.mjs
//
// With no WORKSTREAM it creates one, powers it on and waits for convergence first — those numbers
// are reported separately, because start-up is not what a conversation pays per message.
const base = process.env.CONTROL_PLANE_URL ?? 'http://control-plane.agora-system.svc.cluster.local:8080'
const owner = process.env.OWNER ?? 'operator@example.com'
const turns = Number(process.env.TURNS ?? 5)
const harness = process.env.HARNESS ?? 'claude-code'
const model = process.env.MODEL ?? 'haiku'
const effort = process.env.EFFORT ?? 'default'
const capability = process.env.CAPABILITY ?? 'provider.anthropic'
const headers = { 'x-forwarded-email': owner, 'content-type': 'application/json' }

const api = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await res.text()
  try {
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  } catch {
    return { status: res.status, body: text }
  }
}
const items = async (id) => (await api(`/v1/workstreams/${id}/items`)).body?.items ?? []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let workstreamId = process.env.WORKSTREAM
let startup = null
if (workstreamId === undefined) {
  const run = Date.now().toString(36)
  const t0 = Date.now()
  workstreamId = (await api('/v1/workstreams', { method: 'POST', headers: { 'idempotency-key': `m-${run}` }, body: JSON.stringify({ title: `mesure ${run}` }) })).body?.id
  await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `m-on-${run}` }, body: JSON.stringify({ power: 'on', harness, model, effort, capabilities: [capability], persona: 'default' }) })
  for (;;) {
    if ((await api(`/v1/workstreams/${workstreamId}/intent`)).body?.work === null) break
    if (Date.now() - t0 > 900_000) throw new Error('never converged')
    await sleep(1000)
  }
  startup = Date.now() - t0
}
console.log(`Workstream ${workstreamId}${startup === null ? ' (déjà chaud)' : ` — démarrage à froid ${String(startup)} ms`}\n`)

const rows = []
for (let turn = 1; turn <= turns; turn += 1) {
  const word = `T${String(turn)}X${String(Math.floor(Math.random() * 10000))}`
  const before = new Set((await items(workstreamId)).map((item) => item.id))
  const t0 = Date.now()
  const posted = await api(`/v1/workstreams/${workstreamId}/prompt`, { method: 'POST', headers: { 'idempotency-key': `m-${word}` }, body: JSON.stringify({ text: `Réponds exactement: ${word}` }) })
  const tAccepted = Date.now()
  if (posted.status !== 202) {
    rows.push({ turn, accepted: tAccepted - t0, question: null, answer: null, refus: `${String(posted.status)} ${String(posted.body?.title ?? '')}` })
    break
  }
  let question = null
  let answer = null
  for (;;) {
    const fresh = (await items(workstreamId)).filter((item) => !before.has(item.id) && item.kind === 'message')
    if (question === null && fresh.some((item) => item.value?.role === 'user')) question = Date.now() - t0
    if (fresh.some((item) => item.value?.role === 'agent' && (item.value.content ?? []).map((block) => block.text ?? '').join('').includes(word))) {
      answer = Date.now() - t0
      break
    }
    if (Date.now() - t0 > 240_000) break
    await sleep(100)
  }
  rows.push({ turn, accepted: tAccepted - t0, question, answer, refus: null })
  console.log(`tour ${String(turn)}: accepté ${String(tAccepted - t0)} ms · question visible ${question === null ? '—' : `${String(question)} ms`} · réponse ${answer === null ? '—' : `${String(answer)} ms`}`)
}

console.log('\n| tour | POST accepté | question visible | réponse complète |')
console.log('|---|---|---|---|')
for (const row of rows) {
  console.log(`| ${String(row.turn)} | ${String(row.accepted)} ms | ${row.refus ?? (row.question === null ? 'jamais' : `${String(row.question)} ms`)} | ${row.refus ? '' : row.answer === null ? 'jamais' : `${String(row.answer)} ms`} |`)
}
const done = rows.filter((row) => row.answer !== null)
if (done.length > 0) {
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
  console.log(`\nmédiane: accepté ${String(median(done.map((r) => r.accepted)))} ms · question ${String(median(done.map((r) => r.question)))} ms · réponse ${String(median(done.map((r) => r.answer)))} ms`)
}
console.log(`\n${String(done.length)}/${String(rows.length)} tours complets`)
if (done.length !== rows.length) process.exit(1)

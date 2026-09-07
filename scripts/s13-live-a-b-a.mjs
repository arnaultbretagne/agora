// A → B → A, against the live deployment (S10's last open item, closed in S13).
//
// `scripts/s10-a-b-a.mjs` proves the same story with real adapters but a stubbed Kubernetes and a
// stubbed OneCLI. This one changes nothing but the surroundings: it speaks only the product API, so
// every Pod, credential, gateway hop and Save round-trip is the real one.
//
//   A  = claude-code: plant a codeword, then power off — a Save is captured and A's Anchor advances
//   B  = codex:       the Intent switches harness. B has no Anchor of its own, so it opens a FRESH
//                     native context — and still knows the codeword, because the Workstream's record
//                     follows the Workstream: SYNC finds the range unincorporated and REFILL hands it
//                     over. That is the distinction this proves. The record is the Workstream's; the
//                     native context is the harness's, and A's Anchor is not touched.
//   A' = claude-code: the Intent switches back; A's own Anchor is found, its native context resumed
//                     (the SAME context id), and the codeword is still there.
//
//   CONTROL_PLANE_URL=http://10.98.22.96:8080 OWNER=you@example.com node scripts/s13-live-a-b-a.mjs
//
// It spends four real model calls across two real Pods, deliberately, and leaves the Workstream off.
import { setTimeout as sleep } from 'node:timers/promises'

const base = process.env.CONTROL_PLANE_URL ?? 'http://control-plane.agora-system.svc.cluster.local:8080'
const owner = process.env.OWNER ?? 'operator@example.com'
const A = { harness: process.env.HARNESS_A ?? 'claude-code', model: process.env.MODEL_A ?? 'sonnet', effort: 'default', capability: 'provider.anthropic' }
const B = { harness: process.env.HARNESS_B ?? 'codex', model: process.env.MODEL_B ?? 'gpt-5.6-sol', effort: 'medium', capability: 'provider.openai' }
const convergenceBudgetMs = Number(process.env.CONVERGENCE_BUDGET_MS ?? 600_000)
const promptBudgetMs = Number(process.env.PROMPT_BUDGET_MS ?? 300_000)
const codeword = `PERIGORD-${Math.floor(Math.random() * 100000)}`
const run = Date.now().toString(36)

const steps = []
function record(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'x-forwarded-email': owner, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  return { status: res.status, body }
}

async function until(what, check, budgetMs = 300_000, everyMs = 5_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${String(budgetMs)}ms`)
    await sleep(everyMs)
  }
}

const intent = (side, power) => ({ power, harness: side.harness, model: side.model, effort: side.effort, capabilities: [side.capability], persona: 'default' })

const workstreamId = (await api('/v1/workstreams', { method: 'POST', headers: { 'idempotency-key': `aba-${run}` }, body: JSON.stringify({ title: `S13 live A→B→A ${run}` }) })).body?.id
if (typeof workstreamId !== 'string') {
  console.log('FAIL  a Workstream is created')
  process.exit(1)
}
console.log(`Workstream ${workstreamId}`)

/** Powers the Workstream onto one side and waits for the engine to say there is nothing left to do. */
async function switchTo(side, key) {
  await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': key }, body: JSON.stringify(intent(side, 'on')) })
  await until(`${side.harness} converges`, async () => (await api(`/v1/workstreams/${workstreamId}/intent`)).body?.work === null, convergenceBudgetMs)
  const sessions = await api(`/v1/workstreams/${workstreamId}/sessions`)
  return sessions.body?.sessions?.find((session) => session.attributionEndedAt === null)
}

/**
 * Asks, and returns only what THIS session answered after the ask. The Workstream's items outlive
 * every Session in it — including the prompt whose own text carries the codeword — so reading them
 * all would answer with the question rather than with the model.
 */
async function ask(session, text, key) {
  const before = ((await api(`/v1/workstreams/${workstreamId}/items`)).body?.items ?? []).map((item) => item.id)
  const seen = new Set(before)
  await api(`/v1/workstreams/${workstreamId}/prompt`, { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ text }) })
  return await until(
    'the model answers',
    async () => {
      const items = (await api(`/v1/workstreams/${workstreamId}/items`)).body?.items ?? []
      const fresh = items.filter((item) => !seen.has(item.id) && item.sessionId === session.id && item.kind === 'message' && item.value?.role === 'agent')
      const answer = fresh.map((item) => (item.value.content ?? []).map((block) => block.text ?? '').join('')).join('\n')
      return answer.length > 0 ? answer : false
    },
    promptBudgetMs,
  )
}

async function powerOff(key) {
  await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': key }, body: JSON.stringify(intent(A, 'off')) })
  return await until('a Save is anchored', async () => (await api(`/v1/workstreams/${workstreamId}/sessions`)).body?.lossExposure?.[0]?.saveId)
}

let a1
try {
  a1 = await switchTo(A, `aba-a1-${run}`)
  record(`A (${A.harness}) is live with a bound context`, typeof a1?.contextId === 'string', a1?.contextId)
} catch (error) {
  record(`A (${A.harness}) is live with a bound context`, false, String(error))
  process.exit(1)
}

try {
  const planted = await ask(a1, `Remember this codeword for later: ${codeword}. Reply with just the word OK.`, `aba-plant-${run}`)
  record('A takes a codeword', planted.length > 0, planted.slice(0, 80).replaceAll('\n', ' '))
} catch {
  record('A takes a codeword', false, 'no answer')
  process.exit(1)
}

try {
  const save = await powerOff(`aba-off1-${run}`)
  record("powering A off captures a Save and advances A's Anchor", true, `save ${String(save)}`)
} catch {
  record("powering A off captures a Save and advances A's Anchor", false, 'no Anchor appeared')
}

let b
try {
  b = await switchTo(B, `aba-b-${run}`)
  record(`B (${B.harness}) starts on its own fresh context`, typeof b?.contextId === 'string' && b.contextId !== a1.contextId && b.restoredFromSaveId === null, `${String(a1.contextId)} → ${String(b?.contextId)}`)
} catch (error) {
  record(`B (${B.harness}) starts on its own fresh context`, false, String(error))
}

if (b !== undefined) {
  try {
    const answer = await ask(b, 'What codeword was I given earlier in this workstream? Reply with exactly that word and nothing else.', `aba-askb-${run}`)
    // Not A's context — A's RECORD, handed over by REFILL. B never touched A's native state.
    record('B receives the record through a Handoff, on its own context', answer.includes(codeword), answer.slice(0, 80).replaceAll('\n', ' '))
  } catch {
    record('B receives the record through a Handoff, on its own context', false, 'no answer')
  }
  // B goes down on its own terms before A is asked for again: the point of the next step is that A
  // finds ITS anchor, not that the engine happened to be mid-replacement.
  await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `aba-off2-${run}` }, body: JSON.stringify(intent(B, 'off')) })
  await until('B powers down', async () => (await api(`/v1/workstreams/${workstreamId}/intent`)).body?.work === null, convergenceBudgetMs)
}

try {
  const a2 = await switchTo(A, `aba-a2-${run}`)
  record("A comes back on its OWN Anchor, not B's", a2?.restoredFromSaveId !== null && a2?.contextId === a1.contextId, `${String(a1.contextId)} → ${String(a2?.contextId)}`)
  const answer = await ask(a2, 'What codeword did I ask you to remember? Reply with exactly that word and nothing else.', `aba-aska-${run}`)
  record('A still knows the codeword', answer.includes(codeword), answer.slice(0, 80).replaceAll('\n', ' '))
} catch (error) {
  record("A comes back on its OWN Anchor, not B's", false, String(error))
  record('A still knows the codeword', false, 'A did not come back')
}

await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `aba-off3-${run}` }, body: JSON.stringify(intent(A, 'off')) })

const failed = steps.filter((step) => !step.ok)
console.log(`\n${String(steps.length - failed.length)}/${String(steps.length)} steps passed for Workstream ${workstreamId}`)
if (failed.length > 0) {
  console.log(`failed: ${failed.map((step) => step.name).join('; ')}`)
  process.exit(1)
}

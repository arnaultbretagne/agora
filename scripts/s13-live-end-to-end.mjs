// The live end-to-end check (S13). One command, run against a real deployment, that walks the whole
// product story and says which step failed rather than "it does not work":
//
//   1. the catalogue serves reviewed values          6. a prompt is answered BY THE MODEL
//   2. a Workstream is created                       7. power off captures a Save and publishes an Anchor
//   3. a complete Intent is authored                 8. power on restores from it
//   4. it reconciles to convergence                  9. the new Session resumes the SAME native context
//   5. a Session exists with a bound ACP context
//
// Step 6 is the one that needs a provider account attached in OneCLI: the gateway refuses a
// credential that has no app connection, for every agent including its own default, and says so in
// the transcript. Every other step is independent of it, which is why this script reports per step.
//
//   CONTROL_PLANE_URL=http://10.98.22.96:8080 OWNER=you@example.com node scripts/s13-live-end-to-end.mjs
//
// It leaves the Workstream powered off. Nothing here is a unit test: it spends real model calls and
// creates a real Pod, deliberately.
import { setTimeout as sleep } from 'node:timers/promises'

const base = process.env.CONTROL_PLANE_URL ?? 'http://control-plane.agora-system.svc.cluster.local:8080'
const owner = process.env.OWNER ?? 'operator@example.com'
const harness = process.env.HARNESS ?? 'claude-code'
const model = process.env.MODEL ?? 'sonnet'
const effort = process.env.EFFORT ?? 'default'
const capability = process.env.CAPABILITY ?? 'provider.anthropic'
// Budgets, because the two harnesses are not equally fast to come up: claude-code converges in
// well under a minute, codex spends ~20s inside its own adapter initialise on top of the image
// pull and the Handoff seed. A budget that fits the fast one reports the slow one as broken, which
// is a lie about the system rather than a measurement of it.
const convergenceBudgetMs = Number(process.env.CONVERGENCE_BUDGET_MS ?? 600_000)
const promptBudgetMs = Number(process.env.PROMPT_BUDGET_MS ?? 300_000)
const codeword = `MIRABELLE-${Math.floor(Math.random() * 100000)}`
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

const intent = (power) => ({ power, harness, model, effort, capabilities: [capability], persona: 'default' })

/** Polls until `check` returns a truthy value, or gives up — never longer than the caller allows. */
async function until(what, check, budgetMs = 300_000, everyMs = 5_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${String(budgetMs)}ms`)
    await sleep(everyMs)
  }
}

const catalogue = await api('/v1/catalogue')
record('the catalogue serves reviewed values', catalogue.status === 200 && Array.isArray(catalogue.body?.harnesses), `revision ${String(catalogue.body?.revisionId)}`)

const created = await api('/v1/workstreams', { method: 'POST', headers: { 'idempotency-key': `e2e-${run}` }, body: JSON.stringify({ title: `S13 live end-to-end ${run}` }) })
const workstreamId = created.body?.id
record('a Workstream is created', typeof workstreamId === 'string', workstreamId)
if (typeof workstreamId !== 'string') process.exit(1)

const authored = await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `e2e-on-${run}` }, body: JSON.stringify(intent('on')) })
record('a complete Intent is authored', authored.status === 200 || authored.status === 201, `intentSeq ${String(authored.body?.intentSeq)}`)

try {
  // `work: null` is the engine saying there is nothing left to do for this Workstream. It is not a
  // promise about the future — a new Intent or a drifting observation puts work back — which is why
  // every later step re-reads rather than trusting this one.
  await until('the Workstream converges', async () => (await api(`/v1/workstreams/${workstreamId}/intent`)).body?.work === null, convergenceBudgetMs)
  record('it reconciles to convergence', true, 'work: null')
} catch (error) {
  const view = await api(`/v1/workstreams/${workstreamId}/intent`)
  record('it reconciles to convergence', false, `blocking cause: ${String(view.body?.work?.blockingCause)}`)
}

const sessions = await api(`/v1/workstreams/${workstreamId}/sessions`)
const live = sessions.body?.sessions?.find((session) => session.attributionEndedAt === null)
record('a Session exists with a bound ACP context', typeof live?.contextId === 'string', live?.contextId)

const prompted = await api(`/v1/workstreams/${workstreamId}/prompt`, {
  method: 'POST',
  headers: { 'idempotency-key': `e2e-prompt-${run}` },
  body: JSON.stringify({ text: `Answer with exactly one short sentence and include this word verbatim: ${codeword}` }),
})
let answer = ''
try {
  answer = await until(
    'the model answers',
    async () => {
      const items = await api(`/v1/workstreams/${workstreamId}/items`)
      const messages = (items.body?.items ?? []).filter((item) => item.kind === 'message' && item.value?.role === 'agent')
      const text = messages.map((m) => (m.value.content ?? []).map((b) => b.text ?? '').join('')).join('\n')
      return text.length > 0 ? text : false
    },
    promptBudgetMs,
  )
} catch {
  answer = ''
}
record(
  'a prompt is answered BY THE MODEL',
  answer.includes(codeword),
  answer === '' ? `no answer (prompt ${String(prompted.body?.commandId)})` : answer.slice(0, 160).replaceAll('\n', ' '),
)

await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `e2e-off-${run}` }, body: JSON.stringify(intent('off')) })
let anchored
try {
  anchored = await until('a Save is anchored', async () => {
    const view = await api(`/v1/workstreams/${workstreamId}/sessions`)
    return view.body?.lossExposure?.[0]?.saveId
  })
  record('power off captures a Save and publishes an Anchor', true, `save ${String(anchored)}`)
} catch {
  record('power off captures a Save and publishes an Anchor', false, 'no Anchor appeared')
}

await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `e2e-on2-${run}` }, body: JSON.stringify(intent('on')) })
try {
  const restored = await until('a Session is restored', async () => {
    const view = await api(`/v1/workstreams/${workstreamId}/sessions`)
    return view.body?.sessions?.find((session) => session.attributionEndedAt === null && session.restoredFromSaveId !== null)
  })
  record('power on restores from it', true, `from save ${String(restored.restoredFromSaveId)}`)
  record(
    'the new Session resumes the SAME native context',
    restored.contextId === live?.contextId,
    `${String(live?.contextId)} → ${String(restored.contextId)}`,
  )
} catch {
  record('power on restores from it', false, 'no restored Session appeared')
  record('the new Session resumes the SAME native context', false, 'no restored Session to compare')
}

await api(`/v1/workstreams/${workstreamId}/intent`, { method: 'PUT', headers: { 'idempotency-key': `e2e-off2-${run}` }, body: JSON.stringify(intent('off')) })

const failed = steps.filter((step) => !step.ok)
console.log(`\n${String(steps.length - failed.length)}/${String(steps.length)} steps passed for Workstream ${workstreamId}`)
if (failed.length > 0) {
  console.log(`failed: ${failed.map((step) => step.name).join('; ')}`)
  process.exit(1)
}

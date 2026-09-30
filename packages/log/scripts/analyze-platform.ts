// Offline analysis of preserved timestamps and CPU work. No database, Kubernetes or LLM calls.
import { readFile, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { fold } from '../src/state.ts'
import { core } from '../src/projection.ts'
import { decode, hash, object } from '../src/json.ts'
import type { Entry } from '../src/store.ts'

const fixture = decode(await readFile(new URL('../test/fixtures/claude-code.json', import.meta.url), 'utf8')) as { entries: Entry[] }
const entries = fixture.entries
function required(entry: Entry | undefined): Entry {
  if (!entry) throw new Error('fixture_boundary_missing')
  return entry
}
function difference(a: Entry, b: Entry): number {
  return Date.parse(b.time) - Date.parse(a.time)
}
function response(request: Entry): Entry {
  return required(entries.find((e) => e.direction === 'in' && e.request_position === request.position && e.rpc_kind === 'response'))
}
function sent(request: Entry): Entry {
  return required(entries.find((e) => e.kind === 'acp.sent' && e.content.requestPosition === request.position))
}
function stats(values: number[]) {
  values.sort((a, b) => a - b)
  const round = (v: number) => Math.round(v * 1000) / 1000
  return { samples: values.length, p50Ms: round(values[Math.ceil(values.length * 0.5) - 1]!),
    p95Ms: round(values[Math.ceil(values.length * 0.95) - 1]!) }
}
const create = required(entries.find((e) => e.kind === 'command' && e.content.kind === 'Create'))
const connected = required(entries.find((e) => e.kind === 'execution.connected'))
const initialize = required(entries.find((e) => e.direction === 'out' && e.method === 'initialize'))
const opening = required(entries.find((e) => e.direction === 'out' && e.method === 'session/new'))
const turns = entries.filter((e) => e.direction === 'out' && e.method === 'session/prompt').map((request, index) => {
  const command = required(entries.find((e) => e.kind === 'command' && e.command === request.command))
  const end = response(request), write = sent(request)
  const thoughts = entries.filter((e) => BigInt(e.position) > BigInt(request.position) && BigInt(e.position) < BigInt(end.position) &&
    object(object(e.content.params)?.update)?.sessionUpdate === 'agent_thought_chunk')
  const gaps = thoughts.slice(1).map((e, i) => difference(thoughts[i]!, e))
  return { turn: index + 1, requestPosition: request.position, responsePosition: end.position,
    commandToSentMs: difference(command, write), sentToResponseMs: difference(write, end),
    thoughtChunks: thoughts.length,
    thoughtCharacters: thoughts.reduce((sum, e) => sum + String(object(object(object(e.content.params)?.update)?.content)?.text ?? '').length, 0),
    thoughtGap: gaps.length ? stats(gaps) : null }
})
const cpu = [20, 55, 105].map((length) => {
  const source = entries.slice(0, length)
  const actions = {
    canonicalFold: () => fold(source),
    projectionFoldAndHash: () => hash(core.fold(source).sort((a, b) => a.id.localeCompare(b.id))),
  }
  const measured: Record<string, ReturnType<typeof stats>> = {}
  for (const [name, run] of Object.entries(actions)) {
    for (let i = 0; i < 20; i++) run()
    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      const before = performance.now()
      run()
      samples.push(performance.now() - before)
    }
    measured[name] = stats(samples)
  }
  return { entries: source.length, ...measured }
})
const report = {
  scope: {
    timestamps: 'PostgreSQL transaction-start times (now()); not commit, socket receipt or browser delivery. Sent-to-response mixes adapter/LLM/tools with receive backpressure.',
    cpu: 'Offline fold/hash only; no SQL, transport, Kubernetes, gateway or LLM. 20 warmups and 200 samples per action/prefix.',
  },
  host: { node: process.version, arch: process.arch, cpu: cpus()[0]?.model },
  timestampIntervals: {
    createToConnectedMs: difference(create, connected), initializeRequestToResponseMs: difference(initialize, response(initialize)),
    openingRequestToResponseMs: difference(opening, response(opening)), openingSentToResponseMs: difference(sent(opening), response(opening)),
    turns,
  }, cpu,
}
const encoded = JSON.stringify(report, null, 2) + '\n'
if (process.argv[2]) await writeFile(process.argv[2], encoded)
else process.stdout.write(encoded)

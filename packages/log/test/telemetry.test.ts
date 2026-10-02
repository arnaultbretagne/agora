// docs/specs/log.md, "Operational logs": a closed list of fields, and never a prompt, tool content,
// credential, token, header, query string, anchor byte or exception message.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { parseBundle } from '@agora/harness-bridge/anchor'
import { LogStore, object, telemetry } from '../src/index.ts'
import { base64, cluster, database, hold, Server, until, waiting } from './support.ts'

const secret = (what: string) => `${what}-${randomBytes(9).toString('base64url')}`

/** Every 8-character piece of each secret: none may appear. */
function leaks(output: string, secrets: readonly string[]): string[] {
  return secrets.flatMap((s) => Array.from({ length: s.length - 7 }, (_, i) => s.slice(i, i + 8))).filter((piece) => output.includes(piece))
}

test('L28 the logger, fed secrets in every field and as keys, emits none of them nor a fragment', () => {
  const secrets = ['prompt', 'tool', 'token', 'header', 'query', 'anchor', 'exception'].map(secret)
  const [prompt, tool, token, header, query, anchor, exception] = secrets as [string, string, string, string, string, string, string]
  const hostile: unknown[] = [prompt, new Error(exception), { tool }, [token], Buffer.from(anchor), `?q=${query}`, { authorization: `Bearer ${header}` }]
  const keys = ['actor', 'workstream', 'session', 'execution', 'connection', 'command', 'position', 'operation', 'outcome', 'errorClass', 'bytes', 'durationMs', 'prompt', 'error', 'headers', 'url', 'token', 'message', 'reason', 'stage']
  const output: string[] = []
  for (const value of hostile) {
    telemetry(Object.fromEntries(keys.map((key) => [key, value])), (line) => output.push(line))
    telemetry(Object.fromEntries(secrets.map((s) => [s, value])), (line) => output.push(line))
  }
  telemetry({ operation: prompt, outcome: tool, errorClass: exception, position: `1${token}`, bytes: Number.NaN }, (line) => output.push(line))
  assert.deepEqual(leaks(output.join('\n'), secrets), [])
  // Control: what may be logged is.
  const workstream = randomUUID()
  telemetry({ workstream, operation: 'capture', outcome: 'blocked', errorClass: 'database', position: '9007199254740993', bytes: 12, prompt }, (line) => output.push(line))
  assert.deepEqual(JSON.parse(output.at(-1)!), { workstream, position: '9007199254740993', operation: 'capture', outcome: 'blocked', errorClass: 'database', bytes: 12 })
})

test('L28 the lab process, carrying secrets through prompts, tools, tokens, headers, queries, anchors and failures, logs none of them', async (t) => {
  const db = await database()
  const c = await cluster()
  const reader = new LogStore(db.urls)
  const server = await Server.start({ db, api: c.api, keys: c.keys })
  c.kube.anchorUrl = server.anchorUrl
  t.after(async () => {
    await server.stop('SIGKILL')
    await c.close()
    await reader.close()
    await db.drop()
  })
  const [prompt, tool, token, header, query, body] = ['prompt', 'tool', 'token', 'header', 'query', 'body'].map(secret) as [string, string, string, string, string, string]
  const ws = randomUUID()
  assert.equal((await server.post('/api/workstreams', { id: ws, owner: randomUUID() })).status, 200)
  assert.equal((await server.command(ws, 'Create', {}, { pool: 'mock-test' })).status, 200)
  const e = await until('Session open', async () => {
    const current = (await reader.state(ws)).current
    return current?.session && current.connection ? { ...current } : null
  })
  const write = async (text: string) => {
    const answer = await server.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text }] })
    assert.equal(answer.status, 200)
    await until('the turn ends', async () => [...(await reader.state(ws)).turns.values()].every((x) => ['done', 'failed', 'cancelled'].includes(x.status)) || null)
  }
  // A prompt, and tool content the harness sends back.
  await write(`remember ${prompt}`)
  const toolLine = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${String(e.acpId)}","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"${tool}","content":[{"type":"content","content":{"type":"text","text":"${tool}"}}]}}}`
  await write(`/raw ${base64(toolLine)}`)
  // A token and a header on the API, a query string, a malformed body.
  await fetch(`${server.url}/api/workstreams/${ws}/thread?after=0&${query}=1`, { headers: { authorization: `Bearer ${token}`, 'x-secret': header }, signal: AbortSignal.timeout(1000) })
    .then((r) => r.body?.cancel())
    .catch(() => undefined)
  await fetch(`${server.url}/api/workstreams/${ws}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"id":"${body}"` })
  await fetch(server.anchorUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
  // A database failure in the middle of a turn: its exception message must stay inside.
  const answer = await server.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text: '/sleep 2' }] })
  assert.equal(answer.status, 200)
  const release = await hold(db, ws)
  try {
    const pids = await until('a capture waiting', () => waiting(db, 'writer').then((p) => p.length > 0 && p))
    await db.admin.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids])
  } finally {
    await release()
  }
  await until('the turn ends', async () => [...(await reader.state(ws)).turns.values()].every((x) => ['done', 'failed', 'cancelled'].includes(x.status)) || null)
  // The anchor, whose native files hold the prompt.
  c.kube.expireAt(e.claimName, new Date())
  await until('anchor.received', async () => (await reader.entries(ws)).some((x) => x.kind === 'anchor.received'))
  const [stored] = await reader.anchorList()
  const files = parseBundle(new Uint8Array((await reader.anchorBytes(stored!.id))!.content)).files
  assert.ok(files.some((file) => Buffer.from(file.content, 'base64').toString().includes(prompt)))
  await server.stop('SIGTERM')
  assert.deepEqual(leaks(server.output, [prompt, tool, token, header, query, body, ...files.map((file) => file.content)]), [])
  for (const message of ['terminating connection', 'administrator command', 'Connection terminated']) assert.ok(!server.output.includes(message), message)
  // Control: the logger did run along the way.
  const logged = server.output.split('\n').filter((l) => l.startsWith('{')).map((l) => object(JSON.parse(l)) ?? {})
  assert.ok(logged.some((l) => l.operation === 'admission' && l.outcome === 'accepted'))
  assert.ok(logged.some((l) => l.errorClass === 'database'))
  t.diagnostic(`${String(logged.length)} log lines checked; no fragment of the 6 secrets nor of the anchor's files`)
})

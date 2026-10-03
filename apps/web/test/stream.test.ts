// docs/specs/assistant-ui.md, U7 and U8: the client's reading of the thread and its commands, against a
// stub server that plays the thread's rules (snapshot, snapshot-end, live rows) and cuts on purpose.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Api } from '../src/agora/api.ts'
import { empty, type ThreadState } from '../src/agora/objects.ts'
import { ThreadStream, type Connection } from '../src/agora/stream.ts'

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}
const send = (res: ServerResponse, row: unknown) => res.write(`data: ${JSON.stringify(row)}\n\n`)
const until = async <T>(what: string, find: () => T | undefined | false): Promise<T> => {
  for (let i = 0; i < 400; i++) {
    const found = find()
    if (found) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out: ${what}`)
}

test('U8 the stream cut, then back: opened again from the last cursor, nothing skipped or applied twice', async (t) => {
  const afters: string[] = []
  const stub = await serve((req, res) => {
    const after = new URL(req.url!, 'http://x').searchParams.get('after')!
    afters.push(after)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (afters.length === 1) {
      send(res, { type: 'snapshot', position: '1', operation: 'upsert', kind: 'workstream', id: 'w', object: { state: 'ready' } })
      send(res, { type: 'snapshot', position: '2', operation: 'upsert', kind: 'turn', id: 't1', object: { status: 'in_progress' } })
      send(res, { type: 'snapshot-end', position: '2' })
      // A row split across two writes, and a number beyond 2^53.
      const row = '{"type":"live","position":"3","operation":"upsert","kind":"element","id":"e1","object":{"type":"tool","n":9007199254740993}}'
      res.write(`data: ${row.slice(0, 20)}`)
      setTimeout(() => {
        res.write(`${row.slice(20)}\n\n`)
        setTimeout(() => res.destroy(), 20)
      }, 20)
    } else {
      send(res, { type: 'snapshot-end', position: '3' })
      // Already applied: changes nothing.
      send(res, { type: 'live', position: '3', operation: 'upsert', kind: 'element', id: 'e1', object: { type: 'tool', n: 'replayed' } })
      send(res, { type: 'live', position: '4', operation: 'upsert', kind: 'turn', id: 't1', object: { status: 'done' } })
    }
  })
  t.after(stub.close)
  const seen: { state: ThreadState; connection: Connection }[] = []
  const stream = new ThreadStream(empty, {
    url: (cursor) => `${stub.url}/api/workstreams/w/thread?after=${cursor}`,
    onChange: (state, connection) => seen.push({ state, connection }),
    delays: [10],
  })
  stream.start()
  t.after(() => stream.stop())
  const final = await until('both reads', () => seen.find((s) => s.state.cursor === '4')?.state)
  assert.deepEqual(afters, ['0', '3'])
  assert.equal(final.objects.get('t1')!.object.status, 'done')
  assert.equal(final.objects.get('e1')!.object.n, '9007199254740993')
  assert.equal(final.objects.size, 3)
  // Commands wait: complete only once each read's snapshot has ended.
  assert.equal(seen[0]!.state.complete, false)
  const reopened = seen.findIndex((s) => s.connection === 'offline')
  assert.ok(reopened > 0 && seen[reopened + 1]!.state.complete === false)
  assert.ok(seen.some((s) => s.connection === 'connected'))
})

test('U7 a command refused: its reason, the objects untouched; one lost on the network: sent again with the same id', async (t) => {
  const ids: string[] = []
  let calls = 0
  const stub = await serve((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const command = JSON.parse(body) as { id: string; kind: string }
      ids.push(command.id)
      calls++
      if (command.kind === 'Write') return void res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: false, reason: 'turn_active' }))
      // The first Stop never gets an answer back.
      if (calls === 2) return void res.destroy()
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true }))
    })
  })
  t.after(stub.close)
  const api = new Api(stub.url)
  const state = empty
  const refused = await api.command('w', 'Write', { execution: 'e', session: 's' }, { prompt: [{ type: 'text', text: 'too early' }] })
  assert.deepEqual(refused, { accepted: false, reason: 'turn_active' })
  assert.equal(state.objects.size, 0)
  const stopped = await api.command('w', 'Stop', { execution: 'e' }, {})
  assert.deepEqual(stopped, { accepted: true })
  assert.equal(ids.length, 3)
  assert.equal(ids[1], ids[2], 'the retry carries the same id')
  assert.notEqual(ids[0], ids[1])
})

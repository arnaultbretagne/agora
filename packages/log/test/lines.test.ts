// docs/specs/log.md, "ACP lines" and "Validation": what a received line becomes. The lines come from
// the mock agent's `/raw`, through a real bridge, byte for byte.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { isLosslessNumber } from 'lossless-json'
import { canonical, decode, identity, object } from '../src/index.ts'
import { base64, call, database, Lab, lines, opened, readThread, until } from './support.ts'

test('L1 a received line keeps its exact integer, unknown members, _meta and array order', async (t) => {
  const { lab, ws, e } = await opened(t)
  const line = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${e.acpId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"exact"}},"_meta":{"n":9007199254740993,"order":["b","a","c"],"unknown":{"z":[3,1,2]}}}}`
  await lab.write(ws, `/raw ${base64(line)}`)
  await lab.turn(ws, 'done')
  const [entry] = lines(await lab.entries(ws), 'in', 'session/update')
  assert.ok(entry)
  const stored = await lab.store.writer.query('SELECT content::text AS text FROM entries WHERE workstream=$1 AND position=$2', [ws, entry.position])
  const text = String(stored.rows[0].text)
  assert.match(text, /"n": 9007199254740993\b/)
  assert.equal(canonical(decode(text)), canonical(decode(line)))
  const meta = object(object(decode(text))?.params)?._meta as Record<string, unknown>
  assert.deepEqual(meta.order, ['b', 'a', 'c'])
  assert.deepEqual((object(meta.unknown)?.z as unknown[]).map(String), ['3', '1', '2'])
  assert.ok(isLosslessNumber(meta.n) && meta.n.value === '9007199254740993')
})

test('L2 two identical received lines are two entries, at two positions, with two receive ordinals', async (t) => {
  const { lab, ws, e } = await opened(t)
  const line = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${e.acpId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"twice"}}}}`
  await lab.write(ws, `/raw ${base64(line, line)}`)
  await lab.turn(ws, 'done')
  const twice = lines(await lab.entries(ws), 'in', 'session/update').filter((x) => object(object(object(x.content.params)?.update)?.content)?.text === 'twice')
  assert.equal(twice.length, 2)
  assert.notEqual(twice[0]!.position, twice[1]!.position)
  assert.equal(twice[0]!.connection, twice[1]!.connection)
  assert.equal(BigInt(twice[1]!.receive_ordinal!), BigInt(twice[0]!.receive_ordinal!) + 1n)
  assert.equal(canonical(twice[0]!.content), canonical(twice[1]!.content))
})

test('L3 invalid received lines leave a diagnostic each, no content, no entry, nothing handled', async (t) => {
  const { lab, ws, e } = await opened(t)
  const invalid: [string, Buffer][] = [
    ['batch', Buffer.from(`[{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${e.acpId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"batch"}}}}]`)],
    ['wrong_direction', Buffer.from(`{"jsonrpc":"2.0","id":"wrong-1","method":"session/prompt","params":{"sessionId":"${e.acpId}","prompt":[]}}`)],
    ['unsafe_id', Buffer.from(`{"jsonrpc":"2.0","id":9007199254740993,"method":"fs/read_text_file","params":{"sessionId":"${e.acpId}","path":"/etc/hostname"}}`)],
    ['invalid_utf8', Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"_lab/ping","params":{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}')])],
    ['invalid_json', Buffer.from('{"jsonrpc":"2.0","method":"_lab/ping"} {"jsonrpc":"2.0","method":"_lab/ping"}')],
    ['unsupported_json_value', Buffer.from('{"jsonrpc":"2.0","jsonrpc":"2.0","method":"_lab/ping"}')],
    ['unsupported_json_value', Buffer.from('{"jsonrpc":"2.0","method":"_lab/ping","params":{"__proto__":{"polluted":true}}}')],
    ['unsupported_json_value', Buffer.from('{"jsonrpc":"2.0","method":"_lab/ping","params":{"a":"\\u0000"}}')],
  ]
  const before = (await lab.entries(ws)).length
  await lab.write(ws, `/raw ${base64(...invalid.map(([, bytes]) => bytes))}`)
  const turn = await lab.turn(ws, 'done')
  const after = (await lab.entries(ws)).slice(before)
  // The only received line of the turn is its answer.
  assert.deepEqual(
    lines(after, 'in').map((x) => x.correlated_method),
    ['session/prompt'],
  )
  assert.equal(turn.stopReason, 'end_turn')
  assert.deepEqual(lines(after, 'out').map((x) => x.method), ['session/prompt'])
  assert.equal(after.filter((x) => x.kind === 'request.failed').length, 0)
  const diagnostics = await lab.store.writer.query(
    'SELECT execution,connection,receive_ordinal,direction,reason,size,sha256 FROM diagnostics WHERE workstream=$1 ORDER BY receive_ordinal',
    [ws],
  )
  assert.deepEqual(
    diagnostics.rows.map((r) => r.reason),
    invalid.map(([reason]) => reason),
  )
  for (const [index, row] of diagnostics.rows.entries()) {
    const bytes = invalid[index]![1]
    assert.equal(row.execution, e.id)
    assert.equal(row.direction, 'in')
    assert.equal(Number(row.size), bytes.byteLength)
    assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
  const ordinals = diagnostics.rows.map((r) => BigInt(r.receive_ordinal as string))
  assert.deepEqual(ordinals, ordinals.map((_, i) => ordinals[0]! + BigInt(i)))
  const columns = await lab.store.writer.query("SELECT column_name FROM information_schema.columns WHERE table_name='diagnostics' ORDER BY column_name")
  assert.deepEqual(
    columns.rows.map((r) => r.column_name),
    ['connection', 'direction', 'execution', 'id', 'reason', 'receive_ordinal', 'sha256', 'size', 'time', 'workstream'],
  )
  // Nothing projected from them.
  const objects = await lab.workstreams.projections.objects(ws)
  assert.equal(objects.filter((o) => o.object.type === 'acp').length, 0)
})

test('L5 an extension method and an unknown session/update type are entries and generic elements', async (t) => {
  const { lab, ws, e } = await opened(t)
  const extension = '{"jsonrpc":"2.0","method":"_lab/ping","params":{"seq":1}}'
  const unknown = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${e.acpId}","update":{"sessionUpdate":"lab_widget","items":[2,1]}}}`
  await lab.write(ws, `/raw ${base64(extension, unknown)}`)
  await lab.turn(ws, 'done')
  const received = lines(await lab.entries(ws), 'in').filter((x) => x.rpc_kind === 'notification')
  const ping = received.find((x) => x.method === '_lab/ping')
  const widget = received.find((x) => object(object(x.content.params)?.update)?.sessionUpdate === 'lab_widget')
  assert.ok(ping && widget)
  // Received lines are projected a moment later, a few times a second.
  const read = await until('both projected', async () => {
    const r = await readThread(lab.url, ws, '0')
    return [ping, widget].every((x) => r.snapshot.some((row) => row.id === identity(ws, x.position, 'generic'))) && r
  })
  assert.equal(read.status, 200)
  for (const entry of [ping, widget]) {
    const id = identity(ws, entry.position, 'generic')
    const row = read.snapshot.find((r) => r.id === id)
    assert.ok(row, `generic element for position ${entry.position}`)
    assert.equal(object(row.object)?.type, 'acp')
    assert.equal(canonical(object(row.object)?.line), canonical(entry.content))
  }
})

test('L26 positions and cursors beyond 2^53 - 1 keep exact arithmetic, order, request ids and reads', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const ws = await lab.workstream()
  // Forced state: the Workstream and its thread start beyond 2^53.
  const start = 9007199254740993n
  await db.admin.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [ws, String(start)])
  await db.admin.query('INSERT INTO threads(workstream,last_position) VALUES($1,$2)', [ws, String(start)])
  await lab.open(ws)
  const answer = await lab.write(ws, 'beyond')
  assert.ok(answer.accepted)
  await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  assert.deepEqual(
    entries.map((x) => BigInt(x.position)),
    entries.map((_, i) => start + 1n + BigInt(i)),
  )
  const ordered = await lab.store.writer.query('SELECT position FROM entries WHERE workstream=$1 ORDER BY position', [ws])
  assert.deepEqual(ordered.rows.map((r) => r.position), entries.map((x) => x.position))
  const prompt = lines(entries, 'out', 'session/prompt')[0]!
  assert.equal(prompt.rpc_id, `agora-${prompt.execution!}-${prompt.position}`)
  assert.equal(BigInt(prompt.position), BigInt(answer.position) + 1n)
  assert.equal(answer.requestId, prompt.rpc_id)
  // The thread is projected after the log, a moment later: read it once the projection's checkpoint
  // has reached the last entry read above.
  const last = BigInt(entries.at(-1)!.position)
  await until('the thread caught up with the log', async () =>
    (await db.admin.query('SELECT position FROM checkpoints WHERE workstream=$1', [ws])).rows.some((r) => BigInt(r.position) >= last),
  )
  const all = await readThread(lab.url, ws, String(start))
  assert.equal(all.status, 200)
  assert.ok(all.end !== null && BigInt(all.end) > start)
  assert.ok(all.snapshot.every((r) => BigInt(r.position) > start && BigInt(r.position) <= BigInt(all.end!)))
  const none = await readThread(lab.url, ws, all.end!)
  assert.deepEqual([none.snapshot.length, none.end], [0, all.end])
  const beyond = await readThread(lab.url, ws, String(BigInt(all.end!) + 1n))
  assert.deepEqual([beyond.status, beyond.body?.reason], [400, 'future_cursor'])
  const negative = await call(lab.url, 'GET', `/api/workstreams/${ws}/thread?after=-1`)
  assert.deepEqual([negative.status, negative.body.reason], [400, 'invalid_cursor'])
})

// docs/specs/files.md: a file's bytes are stored once, in R2, under their SHA-256; the entries hold references.
// Real bridges with the mock agent, whose `/file` returns an image as Claude Code's `Read` does; R2 is the
// testkit's S3 endpoint (simulated: stub), with the answers measured on the real bucket, and stopping it
// refuses connections for real.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { FakeS3 } from '@agora/testkit'
import { mockFile } from '@agora/mock-agent/file'
import { canonical, decode, encode, expandFiles, Files, FILE_MIN, FILES_LOCK, findFiles, object, reference, type Entry } from '../src/index.ts'
import { moveFiles } from '../src/move.ts'
import { base64, call, database, expire, lines, opened, until } from './support.ts'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const key = (s: string): string => `sha256/${s}`

/** A bucket of the test's own: its counts and its sweep see nobody else's objects. */
async function fresh(t: { after(fn: () => Promise<void>): void }): Promise<FakeS3> {
  const s3 = await new FakeS3().start()
  t.after(() => s3.stop())
  return s3
}

/** The entry of a received tool update that holds files. */
const withFiles = (entries: readonly Entry[]): Entry[] => lines(entries, 'in', 'session/update').filter((x) => (x.files?.length ?? 0) > 0)

/** The value at a JSON Pointer. */
function at(value: unknown, path: string): unknown {
  return path
    .split('/')
    .slice(1)
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')], value)
}

test('B1 a received tool update carrying a 4 MiB image: one object, references where it was, the line given back whole', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws } = await opened(t, { s3 })
  await lab.write(ws, '/file 4194304 1')
  await lab.turn(ws, 'done')
  const bytes = mockFile(4194304, 1)
  const digest = sha(bytes)
  const [entry] = withFiles(await lab.entries(ws))
  assert.ok(entry)
  assert.deepEqual(entry.files, [
    { path: '/params/update/content/0/content/data', sha256: digest, size: 4194304 },
    { path: '/params/update/rawOutput/0/source/data', sha256: digest, size: 4194304 },
  ])
  for (const ref of entry.files!) assert.equal(at(entry.content, ref.path), reference(digest))
  assert.deepEqual([...s3.objects.keys()], [key(digest)])
  assert.ok(s3.objects.get(key(digest))!.bytes.equals(bytes))
  assert.equal(s3.count('PutObject'), 1)
  const rows = await lab.store.writer.query('SELECT sha256, size FROM files')
  assert.deepEqual(rows.rows.map((r) => [r.sha256, Number(r.size)]), [[digest, 4194304]])
  // Expanded, it is the line received: the image at both places, every other member as it was.
  const expanded = await lab.store.expand(entry)
  for (const ref of entry.files!) assert.equal(at(expanded, ref.path), bytes.toString('base64'))
  assert.equal(canonical(findFiles(expanded)!.value), canonical(entry.content))
  // The thread holds the reference, not the bytes.
  const tool = await lab.store.projector.query("SELECT object::text AS o FROM objects WHERE workstream=$1 AND type='tool'", [ws])
  assert.equal(tool.rowCount, 1)
  assert.ok(String(tool.rows[0].o).includes(reference(digest)))
  assert.ok(String(tool.rows[0].o).length < 10_000, `the tool's view is ${String(String(tool.rows[0].o).length)} characters`)
  t.diagnostic(`files ${JSON.stringify(entry.files)}; objects ${JSON.stringify([...s3.objects.keys()])}; PutObject ${String(s3.count('PutObject'))}; the tool's view ${String(String(tool.rows[0].o).length)} characters`)
})

test('B2 the same image in two Workstreams, then once its row is gone: one object, stored once, found again with a 412', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws } = await opened(t, { s3 })
  const other = await lab.workstream()
  await lab.open(other)
  const digest = sha(mockFile(200_000, 2))
  await lab.write(ws, '/file 200000 2')
  await lab.turn(ws, 'done')
  await lab.write(other, '/file 200000 2')
  await lab.turn(other, 'done')
  assert.equal(s3.count('PutObject'), 1, 'the second line uploads nothing: its row is there')
  // A database that no longer has the row (restored from before it): the upload finds the object there.
  await lab.store.anchors.query('DELETE FROM files')
  await lab.write(ws, '/file 200000 2')
  await lab.turn(ws, 'done')
  assert.equal(s3.count('PutObject', 200), 1)
  assert.equal(s3.count('PutObject', 412), 1)
  assert.deepEqual([...s3.objects.keys()], [key(digest)])
  const rows = await lab.store.writer.query('SELECT sha256 FROM files')
  assert.deepEqual(rows.rows.map((r) => r.sha256), [digest])
  const referencing = [...withFiles(await lab.entries(ws)), ...withFiles(await lab.entries(other))]
  assert.equal(referencing.length, 3)
  for (const e of referencing) assert.deepEqual(new Set(e.files!.map((f) => f.sha256)), new Set([digest]))
  t.diagnostic(`PutObject: ${JSON.stringify(s3.requests.filter((r) => r.operation === 'PutObject').map((r) => r.status))}; objects ${String(s3.objects.size)}; rows ${String(rows.rowCount)}; referencing entries ${String(referencing.length)}`)
})

test('B3 base64 too short, base64 with line breaks, a reference written by a person: left as they are', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws, e } = await opened(t, { s3 })
  const short = mockFile(49_149, 3).toString('base64')
  assert.equal(short.length, 65_532)
  const wrapped = mockFile(786_432, 4).toString('base64').replace(/(.{76})/g, '$1\n')
  const line = (text: string) => `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${e.acpId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":${JSON.stringify(text)}}}}}`
  await lab.write(ws, `/raw ${base64(line(short), line(wrapped))}`)
  await lab.turn(ws, 'done')
  const received = lines(await lab.entries(ws), 'in', 'session/update').filter((x) => {
    const text = object(object(object(x.content.params)?.update)?.content)?.text
    return text === short || text === wrapped
  })
  assert.equal(received.length, 2)
  for (const x of received) assert.equal(x.files, null)
  // An existing file's reference, typed by a person: never expanded.
  await lab.write(ws, '/file 100000 5')
  await lab.turn(ws, 'done')
  const looks = reference(sha(mockFile(100_000, 5)))
  await lab.write(ws, looks)
  await lab.turn(ws, 'done')
  const prompt = lines(await lab.entries(ws), 'out', 'session/prompt').filter((x) => x.rpc_kind === 'request').at(-1)!
  assert.equal(prompt.files, null)
  assert.deepEqual((prompt.content.params as { prompt: unknown[] }).prompt, [{ type: 'text', text: looks }])
  const sent = (await lab.entries(ws)).find((x) => x.kind === 'acp.sent' && x.content.requestPosition === prompt.position)
  assert.ok(sent, 'the line went to the harness as written')
  t.diagnostic(`files of the two long chunks: ${JSON.stringify(received.map((x) => x.files))}; the person's line: ${JSON.stringify((prompt.content.params as { prompt: unknown[] }).prompt)}, files ${JSON.stringify(prompt.files)}, sent at ${String(sent.position)}`)
  assert.equal(s3.count('PutObject'), 1)
})

test('B4 a Write with a 500 KB JPEG: references in the command and the line, the bytes at the agent', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws, e } = await opened(t, { s3 })
  const bytes = mockFile(512_000, 6)
  const data = bytes.toString('base64')
  const answer = await lab.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/jpeg', data, uri: 'photo.jpg' }] })
  assert.ok(answer.accepted, `Write refused: ${String((answer as { reason?: string }).reason)}`)
  await lab.turn(ws, 'done')
  const entries = await lab.entries(ws)
  const command = entries.find((x) => x.kind === 'command' && x.command === answer.command)!
  const prompt = lines(entries, 'out', 'session/prompt').find((x) => x.command === answer.command && x.rpc_kind === 'request')!
  assert.deepEqual(command.files, [{ path: '/body/prompt/1/data', sha256: sha(bytes), size: 512_000 }])
  assert.deepEqual(prompt.files, [{ path: '/params/prompt/1/data', sha256: sha(bytes), size: 512_000 }])
  assert.equal(at(prompt.content, '/params/prompt/1/data'), reference(sha(bytes)))
  assert.equal(s3.count('PutObject'), 1)
  // What the agent received: those very bytes.
  const said = lines(entries, 'in', 'session/update')
    .map((x) => String(object(object(object(x.content.params)?.update)?.content)?.text ?? ''))
    .join('')
  assert.match(said, new RegExp(`Received an image, image/jpeg, 512000 bytes, sha256 ${sha(bytes).slice(0, 12)}\\.`))
  t.diagnostic(`command files ${JSON.stringify(command.files)}; line files ${JSON.stringify(prompt.files)}; the agent: ${said.split('\n')[0]}`)
  assert.equal(canonical(object((await lab.store.expand(prompt)).params)?.prompt), canonical([{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/jpeg', data, uri: 'photo.jpg' }]))
})

test('B5 R2 unreachable: a Write with a file refused, received lines held, then written in order once R2 is back', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws, e } = await opened(t, { s3 })
  await s3.stop()
  const before = (await lab.entries(ws)).length
  const refused = await lab.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'image', mimeType: 'image/png', data: mockFile(100_000, 7).toString('base64'), uri: 'a.png' }] })
  assert.deepEqual(refused, { accepted: false, reason: 'files_unavailable' })
  assert.equal((await lab.entries(ws)).length, before, 'no command entry')
  const viaHttp = await call(lab.url, 'POST', `/api/workstreams/${ws}/commands`, {
    id: randomUUID(),
    kind: 'Write',
    target: { execution: e.id, session: e.session },
    body: { prompt: [{ type: 'image', mimeType: 'image/png', data: mockFile(100_000, 7).toString('base64'), uri: 'a.png' }] },
  })
  assert.deepEqual([viaHttp.status, viaHttp.body.reason], [503, 'files_unavailable'])
  // The agent's line with a file waits, and the one after it too.
  await lab.write(ws, '/file 300000 8')
  await until('the capture held', () => lab.logs.some((l) => l.includes('"operation":"capture"') && l.includes('"errorClass":"files"')))
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(withFiles(await lab.entries(ws)).length, 0)
  await s3.start()
  await lab.turn(ws, 'done')
  const after = (await lab.entries(ws)).filter((x) => x.kind === 'acp' && x.direction === 'in' && x.execution === e.id)
  const updates = after.filter((x) => x.method === 'session/update')
  const tool = updates.findIndex((x) => (x.files?.length ?? 0) > 0)
  const read = updates.findIndex((x) => object(object(object(x.content.params)?.update)?.content)?.text === 'File read.')
  assert.ok(tool >= 0 && read > tool, 'the tool line, then the line after it')
  const ordinals = after.map((x) => BigInt(x.receive_ordinal!))
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => (a < b ? -1 : 1)))
  assert.equal(new Set(ordinals.map(String)).size, ordinals.length, 'each line once')
  const diagnostics = await lab.store.writer.query('SELECT count(*)::int AS n FROM diagnostics WHERE workstream=$1', [ws])
  assert.equal(diagnostics.rows[0].n, 0)
  t.diagnostic(`refused ${JSON.stringify(refused)}, over HTTP ${String(viaHttp.status)} ${String(viaHttp.body.reason)}; once R2 back: tool line at ${String(tool)}, 'File read.' at ${String(read)} of ${String(updates.length)} updates, ordinals ${ordinals.map(String).join(',')}`)
})

test('B6 a Pod pushes its anchor; a later Create restores it from R2', async (t) => {
  const s3 = await fresh(t)
  const c = await opened(t, { s3, receiver: true })
  await c.lab.write(c.ws, 'groseille')
  await c.lab.turn(c.ws, 'done')
  await expire(c.lab.kube, c.e.claimName)
  const ended = await until('execution.ended', async () => (await c.lab.entries(c.ws)).find((x) => x.kind === 'execution.ended' && x.execution === c.e.id))
  const anchor = String(ended.content.anchor)
  const record = await c.lab.store.anchors.query('SELECT file, content FROM anchors WHERE id=$1', [anchor])
  assert.equal(record.rows[0].content, null, 'the record holds no bytes')
  const file = String(record.rows[0].file)
  const object_ = s3.objects.get(key(file))
  assert.ok(object_, 'the anchor is an object')
  assert.equal(sha(object_.bytes), file)
  assert.equal(object(decode(object_.bytes.toString('utf8')))?.format, 'agora-anchor/1')
  const answer = await c.lab.command(c.ws, 'Create', {}, { pool: 'mock-test' })
  assert.ok(answer.accepted)
  await until('restored', async () => (await c.lab.entries(c.ws)).find((x) => x.kind === 'session.opened' && x.content.origin === anchor))
  await until('Session open', async () => (await c.lab.state(c.ws)).current?.session ?? null)
  await c.lab.write(c.ws, '/recall')
  await c.lab.turn(c.ws, 'done')
  const said = lines(await c.lab.entries(c.ws), 'in', 'session/update')
    .map((x) => String(object(object(object(x.content.params)?.update)?.content)?.text ?? ''))
    .join('')
  assert.match(said, /groseille/, 'the native files placed are those pushed')
  // Its anchor pushed in turn; then R2 unreachable: the next restore fails, restore_failed.
  const second = (await c.lab.state(c.ws)).current!
  await expire(c.lab.kube, second.claimName)
  await until('second anchor', async () => (await c.lab.entries(c.ws)).find((x) => x.kind === 'execution.ended' && x.execution === second.id && x.content.anchor !== null))
  await s3.stop()
  const third = await c.lab.command(c.ws, 'Create', {}, { pool: 'mock-test' })
  assert.ok(third.accepted)
  const failed = await until('restore failed', async () => (await c.lab.entries(c.ws)).find((x) => x.kind === 'execution.failed' && x.execution === (third as { execution?: string }).execution))
  assert.equal(failed.content.reason, 'restore_failed')
  t.diagnostic(`anchor ${anchor} → object ${file.slice(0, 12)}…, content null; restored and recalled 'groseille'; R2 stopped: ${String(failed.kind)} ${String(failed.content.reason)}`)
})

test('B7 GET /api/files: the owner gets the bytes, as an image only when asked for one; nobody else gets anything', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws } = await opened(t, { s3 })
  await lab.write(ws, '/file 100000 9')
  await lab.turn(ws, 'done')
  const bytes = mockFile(100_000, 9)
  const owner = String((await lab.store.writer.query('SELECT owner FROM workstreams WHERE id=$1', [ws])).rows[0].owner)
  const get = (path: string) => fetch(`${lab.url}${path}`)
  const mine = await get(`/api/files/${sha(bytes)}?type=image/jpeg&owner=${owner}`)
  assert.equal(mine.status, 200)
  assert.equal(mine.headers.get('content-type'), 'image/jpeg')
  assert.equal(mine.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(mine.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.ok(Buffer.from(await mine.arrayBuffer()).equals(bytes))
  const others = await get(`/api/files/${sha(bytes)}?type=image/jpeg&owner=${randomUUID()}`)
  assert.deepEqual([others.status, (await others.json()).reason], [404, 'unknown_file'])
  const unknown = await get(`/api/files/${sha(Buffer.from('nothing'))}?owner=${owner}`)
  assert.deepEqual([unknown.status, (await unknown.json()).reason], [404, 'unknown_file'])
  const svg = await get(`/api/files/${sha(bytes)}?type=image/svg%2Bxml&owner=${owner}`)
  assert.equal(svg.status, 200)
  assert.equal(svg.headers.get('content-type'), 'application/octet-stream')
  assert.equal(svg.headers.get('content-disposition'), 'attachment')
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff')
  await svg.arrayBuffer()
  t.diagnostic(`owner 200 ${String(mine.headers.get('content-type'))}; another owner ${String(others.status)}; unknown ${String(unknown.status)}; svg asked: ${String(svg.headers.get('content-type'))}, ${String(svg.headers.get('content-disposition'))}`)
})

test('B8 the sweep: referenced or recent kept; unreferenced and older than a day deleted, with its row', async (t) => {
  const s3 = await fresh(t)
  const { db, lab, ws, e } = await opened(t, { s3 })
  await lab.write(ws, '/file 100000 10')
  await lab.turn(ws, 'done')
  const referenced = sha(mockFile(100_000, 10))
  const files = lab.store.files!
  // Rows and objects set as days had passed (simulated: forced-state).
  const make = async (seed: number, ageMs: number, row = true): Promise<string> => {
    const bytes = mockFile(70_000, seed)
    const digest = sha(bytes)
    await files.put(digest, bytes)
    s3.age(digest, ageMs)
    if (row) await db.admin.query("INSERT INTO files(sha256,size,time) VALUES($1,$2,now() - make_interval(secs => $3))", [digest, bytes.byteLength, ageMs / 1000])
    return digest
  }
  const recent = await make(11, 3600_000)
  const old = await make(12, 2 * 86400_000)
  const orphan = await make(13, 2 * 86400_000, false)
  await db.admin.query("UPDATE files SET time = now() - interval '2 days' WHERE sha256 = $1", [referenced])
  s3.age(referenced, 2 * 86400_000)
  // Two anchors of one harness: the second replaces the first, whose object is then two days old.
  const first = Buffer.from(encode({ format: 'agora-anchor/1', harness: 'mock', files: [{ path: 'a', checksum: 'x', content: Buffer.from('first').toString('base64') }], stable: true }))
  const second = Buffer.from(encode({ format: 'agora-anchor/1', harness: 'mock', files: [{ path: 'a', checksum: 'x', content: Buffer.from('second').toString('base64') }], stable: true }))
  await lab.store.storeAnchor({ id: randomUUID(), workstream: ws, execution: e.id, session: e.session, metadata: { harness: 'mock' }, bytes: first })
  await db.admin.query("UPDATE files SET time = now() - interval '2 days' WHERE sha256 = $1", [sha(first)])
  s3.age(sha(first), 2 * 86400_000)
  await lab.store.storeAnchor({ id: randomUUID(), workstream: ws, execution: e.id, session: e.session, metadata: { harness: 'mock' }, bytes: second })
  await db.admin.query("UPDATE files SET time = now() - interval '2 days' WHERE sha256 = $1", [sha(second)])
  s3.age(sha(second), 2 * 86400_000)
  const swept = await lab.store.sweep()
  assert.deepEqual(swept, { rows: 2, orphans: 1 })
  assert.deepEqual([...s3.objects.keys()].sort(), [key(referenced), key(recent), key(sha(second))].sort())
  const rows = (await db.admin.query('SELECT sha256 FROM files ORDER BY sha256')).rows.map((r) => r.sha256)
  assert.deepEqual(rows, [referenced, recent, sha(second)].sort())
  assert.ok(!s3.objects.has(key(old)) && !s3.objects.has(key(orphan)) && !s3.objects.has(key(sha(first))))
  t.diagnostic(`swept ${JSON.stringify(swept)}; objects left ${String(s3.objects.size)}, rows left ${String(rows.length)}`)
})

test('B9 a log written with files inline, moved: each entry expands back, anchors become objects, one object per content', async (t) => {
  const s3 = await fresh(t)
  const db = await database()
  t.after(() => db.drop())
  const ws = randomUUID()
  await db.admin.query('INSERT INTO workstreams(id, owner, last_position) VALUES($1, $2, 3)', [ws, randomUUID()])
  const image = mockFile(120_000, 14).toString('base64')
  const line = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: image } }], rawOutput: [{ type: 'image', source: { data: image } }] }, _meta: { n: 1 } } }
  // A number beyond 2^53, as a line carries it: kept exact through the move.
  const raw = encode(line).replace('"_meta":{"n":1}', '"_meta":{"n":9007199254740993}')
  const command = { id: randomUUID(), kind: 'Write', target: {}, body: { prompt: [{ type: 'image', mimeType: 'image/png', data: image, uri: 'x.png' }] } }
  await db.admin.query("INSERT INTO entries(workstream,position,kind,content) VALUES($1,1,'command',$2::jsonb),($1,2,'acp',$3::jsonb),($1,3,'acp',$4::jsonb)", [
    ws,
    encode(command),
    raw,
    encode({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'small' } } } }),
  ])
  await db.admin.query("INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position) VALUES($1,'core','element',$2,$3::jsonb,2,2)", [ws, randomUUID(), encode({ type: 'tool', content: [{ type: 'content', content: { type: 'image', data: image } }] })])
  const anchorBytes = Buffer.from('an anchor of before')
  await db.admin.query("INSERT INTO anchors(id,workstream,execution,metadata,content) VALUES($1,$2,$3,'{}'::jsonb,$4)", [randomUUID(), ws, randomUUID(), anchorBytes])
  const before = (await db.admin.query('SELECT position, content::text AS c FROM entries WHERE workstream=$1 ORDER BY position', [ws])).rows.map((r) => decode(r.c as string))
  const moved = await moveFiles(db.admin, new Files(s3.options()))
  assert.deepEqual(moved, { entries: 2, objects: 1, anchors: 1, files: 2 })
  const after = await db.admin.query('SELECT position, content::text AS c, files FROM entries WHERE workstream=$1 ORDER BY position', [ws])
  const bytes = new Map([...s3.objects].map(([k, o]) => [k.slice('sha256/'.length), o.bytes]))
  for (const [i, r] of after.rows.entries()) {
    const value = decode(r.c as string)
    const expanded = r.files === null ? value : expandFiles(value, r.files, bytes)
    assert.equal(canonical(expanded), canonical(before[i]), `entry ${String(r.position)} expands back`)
  }
  assert.match(String(after.rows[1].c), /9007199254740993/)
  for (const table of ['entries', 'objects']) {
    const texts = (await db.admin.query(`SELECT ${table === 'entries' ? 'content' : 'object'}::text AS t FROM ${table}`)).rows.map((r) => String(r.t))
    for (const text of texts) assert.ok(!new RegExp(`[A-Za-z0-9+/]{${String(FILE_MIN)}}`).test(text), `no base64 file left in ${table}`)
  }
  const anchor = (await db.admin.query('SELECT file, content FROM anchors')).rows[0]
  assert.equal(anchor.content, null)
  assert.ok(s3.objects.get(key(String(anchor.file)))!.bytes.equals(anchorBytes))
  assert.equal(s3.objects.size, 2, 'one object per distinct SHA-256: the image and the anchor')
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM files')).rows[0].count), 2)
  // A second run moves nothing more.
  assert.deepEqual(await moveFiles(db.admin, new Files(s3.options())), { entries: 0, objects: 0, anchors: 0, files: 0 })
  t.diagnostic(`moved ${JSON.stringify(moved)}; then nothing more; objects ${String(s3.objects.size)}`)
})

test('B10 a line naming a stored file, written while a sweep that deletes it holds the lock: it waits, and stores it again', async (t) => {
  const s3 = await fresh(t)
  const { db, lab, ws } = await opened(t, { s3 })
  const bytes = mockFile(100_000, 15)
  const digest = sha(bytes)
  await lab.store.files!.put(digest, bytes)
  await db.admin.query("INSERT INTO files(sha256,size,time) VALUES($1,$2,now() - interval '2 days')", [digest, bytes.byteLength])
  // The sweep holds the files lock exclusive while it deletes the row and the object (simulated: forced-state).
  const sweep = await db.admin.connect()
  await sweep.query('SELECT pg_advisory_lock($1)', [FILES_LOCK])
  let written: Promise<unknown>
  try {
    written = lab.write(ws, '/file 100000 15').then(() => lab.turn(ws, 'done'))
    await until('the writer waits for the lock', async () => {
      const waiting = await db.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=$1", [FILES_LOCK])
      return waiting.rows[0].n > 0
    })
    await sweep.query('DELETE FROM files WHERE sha256=$1', [digest])
    s3.objects.delete(key(digest))
  } finally {
    await sweep.query('SELECT pg_advisory_unlock($1)', [FILES_LOCK])
    sweep.release()
  }
  await written
  assert.ok(s3.objects.get(key(digest))?.bytes.equals(bytes), 'the object is there again')
  const [entry] = withFiles(await lab.entries(ws))
  assert.deepEqual(new Set(entry!.files!.map((f) => f.sha256)), new Set([digest]))
  const rows = await db.admin.query('SELECT sha256 FROM files')
  assert.deepEqual(rows.rows.map((r) => r.sha256), [digest])
  t.diagnostic(`PutObject: ${JSON.stringify(s3.requests.filter((r) => r.operation === 'PutObject').map((r) => r.status))}; the entry's files ${JSON.stringify(entry!.files)}`)
})

test('B11 a message with a file written during a turn, R2 unreachable when it ends: the message waits, then goes with its bytes', async (t) => {
  const s3 = await fresh(t)
  const { lab, ws, e } = await opened(t, { s3 })
  await lab.write(ws, '/sleep 2')
  await lab.turn(ws, 'in_progress')
  const bytes = mockFile(300_000, 16)
  const answer = (await lab.command(ws, 'Write', { execution: e.id, session: e.session }, { prompt: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64'), uri: 'late.png' }], mayWait: true })) as { accepted: boolean; waiting?: boolean }
  assert.deepEqual([answer.accepted, answer.waiting], [true, true])
  await s3.stop()
  await lab.turn(ws, 'done')
  await until('the message held on its file', () => lab.logs.some((l) => l.includes('"operation":"dispatch"') && l.includes('"errorClass":"files"')))
  await new Promise((r) => setTimeout(r, 1500))
  const prompts = () => lab.entries(ws).then((entries) => lines(entries, 'out', 'session/prompt').filter((x) => x.rpc_kind === 'request'))
  assert.equal((await prompts()).length, 1, 'nothing sent while R2 is unreachable')
  await s3.start()
  await until('the message sent', async () => ((await prompts()).length === 2 ? true : undefined))
  await lab.turn(ws, 'done')
  const sent = (await prompts())[1]!
  assert.deepEqual(sent.files, [{ path: '/params/prompt/0/data', sha256: sha(bytes), size: 300_000 }])
  const said = lines(await lab.entries(ws), 'in', 'session/update')
    .map((x) => String(object(object(object(x.content.params)?.update)?.content)?.text ?? ''))
    .join('')
  assert.match(said, new RegExp(`Received an image, image/png, 300000 bytes, sha256 ${sha(bytes).slice(0, 12)}\\.`))
  t.diagnostic(`held while R2 was unreachable, then sent: files ${JSON.stringify(sent.files)}; the agent: ${said.split('Received')[1]?.split('\n')[0] ?? ''}`)
})

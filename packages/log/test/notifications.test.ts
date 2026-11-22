// docs/specs/notifications.md: a form shown to the person, an approval or a merge card notifies its owner once, written
// with the view that makes it pending, sent to every subscription of the owner's unless no longer pending by then. The
// push services stand in: each request recorded, answered as the case asks; its payload decrypted here (RFC 8291), its
// VAPID token checked against the server's key (RFC 8292). Real bridges and the mock agent ask the forms.
import assert from 'node:assert/strict'
import { createECDH, createDecipheriv, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { importJWK, jwtVerify } from 'jose'
import { generateVAPIDKeys } from 'web-push'
import type { GitHub, MergeOutcome, MergeState, PullRequest } from '@agora/credentials'
import { core, lineOf, Merges, type NotificationsOptions, type Send } from '../src/index.ts'
import { cluster, database, FakeKube, Lab, Server, sleep, until, type Db } from './support.ts'

type T = { after(fn: () => Promise<void>): void }
const VAPID = generateVAPIDKeys()
const ORIGIN = 'https://agora.example'
const SUBJECT = 'mailto:operator@example.org'

/** A browser's subscription: its keys, kept to read what is sent to it. */
function subscriber(host = 'web.push.apple.com') {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const endpoint = `https://${host}/${randomUUID()}`
  return {
    endpoint,
    json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    /** RFC 8291's `aes128gcm`, undone with the subscription's private key and secret. */
    decrypt(body: Buffer): Record<string, unknown> {
      const salt = body.subarray(0, 16)
      const idlen = body[20]!
      const server = body.subarray(21, 21 + idlen)
      const sealed = body.subarray(21 + idlen)
      const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest()
      const prkKey = hmac(auth, ecdh.computeSecret(server))
      const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), server, Buffer.from([1])]))
      const prk = hmac(salt, ikm)
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(sealed.subarray(sealed.length - 16))
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
      // The last record: its padding delimiter 0x02, then zeros.
      const end = plain.lastIndexOf(2)
      return JSON.parse(plain.subarray(0, end).toString('utf8')) as Record<string, unknown>
    },
  }
}

/** The push services: every request, answered by the next status scripted for its endpoint, 201 when none is. */
class FakePush {
  readonly requests: { endpoint: string; headers: Record<string, string>; body: Buffer; at: number }[] = []
  readonly script = new Map<string, { status: number; retryAfter?: string }[]>()
  readonly send: Send = async (endpoint, init) => {
    this.requests.push({ endpoint, headers: init.headers, body: init.body, at: Date.now() })
    const next = this.script.get(endpoint)?.shift() ?? { status: 201 }
    return { status: next.status, retryAfter: next.retryAfter ?? null }
  }
  to(endpoint: string) {
    return this.requests.filter((r) => r.endpoint === endpoint)
  }
}

async function bench(t: T, options: { db?: Db; push?: FakePush; notifications?: boolean } = {}) {
  const db = options.db ?? (await database())
  const keys = generateKeyPairSync('ed25519')
  const kube = new FakeKube(keys.publicKey)
  const push = options.push ?? new FakePush()
  const notifications: NotificationsOptions = { publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, subject: SUBJECT, origin: ORIGIN, send: push.send }
  const lab = await Lab.start({ db, kube, keys, ...(options.notifications === false ? {} : { notifications }) })
  const labs = [lab]
  t.after(async () => {
    for (const l of labs) if (!l.closed) await l.close()
    await kube.closeAll()
    await db.drop()
  })
  return { db, lab, kube, push, labs }
}

const post = async (lab: Lab, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${lab.url}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}
const subscribe = (lab: Lab, owner: string, json: unknown) => post(lab, 'POST', '/api/push/subscriptions', { ...(json as object), owner })
const ownerOf = async (lab: Lab, ws: string) => (await lab.store.projector.query('SELECT owner FROM workstreams WHERE id=$1', [ws])).rows[0].owner as ReturnType<typeof randomUUID>
const rows = async (lab: Lab) =>
  (await lab.store.projector.query('SELECT workstream, position::text AS position, kind, title, body, state FROM push_notifications ORDER BY created_at, position')).rows as {
    workstream: string
    position: string
    kind: string
    title: string
    body: string
    state: string
  }[]
const settled = (lab: Lab, n = 1) => until(`${String(n)} notification(s) settled`, async () => ((await rows(lab)).filter((r) => r.state !== 'pending').length >= n ? rows(lab) : null))
/** An approval as Agora asks it (docs/specs/delegation.md, "Approval"). */
const approval = (lab: Lab, ws: string, title: string, inMs = 60_000) =>
  lab.workstreams.command(
    ws,
    { id: randomUUID(), kind: 'Ask', target: {}, body: { kind: 'approval', title, text: 'A delegate', options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' }], expiresAt: new Date(Date.now() + inMs).toISOString() } },
    'agora',
  )
const pendingQuestion = async (lab: Lab, ws: string) => (await lab.state(ws)).question!.position
/** The view, projected, once it waits on a request. */
const requested = (lab: Lab, ws: string) =>
  until('the view’s request', async () => {
    await lab.workstreams.projections.run(ws)
    const view = (await lab.workstreams.projections.objects(ws)).find((o) => o.kind === 'workstream')?.object
    return typeof view?.request === 'string' ? view : null
  })

test('N1 a form asked in a root Workstream: one notification, one push to each subscription — its headers, VAPID, the declarative message decrypted — then sent', async (t) => {
  const { lab, push } = await bench(t)
  const ws = await lab.workstream()
  const owner = await ownerOf(lab, ws)
  const [a, b] = [subscriber(), subscriber('fcm.googleapis.com')]
  for (const s of [a, b]) assert.deepEqual(await subscribe(lab, owner, s.json), { status: 200, body: {} })
  await lab.open(ws)
  assert.ok((await lab.write(ws, '/question')).accepted)
  const view = await requested(lab, ws)
  const [row] = await settled(lab)
  assert.deepEqual([row!.workstream, row!.position, row!.kind, row!.state], [ws, view.request, 'form', 'sent'])
  for (const s of [a, b]) {
    const [request, ...more] = push.to(s.endpoint)
    assert.equal(more.length, 0)
    const ttl = Number(request!.headers.TTL)
    assert.ok(ttl > 86_390 && ttl <= 86_400, `TTL ${String(ttl)}`)
    assert.deepEqual([request!.headers.Urgency, request!.headers.Topic, request!.headers['Content-Encoding']], ['high', ws.replaceAll('-', ''), 'aes128gcm'])
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(request!.headers.Authorization!)!
    assert.equal(key, VAPID.publicKey)
    const raw = Buffer.from(VAPID.publicKey, 'base64url')
    const jwk = await importJWK({ kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, 'ES256')
    const { payload } = await jwtVerify(token!, jwk)
    assert.deepEqual([payload.aud, payload.sub], [new URL(s.endpoint).origin, SUBJECT])
    assert.ok(payload.exp! - Date.now() / 1000 <= 12 * 3600)
    assert.deepEqual(s.decrypt(request!.body), {
      web_push: 8030,
      notification: {
        title: view.title,
        body: 'Question · Which database should the service use?',
        navigate: `${ORIGIN}/w/${ws}`,
        tag: ws,
        data: { workstream: ws, position: view.request, kind: 'form' },
        app_badge: '1',
      },
    })
  }
  // Its title is the Workstream's, as its view has it at the time.
  assert.equal(row!.title, view.title)
})

test('N2 a delegate’s form, a permission and a form Agora declines notify nobody; a native sub-agent’s form under a delegate notifies the person', async (t) => {
  const { lab, push } = await bench(t)
  const root = await lab.workstream()
  const owner = await ownerOf(lab, root)
  const s = subscriber()
  await subscribe(lab, owner, s.json)
  const delegate = async () => {
    const id = randomUUID()
    await lab.store.create(id, null, root)
    await lab.workstreams.record(id, { kind: 'delegation.started', content: { caller: root, callerExecution: randomUUID(), harness: 'mock', pool: 'mock-test', settings: {}, rights: [], instructions: 'do it' } })
    return id
  }
  const [asking, hosting] = [await delegate(), await delegate()]
  const [permission, secret] = [await lab.workstream(owner), await lab.workstream(owner)]
  for (const ws of [asking, hosting, permission, secret]) await lab.open(ws)
  assert.ok((await lab.write(asking, '/question')).accepted)
  assert.ok((await lab.write(hosting, '/sub {"form":true,"n":30}')).accepted)
  assert.ok((await lab.write(permission, '/permission')).accepted)
  assert.ok((await lab.write(secret, '/form secret')).accepted)
  await requested(lab, asking)
  await requested(lab, permission)
  const native = await until('the native sub-stream’s form', async () => {
    const sub = (await lab.store.projector.query('SELECT id FROM workstreams WHERE host=$1', [hosting])).rows[0]?.id as string | undefined
    if (sub === undefined) return null
    await lab.workstreams.projections.run(hosting)
    const objects = await lab.workstreams.projections.objects(sub)
    const form = objects.find((o) => o.kind === 'element' && o.object.type === 'elicitation' && o.object.status === 'pending')?.object
    // Its view waits as a native sub-stream's does: `waiting`, no request of its own (docs/specs/log.md, "Native sub-agents").
    const view = objects.find((o) => o.kind === 'workstream')?.object
    return form && view?.subagent === 'waiting' ? { sub, view: { request: form.requestPosition } } : null
  })
  await until('the secret form declined', async () => (await lab.entries(secret)).some((e) => e.direction === 'out' && e.content.result !== undefined && (e.content.result as { action?: string }).action === 'decline'))
  const [row] = await settled(lab)
  await sleep(500)
  const all = await rows(lab)
  assert.equal(all.length, 1)
  assert.deepEqual([row!.workstream, row!.position, row!.kind, row!.state], [native.sub, native.view.request, 'form', 'sent'])
  assert.equal(push.requests.length, 1)
  assert.equal((s.decrypt(push.requests[0]!.body).notification as Record<string, unknown>).navigate, `${ORIGIN}/w/${native.sub}`)
})

test('N3 an approval: one notification, its TTL what is left to its expiry; one answered, then one expired, before sending: dropped, nothing sent', async (t) => {
  const { lab, push } = await bench(t)
  const ws = await lab.workstream()
  const s = subscriber()
  await subscribe(lab, await ownerOf(lab, ws), s.json)
  assert.ok((await approval(lab, ws, 'Start a dev on the parser', 60_000)).accepted)
  const [row] = await settled(lab)
  assert.deepEqual([row!.kind, row!.state, row!.body], ['approval', 'sent', 'Approval · Start a dev on the parser'])
  const ttl = Number(push.requests[0]!.headers.TTL)
  assert.ok(ttl > 50 && ttl <= 60, `TTL ${String(ttl)}`)
  // Held: the engine stopped, the cards answered or expired meanwhile, then started again.
  const held = await lab.workstream(await ownerOf(lab, ws))
  const late = await lab.workstream(await ownerOf(lab, ws))
  await lab.workstreams.notifications!.stop()
  assert.ok((await approval(lab, held, 'Answered first')).accepted)
  assert.ok((await lab.command(held, 'Answer', { question: await pendingQuestion(lab, held) }, { optionId: 'approve' })).accepted)
  assert.ok((await approval(lab, late, 'Expired first', 1_500)).accepted)
  await sleep(2_000)
  await lab.workstreams.notifications!.start()
  const all = await settled(lab, 3)
  assert.deepEqual(all.map((r) => [r.workstream, r.state]), [[ws, 'sent'], [held, 'dropped'], [late, 'dropped']])
  assert.equal(push.requests.length, 1)
})

class FakeGitHub implements GitHub {
  async pull(repo: string, number: number): Promise<PullRequest | null> {
    return { number, title: 'Add the parser', url: `https://github.com/${repo}/pull/${String(number)}`, open: true, merged: false, draft: false, base: 'main', head: 'feat/parser', sha: 'h3ad', author: 'agora-contributor[bot]', mergeableState: null, mergeSha: '' }
  }
  async state(repo: string, number: number): Promise<{ state: MergeState; pull: PullRequest } | null> {
    return { state: 'review', pull: (await this.pull(repo, number))! }
  }
  async merge(): Promise<MergeOutcome> {
    return { merged: false, reason: 'not here' }
  }
}

test('N4 propose_merge on an open pull request: one notification, `Merge · ` and its title, a day to live', async (t) => {
  const { lab, push } = await bench(t)
  const ws = await lab.workstream()
  const s = subscriber()
  await subscribe(lab, await ownerOf(lab, ws), s.json)
  const merges = new Merges(lab.workstreams, { github: new FakeGitHub(), maxAgeMs: 0 })
  await merges.propose({ workstream: ws, execution: randomUUID(), profiles: ['github:octo/app:write'] }, { repo: 'octo/app', number: 7 })
  const [row] = await settled(lab)
  assert.deepEqual([row!.kind, row!.state, row!.body], ['merge', 'sent', 'Merge · Add the parser'])
  const ttl = Number(push.requests[0]!.headers.TTL)
  assert.ok(ttl > 86_390 && ttl <= 86_400)
  assert.equal((s.decrypt(push.requests[0]!.body).notification as Record<string, unknown>).body, 'Merge · Add the parser')
})

test('N5 the server restarted between a card’s commit and its sending, then after it, then the projection rebuilt: sent once', async (t) => {
  const { lab, push, labs } = await bench(t)
  const ws = await lab.workstream()
  await subscribe(lab, await ownerOf(lab, ws), subscriber().json)
  // Nothing sent before the restart: the engine is stopped, the card committed with its view.
  await lab.workstreams.notifications!.stop()
  assert.ok((await approval(lab, ws, 'Across a restart')).accepted)
  await lab.workstreams.projections.run(ws)
  assert.deepEqual((await rows(lab)).map((r) => r.state), ['pending'])
  assert.equal(push.requests.length, 0)
  const second = await lab.restart('halt')
  labs.push(second)
  await settled(second)
  assert.equal(push.requests.length, 1)
  const third = await second.restart('clean')
  labs.push(third)
  await third.workstreams.projections.run(ws, core, true)
  await third.workstreams.projections.run(ws)
  await sleep(500)
  assert.equal(push.requests.length, 1)
  assert.deepEqual((await rows(third)).map((r) => r.state), ['sent'])
})

test('N6 two Workstreams’ cards, then the first answered and another asked in it: three notifications, the same Topic for one Workstream, the badge counting what is pending', async (t) => {
  const { lab, push } = await bench(t)
  const first = await lab.workstream()
  const owner = await ownerOf(lab, first)
  const second = await lab.workstream(owner)
  const s = subscriber()
  await subscribe(lab, owner, s.json)
  const badge = (i: number) => (s.decrypt(push.requests[i]!.body).notification as Record<string, unknown>).app_badge
  assert.ok((await approval(lab, first, 'One')).accepted)
  await settled(lab, 1)
  assert.ok((await approval(lab, second, 'Two')).accepted)
  await settled(lab, 2)
  assert.ok((await lab.command(first, 'Answer', { question: await pendingQuestion(lab, first) }, { optionId: 'approve' })).accepted)
  assert.ok((await approval(lab, first, 'Three')).accepted)
  await settled(lab, 3)
  assert.deepEqual([badge(0), badge(1), badge(2)], ['1', '2', '2'])
  assert.deepEqual(push.requests.map((r) => r.headers.Topic), [first, second, first].map((w) => w.replaceAll('-', '')))
})

test('N7 the push services answering 201, 410, 404, 429 with Retry-After, 500 then 201, 400: delivered, removed, removed, tried again after it, delivered, given up; nothing of an endpoint’s path in the log', async (t) => {
  const { lab, push } = await bench(t)
  const ws = await lab.workstream()
  const owner = await ownerOf(lab, ws)
  const [ok, gone, unknown, busy, failing, refused] = Array.from({ length: 6 }, () => subscriber())
  push.script.set(gone!.endpoint, [{ status: 410 }])
  push.script.set(unknown!.endpoint, [{ status: 404 }])
  push.script.set(busy!.endpoint, [{ status: 429, retryAfter: '8' }, { status: 201 }])
  push.script.set(failing!.endpoint, [{ status: 500 }, { status: 201 }])
  push.script.set(refused!.endpoint, [{ status: 400 }])
  for (const s of [ok, gone, unknown, busy, failing, refused]) assert.equal((await subscribe(lab, owner, s!.json)).status, 200)
  assert.ok((await approval(lab, ws, 'Retried', 120_000)).accepted)
  const [row] = await until('sent', async () => ((await rows(lab))[0]?.state === 'sent' ? rows(lab) : null), 30_000)
  assert.equal(row!.state, 'sent')
  assert.deepEqual([ok, gone, unknown, busy, failing, refused].map((s) => push.to(s!.endpoint).length), [1, 1, 1, 2, 2, 1])
  const [first, again] = push.to(busy!.endpoint)
  assert.ok(again!.at - first!.at >= 8_000, `retried after ${String(again!.at - first!.at)} ms`)
  const left = (await lab.store.projector.query('SELECT endpoint FROM push_subscriptions ORDER BY endpoint')).rows.map((r) => r.endpoint as string)
  assert.deepEqual(left, [ok, busy, failing, refused].map((s) => s!.endpoint).sort())
  const lines = lab.logs.filter((l) => l.includes('"operation":"push"'))
  assert.ok(lines.some((l) => l.includes('"status":410') && l.includes('"host":"web.push.apple.com"')))
  for (const s of [ok, gone, unknown, busy, failing, refused]) assert.ok(!lab.logs.some((l) => l.includes(new URL(s!.endpoint).pathname.slice(1)) || l.includes(s!.json.keys.auth)))
})

test('N8 subscriptions: endpoints and keys outside their bounds refused; the same endpoint again replaced; an eleventh refused; removed, and removed again', async (t) => {
  const { lab } = await bench(t)
  const owner = randomUUID()
  const good = subscriber().json
  for (const json of [
    { ...good, endpoint: good.endpoint.replace('https:', 'http:') },
    { ...good, endpoint: `https://push.example.org/${randomUUID()}` },
    { ...good, endpoint: good.endpoint.replace('web.push.apple.com', 'web.push.apple.com:8443') },
    { ...good, keys: { ...good.keys, p256dh: Buffer.from(good.keys.p256dh, 'base64url').subarray(1).toString('base64url') } },
    { ...good, keys: { ...good.keys, auth: randomBytes(8).toString('base64url') } },
  ])
    assert.deepEqual(await subscribe(lab, owner, json), { status: 400, body: { reason: 'invalid_subscription' } })
  const stored = async () => (await lab.store.projector.query('SELECT endpoint, p256dh FROM push_subscriptions WHERE owner=$1 ORDER BY endpoint', [owner])).rows
  assert.equal((await stored()).length, 0)
  const again = { ...subscriber().json, endpoint: good.endpoint }
  assert.equal((await subscribe(lab, owner, good)).status, 200)
  assert.equal((await subscribe(lab, owner, again)).status, 200)
  assert.deepEqual(await stored(), [{ endpoint: good.endpoint, p256dh: again.keys.p256dh }])
  for (let i = 1; i < 10; i++) assert.equal((await subscribe(lab, owner, subscriber().json)).status, 200)
  const eleventh = subscriber().json
  assert.deepEqual(await subscribe(lab, owner, eleventh), { status: 409, body: { reason: 'too_many_subscriptions' } })
  assert.deepEqual(await post(lab, 'DELETE', '/api/push/subscriptions', { owner, endpoint: good.endpoint }), { status: 200, body: {} })
  assert.equal((await stored()).length, 9)
  assert.deepEqual(await post(lab, 'DELETE', '/api/push/subscriptions', { owner, endpoint: eleventh.endpoint }), { status: 200, body: {} })
  assert.equal((await stored()).length, 9)
})

test('N9 two owners, each a subscription and a card: each subscription receives its owner’s alone, each list its own alone', async (t) => {
  const { lab, push } = await bench(t)
  const [mine, theirs] = [await lab.workstream(), await lab.workstream()]
  const [me, them] = [subscriber(), subscriber()]
  await subscribe(lab, await ownerOf(lab, mine), me.json)
  await subscribe(lab, await ownerOf(lab, theirs), them.json)
  assert.ok((await approval(lab, mine, 'Mine')).accepted)
  assert.ok((await approval(lab, theirs, 'Theirs')).accepted)
  await settled(lab, 2)
  const workstreamOf = (s: ReturnType<typeof subscriber>) => push.to(s.endpoint).map((r) => (s.decrypt(r.body).notification as { data: { workstream: string } }).data.workstream)
  assert.deepEqual([workstreamOf(me), workstreamOf(them)], [[mine], [theirs]])
  for (const [ws, position] of [
    [mine, await pendingQuestion(lab, mine)],
    [theirs, await pendingQuestion(lab, theirs)],
  ] as const)
    assert.deepEqual(await post(lab, 'GET', `/api/push/pending?owner=${await ownerOf(lab, ws)}`), { status: 200, body: { cards: [{ workstream: ws, position, kind: 'approval' }] } })
})

test('N10 without the VAPID keys: push_unavailable, no notification written; the real server with three of the four variables does not start, with the four answers its key', async (t) => {
  const { lab } = await bench(t, { notifications: false })
  const ws = await lab.workstream()
  assert.deepEqual(await post(lab, 'GET', '/api/push'), { status: 404, body: { reason: 'push_unavailable' } })
  assert.deepEqual(await subscribe(lab, randomUUID(), subscriber().json), { status: 404, body: { reason: 'push_unavailable' } })
  assert.ok((await approval(lab, ws, 'Nobody told')).accepted)
  await lab.workstreams.projections.run(ws)
  assert.equal((await rows(lab)).length, 0)
  const db = await database()
  const { api, keys, close } = await cluster()
  t.after(async () => {
    await close()
    await db.drop()
  })
  const env = { PUSH_VAPID_PUBLIC_KEY: VAPID.publicKey, PUSH_VAPID_PRIVATE_KEY: VAPID.privateKey, PUSH_SUBJECT: SUBJECT, PUBLIC_URL: ORIGIN }
  const { PUBLIC_URL: _, ...three } = env
  await assert.rejects(Server.start({ db, api, keys, env: three }), /lab exited/)
  const server = await Server.start({ db, api, keys, env })
  t.after(async () => void (await server.stop()))
  const answer = await fetch(`${server.url}/api/push`)
  assert.deepEqual([answer.status, await answer.json()], [200, { key: VAPID.publicKey }])
})

test('N11 a card’s line: its first line alone, cut at 120 code points with an ellipsis', async (t) => {
  const long = '🦀'.repeat(150) + ' tail'
  assert.equal(lineOf(`${long}\nsecond line`), `${'🦀'.repeat(119)}…`)
  assert.equal(lineOf('\n  Short one  \nsecond'), 'Short one')
  const { lab } = await bench(t)
  const ws = await lab.workstream()
  assert.ok((await approval(lab, ws, 'x'.repeat(150))).accepted)
  await lab.workstreams.projections.run(ws)
  const [row] = await rows(lab)
  assert.equal(row!.body, `Approval · ${'x'.repeat(119)}…`)
})

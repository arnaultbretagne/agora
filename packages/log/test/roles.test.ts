// Roles (docs/specs/roles.md), on the lab: a Workstream started as a role, by its Create; the persona the log gives
// ahead of the first prompt of a new Session. Real bridges with the mock agent; a Pod ending without its anchor is its
// push not reaching Agora, as when the node dies. P1 on the real server (apps/server/src/main.ts).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dispatched, exchangesOf, isCatchUp } from '../src/catch-up.ts'
import { isRole, ROLE_META, type Entry, type Role } from '../src/index.ts'
import type { Execution } from '../src/state.ts'
import { cluster, database, expire, lines, opened, Server, sleep, until, type Lab } from './support.ts'

type T = { after(fn: () => Promise<void>): void }
type Block = { type: string; text: string; _meta?: Record<string, unknown> }
type Context = { lab: Lab; ws: string }

const SCOUT: Role = { name: 'scout', summary: 'Looks before anyone builds.', harness: 'mock', model: null, effort: null, access: [], persona: '# Scout\n\nYou look, and you say what you saw.' }
const PLAIN: Role = { name: 'plain', summary: 'Nothing special.', harness: 'mock', model: null, effort: null, access: [], persona: '# Plain\n\nNothing of your own.' }
const BLOCK = 'From Agora, not the person: your role, `scout`.\n\n# Scout\n\nYou look, and you say what you saw.'

/** A lab holding the two roles, a map of its own; a Workstream opened as `role`, or as none. */
async function started(t: T, create: Record<string, unknown> = { role: 'scout' }) {
  const roles = new Map([[SCOUT.name, SCOUT], [PLAIN.name, PLAIN]])
  const c = await opened(t, { workstreams: { roles }, receiver: true }, create)
  return { ...c, roles }
}

async function turn(c: Context, text: string): Promise<void> {
  const answer = await c.lab.write(c.ws, text)
  assert.ok(answer.accepted, `Write refused: ${String((answer as { reason?: string }).reason)}`)
  await c.lab.turn(c.ws, 'done')
}

/** The execution's Pod ends at its deadline; with `lost`, its anchor never reaches Agora. */
async function end(c: Context, e: Execution, lost = false): Promise<Entry> {
  const url = c.lab.kube.anchorUrl
  if (lost) c.lab.kube.anchorUrl = ''
  await expire(c.lab.kube, e.claimName)
  const ended = await until('execution.ended', async () => (await c.lab.entries(c.ws)).find((x) => x.kind === 'execution.ended' && x.execution === e.id))
  c.lab.kube.anchorUrl = url
  return ended
}

/** A Create with that body; its execution once its Session is open. */
async function create(c: Context, body: Record<string, unknown> = {}): Promise<Execution> {
  const answer = (await c.lab.command(c.ws, 'Create', {}, { pool: 'mock-test', ...body })) as { accepted: boolean; execution?: string; reason?: string }
  assert.ok(answer.accepted, `Create refused: ${String(answer.reason)}`)
  return until('the Session open, its commands given', async () => {
    const e = (await c.lab.state(c.ws)).executions.get(String(answer.execution))
    return e?.session && e.connection && e.commands.length ? { ...e } : null
  })
}

const prompts = async (c: Context, e: { id: string }): Promise<Block[][]> =>
  lines(await c.lab.entries(c.ws), 'out', 'session/prompt')
    .filter((x) => x.execution === e.id && x.rpc_kind === 'request')
    .map((x) => (x.content.params as { prompt: Block[] }).prompt)

const objects = (c: Context) => c.lab.workstreams.projections.objects(c.ws)
const view = async (c: Context) => (await objects(c)).find((o) => o.kind === 'workstream')?.object
const users = async (c: Context) => (await objects(c)).filter((o) => o.kind === 'element' && o.object.type === 'user').map((o) => o.object)

test('P1 the server started on the repository’s cards; on a directory holding a file that is no card: GET /api/config gives lead, dev, sre and judge, each with its summary, harness, model, effort and access, no persona, lead’s access agora:delegate; the start refused, naming the file', async (t) => {
  const db = await database()
  const c = await cluster()
  let server: Server | undefined = await Server.start({ db, api: c.api, keys: c.keys })
  t.after(async () => {
    await server?.stop()
    await c.close()
    await db.drop()
  })
  const config = (await (await fetch(`${server.url}/api/config`)).json()) as { roles: Record<string, unknown>[] }
  assert.deepEqual(config.roles.map((role) => role.role), ['dev', 'judge', 'lead', 'sre'])
  for (const role of config.roles) {
    assert.deepEqual(Object.keys(role), ['role', 'summary', 'harness', 'model', 'effort', 'access'], String(role.role))
    assert.ok(typeof role.summary === 'string' && role.summary !== '' && ['claude-code', 'codex', 'opencode'].includes(String(role.harness)), String(role.role))
  }
  const lead = config.roles.find((role) => role.role === 'lead')!
  const judge = config.roles.find((role) => role.role === 'judge')!
  assert.deepEqual([lead.access, judge.access, judge.harness, judge.model, judge.effort], [['agora:delegate'], [], 'codex', 'gpt-6.1-sol', 'xhigh'])
  assert.ok(!JSON.stringify(config).includes('You run a small engineering team'), 'no persona')
  await server.stop()
  server = undefined
  // A file that is no card: the server does not start, and says which.
  const dir = mkdtempSync(join(tmpdir(), 'roles-'))
  writeFileSync(join(dir, 'broken.md'), '# No front matter\n')
  await assert.rejects(Server.start({ db, api: c.api, keys: c.keys, env: { ROLES_DIR: dir } }), /broken\.md: a role card starts with its front matter/)
})

test('P2 a Create carrying a role, with a message; its Session opens: one prompt — Agora’s block first, marked with the role’s name, then the message; the user element the message alone, with role; the title the message’s first line; the view and the row give the role', async (t) => {
  const c = await started(t, {})
  const ws = await c.lab.workstream()
  const mine = { lab: c.lab, ws }
  const answer = (await c.lab.command(ws, 'Create', {}, { pool: 'mock-test', role: 'scout', prompt: [{ type: 'text', text: 'look at the tests\nand say what fails' }] })) as { accepted: boolean; execution: string }
  assert.equal(answer.accepted, true)
  await c.lab.turn(ws, 'done')
  const sent = await prompts(mine, { id: answer.execution })
  assert.equal(sent.length, 1)
  const [role, message, ...rest] = sent[0]!
  assert.deepEqual([role!.text, role!._meta?.[ROLE_META], message!.text, rest.length], [BLOCK, 'scout', 'look at the tests\nand say what fails', 0])
  const [user] = await until('its user element', async () => ((await users(mine)).length ? users(mine) : null))
  assert.deepEqual([user!.role, user!.from, (user!.content as Block[]).map((b) => b.text)], ['scout', undefined, ['look at the tests\nand say what fails']])
  await until('its view', async () => (await view(mine))?.title === 'look at the tests')
  assert.equal((await view(mine))?.role, 'scout')
  const row = await until('its row', async () => (await c.db.admin.query("SELECT row->>'role' AS role FROM listings WHERE workstream=$1", [ws])).rows[0] as { role: string | null } | undefined)
  assert.equal(row.role, 'scout')
  // The control: a Workstream started with none gives none, and its prompt is its message alone.
  await turn(c, 'plain words')
  assert.deepEqual((await prompts(c, c.e)).map((p) => p.map((b) => b.text)), [['plain words']])
  assert.deepEqual([(await view(c))?.role, (await users(c))[0]!.role], [undefined, undefined])
})

test('P3 a Create naming no card’s role; one whose role is no string: unknown_role; invalid_create; no entry, no execution', async (t) => {
  const c = await started(t, {})
  const ws = await c.lab.workstream()
  assert.deepEqual(await c.lab.command(ws, 'Create', {}, { pool: 'mock-test', role: 'judge' }), { accepted: false, reason: 'unknown_role' })
  assert.deepEqual(await c.lab.command(ws, 'Create', {}, { pool: 'mock-test', role: 7 }), { accepted: false, reason: 'invalid_create' })
  assert.equal((await c.lab.entries(ws)).length, 0)
  assert.equal((await c.lab.state(ws)).executions.size, 0)
})

test('P4 a second message in that Session; a message sent into a running turn: neither carries the block', async (t) => {
  const c = await started(t)
  await turn(c, 'first')
  await turn(c, 'second')
  assert.deepEqual((await prompts(c, c.e)).map((p) => p.some(isRole)), [true, false])
  // Into a running turn: the turn's first prompt did not carry it either, the Session having had it.
  assert.ok((await c.lab.write(c.ws, '/sleep 3')).accepted)
  await until('the turn running', async () => (await c.lab.state(c.ws)).active?.status === 'in_progress')
  const into = (await c.lab.command(c.ws, 'Write', { execution: c.e.id, session: c.e.session }, { prompt: [{ type: 'text', text: 'and this' }], mayWait: true })) as { accepted: boolean }
  assert.equal(into.accepted, true)
  const steering = await until('its steering line', async () => lines(await c.lab.entries(c.ws), 'out', '_session/steering').find((x) => x.rpc_kind === 'request'))
  assert.deepEqual((steering.content.params as { prompt: Block[] }).prompt.map((b) => b.text), ['and this'])
  await c.lab.turn(c.ws, 'done')
})

test('P5 the execution ended, its anchor restored by the next; one whose anchor was lost, the next opening a new Session with a catch-up: no block with the first; with the second the block, then the catch-up, then the message', async (t) => {
  const c = await started(t)
  await turn(c, 'mirabelle')
  const anchor = String((await end(c, c.e)).content.anchor)
  const second = await create(c)
  const opening = (await c.lab.entries(c.ws)).find((x) => x.kind === 'session.opened' && x.execution === second.id)!
  assert.equal(opening.content.origin, anchor)
  await turn(c, 'quetsche')
  assert.deepEqual((await prompts(c, second)).map((p) => p.map((b) => b.text)), [['quetsche']])
  // Lost: a new Session, which knows nothing of who it is.
  const lost = await started(t)
  await turn(lost, 'mirabelle')
  assert.equal((await end(lost, lost.e, true)).content.anchor, null)
  const next = await create(lost)
  assert.equal((await lost.lab.entries(lost.ws)).find((x) => x.kind === 'session.opened' && x.execution === next.id)!.content.origin, 'new')
  await turn(lost, 'prune')
  const [first] = await prompts(lost, next)
  assert.deepEqual([first!.length, isRole(first![0]), isCatchUp(first![1]), first![0]!.text, first![2]!.text], [3, true, true, BLOCK, 'prune'])
})

test('P6 a later Create carrying no role; one naming another role; one naming a role in a Workstream started with none: the Workstream’s role, its block given to the new Session; role_set; role_set', async (t) => {
  const c = await started(t)
  await turn(c, 'mirabelle')
  await end(c, c.e, true)
  assert.deepEqual(await c.lab.command(c.ws, 'Create', {}, { pool: 'mock-test', role: 'plain' }), { accepted: false, reason: 'role_set' })
  const second = await create(c)
  assert.equal(second.body.role, 'scout')
  await turn(c, 'quetsche')
  assert.ok((await prompts(c, second))[0]!.some(isRole))
  assert.equal((await view(c))?.role, 'scout')
  // The same role named again is the Workstream's own: accepted.
  await end(c, second, true)
  assert.equal((await create(c, { role: 'scout' })).body.role, 'scout')
  // A Workstream that started with no role takes none later.
  const none = await started(t, {})
  await turn(none, 'plain words')
  await end(none, none.e, true)
  assert.deepEqual(await none.lab.command(none.ws, 'Create', {}, { pool: 'mock-test', role: 'scout' }), { accepted: false, reason: 'role_set' })
  assert.equal((await create(none)).body.role, undefined)
})

test('P7 a first message that is a command, then a plain one: the command alone, first; the block with the next', async (t) => {
  const c = await started(t)
  await turn(c, '/recall')
  await turn(c, 'prune')
  await turn(c, 'abricot')
  const sent = await prompts(c, c.e)
  assert.deepEqual(sent.map((p) => p.some(isRole)), [false, true, false])
  assert.deepEqual(sent[0]!.map((b) => b.text), ['/recall'])
})

test('P8 an agent titling itself with the block’s first line: the title stays the message’s first line; another title of the agent’s replaces it', async (t) => {
  const c = await started(t)
  await turn(c, 'the real subject')
  await until('the first title', async () => (await view(c))?.title === 'the real subject')
  const titled = (title: string) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: c.e.acpId, update: { sessionUpdate: 'session_info_update', title } } })).toString('base64')
  await turn(c, `/raw ${titled(BLOCK.split('\n')[0]!)}`)
  await sleep(500)
  assert.equal((await view(c))?.title, 'the real subject')
  // The control: a title of its own is taken.
  await turn(c, `/raw ${titled('Scouting the tests')}`)
  await until('its own title', async () => (await view(c))?.title === 'Scouting the tests')
})

test('P9 a Workstream whose role has no card any more, a new Session opening: no block; its message sent as any; its role still its own', async (t) => {
  const c = await started(t)
  await turn(c, 'mirabelle')
  await end(c, c.e, true)
  c.roles.delete('scout')
  const second = await create(c)
  assert.equal(second.body.role, 'scout')
  await turn(c, 'quetsche')
  const [first] = await prompts(c, second)
  assert.deepEqual([first!.some(isRole), first!.at(-1)!.text], [false, 'quetsche'])
  assert.equal((await view(c))?.role, 'scout')
})

test('P10 its transcript, and the exchange a catch-up gives of it: the person’s lines the message alone, none of the persona', async (t) => {
  const c = await started(t)
  await turn(c, 'what do you see')
  await until('its user element', async () => (await users(c)).length === 1)
  // The mock agent repeats what it was given, the block included: that is the agent's line. The person's hold none of it.
  const transcript = (await c.db.admin.query('SELECT kind, text FROM transcript($1::uuid[]) ORDER BY line', [[c.ws]])).rows as { kind: string; text: string }[]
  assert.deepEqual(transcript.filter((line) => line.kind === 'user').map((line) => line.text), ['what do you see'])
  assert.match(transcript.find((line) => line.kind === 'agent')!.text, /your role, `scout`/, 'the control: the agent was given it')
  const entries = await c.lab.entries(c.ws)
  const [exchange] = exchangesOf(entries, dispatched(await c.lab.state(c.ws)))
  assert.equal(exchange!.user, 'what do you see')
})

// docs/specs/merge.md: the merge card — proposed by an agent holding a repository's write, or by its delegator, its
// state read from GitHub, merged from its Answer as the operator, cancelled by the person's message, carried out again
// after a restart. GitHub stands in: each pull request's state and every merge asked.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { compileProfiles, type GitHub, type MergeOutcome, type MergeState, type PullRequest } from '@agora/credentials'
import { keys } from '@agora/testkit'
import { createMcpServer, Merges, MergeRefused, project, type Entry } from '../src/index.ts'
import { FROM_META } from '../src/marks.ts'
import { database, expire, FakeKube, grants, Lab, opened, until } from './support.ts'

const REPO = 'octo/app'

class FakeGitHub implements GitHub {
  readonly merges: { repo: string; number: number; sha: string }[] = []
  readonly pulls = new Map<number, { pull: PullRequest; state: MergeState }>()
  answer: MergeOutcome = { merged: true, sha: 'f00d' }

  add(number: number, state: MergeState, change: Partial<PullRequest> = {}): void {
    const pull: PullRequest = { number, title: `Add feature ${String(number)}`, url: `https://github.com/${REPO}/pull/${String(number)}`, open: !['closed', 'merged'].includes(state), merged: state === 'merged', draft: false, base: 'main', head: `feat/${String(number)}`, sha: `head${String(number)}`, author: 'agora-contributor[bot]', mergeableState: null, mergeSha: state === 'merged' ? 'm3rg3d' : '', ...change }
    this.pulls.set(number, { pull, state })
  }
  async pull(_repo: string, number: number): Promise<PullRequest | null> {
    return this.pulls.get(number)?.pull ?? null
  }
  async state(_repo: string, number: number): Promise<{ state: MergeState; pull: PullRequest } | null> {
    return this.pulls.get(number) ?? null
  }
  async merge(repo: string, number: number, sha: string): Promise<MergeOutcome> {
    this.merges.push({ repo, number, sha })
    return this.answer
  }
}

async function card(t: { after(fn: () => Promise<void>): void }) {
  const context = await opened(t)
  const github = new FakeGitHub()
  const merges = new Merges(context.lab.workstreams, { github, maxAgeMs: 0 })
  const caller = { workstream: context.ws, execution: context.e.id, profiles: [`github:${REPO}:write`] }
  return { ...context, github, merges, caller }
}

/** The question element of the latest Ask. */
const question = (entries: readonly Entry[]) => {
  const ask = entries.filter((e) => e.kind === 'command' && e.content.kind === 'Ask').at(-1)
  return project(entries).find((o) => o.kind === 'element' && o.object.type === 'question' && o.object.position === ask?.position)?.object as Record<string, unknown> | undefined
}
const outcome = (lab: Lab, ws: string) => until('the outcome', async () => (await lab.entries(ws)).find((e) => e.kind === 'merge.merged' || e.kind === 'merge.refused'))
const agoraSaid = (entries: readonly Entry[]) =>
  entries
    .filter((e) => e.kind === 'command' && e.content.kind === 'Write')
    .map((e) => (e.content.body as { prompt: { text: string; _meta?: Record<string, unknown> }[] }).prompt)
    .filter((p) => p[0]?._meta?.[FROM_META] !== undefined)
    .map((p) => p.map((b) => b.text).join(' '))

test('G2 a proposal: the card from GitHub’s pull request, answered at once; refused for another repository, an unknown or closed pull request, a second card', async (t) => {
  const { lab, ws, github, merges, caller } = await card(t)
  github.add(7, 'review')
  github.add(8, 'closed')
  const answer = await merges.propose(caller, { repo: REPO, number: 7 })
  assert.match(answer, /^proposed octo\/app#7: the person merges it from the card/)
  const q = question(await lab.entries(ws))!
  assert.deepEqual([q.kind, q.status, q.title, q.repo, q.number, q.url], ['merge', 'pending', 'Add feature 7', REPO, 7, 'https://github.com/octo/app/pull/7'])
  assert.match(String(q.text), /\[octo\/app#7\]\(https:\/\/github\.com\/octo\/app\/pull\/7\) · `main ← feat\/7` · agora-contributor\[bot\]/)
  const refused = async (args: Record<string, unknown>, profiles = caller.profiles) => {
    try {
      await merges.propose({ ...caller, profiles }, args)
      return 'accepted'
    } catch (error) {
      assert.ok(error instanceof MergeRefused)
      return error.message
    }
  }
  assert.equal(await refused({ repo: 'octo/other', number: 7 }), 'not_allowed')
  assert.equal(await refused({ repo: REPO, number: 7 }, [`github:${REPO}:read`]), 'not_allowed')
  assert.equal(await refused({ repo: REPO, number: 99 }), 'not_found')
  assert.equal(await refused({ repo: REPO, number: 8 }), 'not_open')
  assert.equal(await refused({ repo: REPO, number: 7 }), 'question_pending')
  assert.equal(await refused({ repo: 'not a repo', number: 7 }), 'invalid_query: repo')
  // Only Agora asks for a merge card.
  assert.deepEqual(await lab.command(ws, 'Ask', {}, { kind: 'merge', title: 't', text: '', options: [{ optionId: 'merge', name: 'Merge', kind: 'allow_once' }], repo: REPO, number: 1, url: 'u' }), {
    accepted: false,
    reason: 'question_pending',
  })
})

test('G3 the card’s state as GitHub gives it; none without a pending card', async (t) => {
  const { lab, ws, github, merges, caller } = await card(t)
  assert.equal(await merges.state(ws), null)
  github.add(7, 'review')
  await merges.propose(caller, { repo: REPO, number: 7 })
  const position = String(question(await lab.entries(ws))!.position)
  assert.deepEqual(await merges.state(ws), { question: position, state: 'review', head: 'head7' })
  github.add(7, 'ready')
  assert.deepEqual(await merges.state(ws), { question: position, state: 'ready', head: 'head7' })
})

test('G4 Merge on a ready pull request: one squash merge of the head read, merge.merged, the agent told as Agora', async (t) => {
  const { lab, ws, github, merges, caller } = await card(t)
  github.add(7, 'ready')
  await merges.propose(caller, { repo: REPO, number: 7 })
  const position = String(question(await lab.entries(ws))!.position)
  assert.ok((await lab.command(ws, 'Answer', { question: position }, { optionId: 'merge' })).accepted)
  const done = await outcome(lab, ws)
  assert.deepEqual([done.kind, done.content], ['merge.merged', { question: position, sha: 'f00d' }])
  assert.deepEqual(github.merges, [{ repo: REPO, number: 7, sha: 'head7' }])
  const entries = await until('the agent told', async () => {
    const all = await lab.entries(ws)
    return agoraSaid(all).length > 0 ? all : null
  })
  assert.deepEqual(agoraSaid(entries), ['From Agora, not the person: Pull request octo/app#7 merged (squash): f00d.'])
  assert.deepEqual(question(entries)!.outcome, { merged: true, sha: 'f00d' })
  assert.equal(question(entries)!.status, 'answered')
})

test('G5 Merge on a pull request no longer ready, then GitHub refusing the merge: nothing merged, merge.refused with why', async (t) => {
  const { lab, ws, github, merges, caller } = await card(t)
  github.add(7, 'ready')
  await merges.propose(caller, { repo: REPO, number: 7 })
  let position = String(question(await lab.entries(ws))!.position)
  github.add(7, 'review')
  assert.ok((await lab.command(ws, 'Answer', { question: position }, { optionId: 'merge' })).accepted)
  let done = await outcome(lab, ws)
  assert.deepEqual([done.kind, done.content], ['merge.refused', { question: position, reason: 'waiting for a review' }])
  assert.deepEqual(github.merges, [])
  await until('the agent told', async () => agoraSaid(await lab.entries(ws)).includes('From Agora, not the person: Pull request octo/app#7 not merged: waiting for a review.'))
  await lab.turn(ws, 'done')
  // Again, GitHub refusing.
  github.add(7, 'ready')
  github.answer = { merged: false, reason: 'Repository rule violations found' }
  await merges.propose(caller, { repo: REPO, number: 7 })
  position = (await lab.state(ws)).question!.position
  assert.ok((await lab.command(ws, 'Answer', { question: position }, { optionId: 'merge' })).accepted)
  done = await until('the second outcome', async () => (await lab.entries(ws)).filter((e) => e.kind === 'merge.refused').at(1))
  assert.deepEqual(done.content, { question: position, reason: 'Repository rule violations found' })
})

test('G6 the person’s message while the card waits cancels it and goes to the agent as any', async (t) => {
  const { lab, ws, github, merges, caller } = await card(t)
  github.add(7, 'review')
  await merges.propose(caller, { repo: REPO, number: 7 })
  const position = String(question(await lab.entries(ws))!.position)
  const written = await lab.write(ws, 'fix the tests first')
  assert.ok(written.accepted, JSON.stringify(written))
  const entries = await lab.entries(ws)
  assert.ok(entries.some((e) => e.kind === 'question.cancelled' && (e.content as { question: string }).question === position))
  assert.equal(question(entries)!.status, 'cancelled')
  assert.equal((await lab.state(ws)).question, null)
  await lab.turn(ws, 'done')
  const prompts = (await lab.entries(ws)).filter((e) => e.kind === 'acp' && e.direction === 'out' && e.method === 'session/prompt')
  assert.ok(JSON.stringify(prompts.at(-1)?.content).includes('fix the tests first'))
  // The agent may propose again.
  assert.match(await merges.propose(caller, { repo: REPO, number: 7 }), /^proposed/)
})

test('G7 an Answer with no outcome, carried out as the server starts: merged once, a pull request already merged counted as merged', async (t) => {
  const { lab, ws, github, caller } = await card(t)
  github.add(7, 'ready')
  github.add(9, 'ready')
  const attached = lab.workstreams.merges!
  await attached.propose(caller, { repo: REPO, number: 7 })
  const first = String(question(await lab.entries(ws))!.position)
  // The engine gone, as with a process that stopped between the Answer and its outcome.
  lab.workstreams.merges = null
  assert.ok((await lab.command(ws, 'Answer', { question: first }, { optionId: 'merge' })).accepted)
  // Merged on GitHub meanwhile.
  github.add(7, 'merged')
  const again = new Merges(lab.workstreams, { github, maxAgeMs: 0 })
  await again.start()
  const done = await outcome(lab, ws)
  assert.deepEqual([done.kind, done.content], ['merge.merged', { question: first, sha: 'm3rg3d' }])
  assert.deepEqual(github.merges, [])
  await again.start()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await lab.entries(ws)).filter((e) => e.kind === 'merge.merged').length, 1, 'once')
  // Not merged yet: carried out.
  await until('the agent’s turn', async () => (await lab.state(ws)).question === null)
  await lab.turn(ws, 'done')
  await again.propose(caller, { repo: REPO, number: 9 })
  lab.workstreams.merges = null
  const position9 = String((await lab.state(ws)).question!.position)
  assert.ok((await lab.command(ws, 'Answer', { question: position9 }, { optionId: 'merge' })).accepted)
  const third = new Merges(lab.workstreams, { github, maxAgeMs: 0 })
  await third.start()
  await until('the second merge', async () => (await lab.entries(ws)).filter((e) => e.kind === 'merge.merged').length === 2)
  assert.deepEqual(github.merges, [{ repo: REPO, number: 9, sha: 'head9' }])
})

type T = { after(fn: () => Promise<void>): void }
type Text = { content: { type: string; text: string }[]; isError?: boolean }
const said = (result: unknown) => (result as Text).content.map((c) => c.text).join('\n')

/**
 * A lead: a Workstream whose execution holds `agora:delegate` alone, calling Agora's MCP server as its harness does —
 * the SDK's client, the execution named as the gateway names it —, with the delegation engine and the merge card; every
 * token signed recorded. `delegate` makes a `spawn_agent` call with rights beyond the lead's, which the person approves,
 * or refuses by writing.
 */
async function leading(t: T) {
  const pair = keys()
  const db = await database()
  const signer = grants([])
  const lab = await Lab.start({ db, kube: new FakeKube(pair.publicKey), keys: pair, credentials: signer.source, workstreams: { maxActive: 8 }, delegations: { approvalMs: 10_000, progressMs: 500 } })
  const github = new FakeGitHub()
  new Merges(lab.workstreams, { github, maxAgeMs: 0 })
  const mcp = createMcpServer(lab.workstreams, signer.key)
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve))
  const url = new URL(`http://127.0.0.1:${String((mcp.address() as AddressInfo).port)}/mcp`)
  t.after(async () => {
    await new Promise((resolve) => mcp.close(resolve))
    await lab.close()
    await db.drop()
  })
  const owner = randomUUID()
  const ws = await lab.workstream(owner)
  const e = await lab.open(ws, { profiles: ['agora:delegate'] })
  const client = async (execution: string) => {
    const c = new Client({ name: 'harness', version: '1.0.0' })
    // The grant the execution's bridge holds, as the gateway forwards it (docs/specs/mcp.md, "The caller").
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${signer.grantOf(execution)}` } } }))
    t.after(() => c.close())
    return c
  }
  const delegate = async (c: Client, rights: string[], refusal?: string, from = ws) => {
    const call = c.callTool({ name: 'spawn_agent', arguments: { instructions: `work with ${rights.join(', ')}`, harness: 'mock', rights } })
    const ask = await until('the approval', async () => (await lab.state(from)).question)
    const settled = refusal === undefined ? await lab.command(from, 'Answer', { question: ask.position }, { optionId: 'approve' }) : await lab.write(from, refusal)
    assert.ok(settled.accepted, JSON.stringify(settled))
    return said(await call)
  }
  const id = (answer: string) => /^started ([0-9a-f-]{36}) · /.exec(answer)?.[1] ?? assert.fail(`not started: ${answer}`)
  return { lab, owner, ws, e, github, signer, client, delegate, id }
}

test('G10 a lead with agora:delegate alone: propose_merge listed, not_allowed until it gave a delegate the write; then accepted on that repository alone, from a later execution, the card in its Workstream', async (t) => {
  const { lab, owner, ws, e, github, client, delegate, id } = await leading(t)
  github.add(7, 'review')
  const first = await client(e.id)
  assert.deepEqual((await first.listTools()).tools.map((tool) => tool.name), ['spawn_agent', 'send_message', 'stop_agent', 'list_agents', 'answer_agent', 'propose_merge'])
  const early = (await first.callTool({ name: 'propose_merge', arguments: { repo: REPO, number: 7 } })) as Text
  assert.deepEqual([said(early), early.isError], ['not_allowed', true])
  assert.equal((await lab.state(ws)).question, null, 'no card')
  // A write asked and refused by the person: no delegation.
  assert.equal(await delegate(first, ['github:octo/refused:write'], 'not that one'), 'refused: not that one')
  const dev = id(await delegate(first, [`github:${REPO}:write`]))
  const judge = id(await delegate(first, ['github:octo/infra:review']))
  // Another Workstream of the person's, giving its own delegate another repository's write.
  const elsewhere = await lab.workstream(owner)
  const theirs = await lab.open(elsewhere, { profiles: ['agora:delegate'] })
  id(await delegate(await client(theirs.id), ['github:octo/other:write'], undefined, elsewhere))
  // A later execution of the lead's Workstream, as when its lease ends between two turns.
  assert.ok((await lab.command(ws, 'Stop', { execution: e.id })).accepted)
  await expire(lab.kube, (await lab.state(ws)).current!.claimName)
  await until('the lead ended', async () => (await lab.state(ws)).current?.ended, 30_000)
  const later = await lab.open(ws, { profiles: ['agora:delegate'] })
  assert.notEqual(later.id, e.id)
  const c = await client(later.id)
  for (const repo of ['octo/refused', 'octo/infra', 'octo/other']) {
    const refused = (await c.callTool({ name: 'propose_merge', arguments: { repo, number: 7 } })) as Text
    assert.deepEqual([said(refused), refused.isError], ['not_allowed', true], repo)
  }
  assert.equal((await lab.state(ws)).question, null, 'no card')
  assert.match(said(await c.callTool({ name: 'propose_merge', arguments: { repo: REPO, number: 7 } })), /^proposed octo\/app#7: the person merges it from the card/)
  const q = question(await lab.entries(ws))!
  assert.deepEqual([q.kind, q.status, q.title, q.repo, q.number, q.url], ['merge', 'pending', 'Add feature 7', REPO, 7, 'https://github.com/octo/app/pull/7'])
  for (const other of [dev, judge]) assert.equal((await lab.state(other)).question, null, 'no card in a delegate’s Workstream')
})

test('G11 a lead that gave a delegate a write and proposed its merge: its profiles and every token signed for it agora:delegate alone, Agora’s MCP endpoint its only grant; its delegate’s token the write', async (t) => {
  const { lab, ws, e, github, signer, client, delegate, id } = await leading(t)
  github.add(7, 'review')
  const c = await client(e.id)
  const dev = id(await delegate(c, [`github:${REPO}:write`]))
  assert.match(said(await c.callTool({ name: 'propose_merge', arguments: { repo: REPO, number: 7 } })), /^proposed octo\/app#7:/)
  assert.equal(question(await lab.entries(ws))?.status, 'pending')
  assert.deepEqual((await lab.state(ws)).current!.profiles, ['agora:delegate'])
  const leads = signer.minted.filter((m) => m.label === `agora ${e.id}`)
  assert.ok(leads.length > 0, 'the lead’s token signed')
  for (const minted of leads) {
    assert.deepEqual(minted.profiles, ['agora:delegate'])
    assert.deepEqual(compileProfiles(minted.profiles).map((g) => [g.host, g.path]), [['mcp.agora.internal', '^/mcp$']])
  }
  // The control: a write given shows in the token signed for it.
  const devExecution = await until('the delegate’s execution', async () => (await lab.state(dev)).current)
  const devs = await until('the delegate’s token', () => {
    const found = signer.minted.filter((m) => m.label === `agora ${devExecution.id}`)
    return found.length > 0 ? found : null
  })
  for (const minted of devs) assert.deepEqual(minted.profiles, [`github:${REPO}:write`, 'agora:submit'])
  assert.ok(compileProfiles(devs[0]!.profiles).some((g) => g.host === 'api.github.com' && g.identity === 'contributor'))
})

// docs/specs/merge.md: the merge card — proposed by an agent holding a repository's write, its state read from GitHub,
// merged from its Answer as the operator, cancelled by the person's message, carried out again after a restart.
// GitHub stands in: each pull request's state and every merge asked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GitHub, MergeOutcome, MergeState, PullRequest } from '@agora/credentials'
import { Merges, MergeRefused, project, type Entry } from '../src/index.ts'
import { FROM_META } from '../src/marks.ts'
import { opened, until, type Lab } from './support.ts'

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

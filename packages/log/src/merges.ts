// The merge card (docs/specs/merge.md): an agent proposes the merge of a pull request it wrote; the person merges it
// from the card. GitHub holds the rule — who approves, who may update `main` —; Agora reads the pull request through
// the gateway with its own grant, shows what GitHub says of it, and merges it, squash, as the operator, when the
// person clicks and GitHub would merge it without the operator's bypass.
import { randomUUID } from 'node:crypto'
import type { GitHub, MergeState } from '@agora/credentials'
import type { Caller } from './delegation.ts'
import { FROM_META } from './marks.ts'
import { identity, object } from './json.ts'
import { REPO } from './questions.ts'
import { isMerge } from './state.ts'
import type { Workstreams } from './workstreams.ts'

/** What a tool answers instead of its result. */
export class Refused extends Error {}

/** What the card says of each state (docs/specs/merge.md, "The card"). */
export const STATE_TEXT: Readonly<Record<MergeState, string>> = {
  ready: 'ready to merge',
  review: 'waiting for a review',
  blocked: 'blocked by the repository’s rules',
  checks: 'checks failing or running',
  conflicts: 'conflicts with the base',
  behind: 'behind its base',
  draft: 'a draft',
  computing: 'GitHub is computing; read again',
  closed: 'closed',
  merged: 'merged',
}

export interface MergesOptions {
  readonly github: GitHub
  /** How long a card's state stands before GitHub is read again; 10 s. */
  readonly maxAgeMs?: number
}

export interface CardState {
  readonly question: string
  readonly state: MergeState
  readonly head: string
}

interface Card {
  readonly repo: string
  readonly number: number
}

export class Merges {
  private readonly workstreams: Workstreams
  private readonly options: MergesOptions
  private readonly read = new Map<string, { at: number; state: CardState }>()
  private readonly carrying = new Set<string>()

  constructor(workstreams: Workstreams, options: MergesOptions) {
    this.workstreams = workstreams
    this.options = options
    workstreams.merges = this
  }

  // ---------------------------------------------------------------- the proposal

  /** `propose_merge` (docs/specs/merge.md, "The proposal"): the card asked in the caller's Workstream; answered at once. */
  async propose(caller: Caller, args: Readonly<Record<string, unknown>>): Promise<string> {
    const repo = args.repo
    const number = args.number
    if (typeof repo !== 'string' || !REPO.test(repo)) throw new Refused('invalid_query: repo')
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) throw new Refused('invalid_query: number')
    if (!caller.profiles.includes(`github:${repo}:write`)) throw new Refused('not_allowed')
    const pull = await this.options.github.pull(repo, number)
    if (pull === null) throw new Refused('not_found')
    if (!pull.open) throw new Refused('not_open')
    const title = pull.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || `${repo}#${String(number)}`
    const asked = await this.workstreams.command(
      caller.workstream,
      {
        id: randomUUID(),
        kind: 'Ask',
        target: {},
        body: {
          kind: 'merge',
          title,
          text: `[${repo}#${String(number)}](${pull.url}) · \`${pull.base} ← ${pull.head}\` · ${pull.author}`,
          options: [{ optionId: 'merge', name: 'Merge', kind: 'allow_once' }],
          repo,
          number,
          url: pull.url,
        },
      },
      'agora',
    )
    if (!asked.accepted) throw new Refused(String(asked.reason ?? 'unavailable'))
    return `proposed ${repo}#${String(number)}: the person merges it from the card; what happens comes back to you as a message from Agora`
  }

  // ---------------------------------------------------------------- the card

  /** The pending card's state, read from GitHub at most once every `maxAgeMs` (docs/specs/merge.md, "The card"). */
  async state(workstream: string): Promise<CardState | null> {
    const question = (await this.workstreams.projections.store.state(workstream)).question
    if (!isMerge(question)) return null
    const known = this.read.get(question!.position)
    if (known && Date.now() - known.at < (this.options.maxAgeMs ?? 10_000)) return known.state
    const card = cardOf(object(question!.content.body))
    const read = await this.options.github.state(card.repo, card.number)
    const state: CardState = { question: question!.position, state: read?.state ?? 'closed', head: read?.pull.sha ?? '' }
    this.read.set(question!.position, { at: Date.now(), state })
    return state
  }

  // ---------------------------------------------------------------- the merge

  /** The Answer, carried out (docs/specs/merge.md, "The merge"): read again, merged when ready, the outcome told. */
  async answered(workstream: string, position: string): Promise<void> {
    const key = `${workstream}:${position}`
    if (this.carrying.has(key)) return
    this.carrying.add(key)
    try {
      const entries = await this.workstreams.projections.store.entries(workstream)
      if (entries.some((e) => (e.kind === 'merge.merged' || e.kind === 'merge.refused') && String(object(e.content)?.question) === position)) return
      const ask = entries.find((e) => e.position === position)
      if (!ask || !isMerge(ask)) return
      const card = cardOf(object(ask.content.body))
      const read = await this.options.github.state(card.repo, card.number)
      let outcome: { merged: true; sha: string } | { merged: false; reason: string }
      if (read === null) outcome = { merged: false, reason: 'not found' }
      else if (read.state === 'merged') outcome = { merged: true, sha: read.pull.mergeSha }
      else if (read.state !== 'ready') outcome = { merged: false, reason: STATE_TEXT[read.state] }
      else outcome = await this.options.github.merge(card.repo, card.number, read.pull.sha)
      this.read.delete(position)
      await this.workstreams.record(workstream, outcome.merged ? { kind: 'merge.merged', content: { question: position, sha: outcome.sha } } : { kind: 'merge.refused', content: { question: position, reason: outcome.reason } })
      const pr = `${card.repo}#${String(card.number)}`
      const words = outcome.merged ? `Pull request ${pr} merged (squash): ${outcome.sha}.` : `Pull request ${pr} not merged: ${outcome.reason}.`
      // Once, a restart included: the message's id is the card's.
      const id = identity(workstream, position, 'merge')
      const mark = { workstream, as: 'agora' as const }
      if (this.workstreams.delegations) await this.workstreams.delegations.write(workstream, id, mark, 'From Agora, not the person:', words)
      else
        await this.workstreams.command(
          workstream,
          { id, kind: 'Write', target: {}, body: { prompt: [{ type: 'text', text: 'From Agora, not the person:', _meta: { [FROM_META]: mark } }, { type: 'text', text: words }], mayWait: true } },
          'agora',
        )
    } finally {
      this.carrying.delete(key)
    }
  }

  /** At start: the Answers with no outcome are carried out (docs/specs/merge.md, "The merge": a restart). */
  async start(): Promise<void> {
    const left = await this.workstreams.projections.store.projector.query(
      "SELECT workstream, object->>'position' AS position FROM objects WHERE kind='element' AND type='question' AND object->>'kind'='merge' AND object->>'status'='answered' AND NOT (object ? 'outcome')",
    )
    for (const row of left.rows as { workstream: string; position: string }[]) void this.answered(row.workstream, row.position).catch(() => {})
  }
}

function cardOf(body: Record<string, unknown> | null): Card {
  return { repo: String(body?.repo ?? ''), number: Number(body?.number ?? 0) }
}

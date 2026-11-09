// The operator's GitHub, for the merge card (docs/specs/merge.md): a pull request read, its state as the card says it,
// its merge. Agora asks through the gateway, as an execution goes out, with a grant it signs for itself — the `merge`
// profile, bound to the server's own Pod address, identity `operator` — so it never holds the operator's credential.
import type { GrantSigner } from './grants.ts'
import { getThroughGateway, type GatewayGet } from './limits.ts'

export interface PullRequest {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly open: boolean
  readonly merged: boolean
  readonly draft: boolean
  readonly base: string
  readonly head: string
  /** The head's sha. */
  readonly sha: string
  readonly author: string
  /** GitHub's `mergeable_state`; null while it computes. */
  readonly mergeableState: string | null
  /** The merge commit's sha, once merged; empty otherwise. */
  readonly mergeSha: string
}

/** What the card says (docs/specs/merge.md, "The card"). */
export type MergeState = 'ready' | 'review' | 'blocked' | 'checks' | 'conflicts' | 'behind' | 'draft' | 'computing' | 'closed' | 'merged'

export type MergeOutcome = { readonly merged: true; readonly sha: string } | { readonly merged: false; readonly reason: string }

export interface GitHub {
  pull(repo: string, number: number): Promise<PullRequest | null>
  /** The pull request and its state; null when GitHub does not know it. */
  state(repo: string, number: number): Promise<{ state: MergeState; pull: PullRequest } | null>
  merge(repo: string, number: number, sha: string): Promise<MergeOutcome>
}

/** The table of docs/specs/merge.md, "The card": GitHub's `mergeable_state`, and whether a review approves the head. */
export function stateOf(pull: PullRequest, approvedOnHead: boolean): MergeState {
  if (pull.merged) return 'merged'
  if (!pull.open) return 'closed'
  if (pull.draft) return 'draft'
  switch (pull.mergeableState) {
    case 'clean':
    case 'has_hooks':
      return 'ready'
    case 'blocked':
      return approvedOnHead ? 'blocked' : 'review'
    case 'unstable':
      return 'checks'
    case 'dirty':
      return 'conflicts'
    case 'behind':
      return 'behind'
    case 'draft':
      return 'draft'
    default:
      return 'computing'
  }
}

export interface OperatorGitHubOptions {
  readonly signer: GrantSigner
  /** The server's own Pod address, which its grant is bound to. */
  readonly address: string
  readonly ca?: string
  readonly timeoutMs?: number
  readonly request?: (input: GatewayGet) => Promise<{ status: number; body: string }>
  readonly now?: () => number
}

const object = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export class OperatorGitHub implements GitHub {
  private readonly options: OperatorGitHubOptions
  private token: { value: string; until: number } | null = null

  constructor(options: OperatorGitHubOptions) {
    this.options = options
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const now = (this.options.now ?? Date.now)()
    if (this.token === null || this.token.until <= now) {
      const credentials = await this.options.signer.mint({ label: 'agora merge', ttlSeconds: 300, profiles: ['merge'], address: this.options.address })
      this.token = { value: credentials.token, until: (credentials.expiresAt === null ? now + 300_000 : Date.parse(credentials.expiresAt)) - 60_000 }
    }
    const answer = await (this.options.request ?? getThroughGateway)({
      proxy: this.options.signer.describe().proxy,
      token: this.token.value,
      host: 'api.github.com',
      path,
      method,
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: this.options.timeoutMs ?? 15_000,
      ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
    })
    let json: unknown = null
    try {
      json = answer.body === '' ? null : (JSON.parse(answer.body) as unknown)
    } catch {}
    return { status: answer.status, json }
  }

  async pull(repo: string, number: number): Promise<PullRequest | null> {
    const { status, json } = await this.call('GET', `/repos/${repo}/pulls/${String(number)}`)
    if (status === 404) return null
    if (status !== 200) throw new Error(`github: ${String(status)} ${String(object(json).message ?? '')}`)
    const p = object(json)
    return {
      number: Number(p.number),
      title: String(p.title ?? ''),
      url: String(p.html_url ?? ''),
      open: p.state === 'open',
      merged: p.merged === true,
      draft: p.draft === true,
      base: String(object(p.base).ref ?? ''),
      head: String(object(p.head).ref ?? ''),
      sha: String(object(p.head).sha ?? ''),
      author: String(object(p.user).login ?? ''),
      mergeableState: typeof p.mergeable_state === 'string' && p.mergeable_state !== 'unknown' ? p.mergeable_state : null,
      mergeSha: p.merged === true && typeof p.merge_commit_sha === 'string' ? p.merge_commit_sha : '',
    }
  }

  async state(repo: string, number: number): Promise<{ state: MergeState; pull: PullRequest } | null> {
    const pull = await this.pull(repo, number)
    if (pull === null) return null
    let approved = false
    if (pull.open && pull.mergeableState === 'blocked') {
      const { status, json } = await this.call('GET', `/repos/${repo}/pulls/${String(number)}/reviews?per_page=100`)
      if (status === 200 && Array.isArray(json)) approved = json.some((r) => object(r).state === 'APPROVED' && object(r).commit_id === pull.sha)
    }
    return { state: stateOf(pull, approved), pull }
  }

  async merge(repo: string, number: number, sha: string): Promise<MergeOutcome> {
    const { status, json } = await this.call('PUT', `/repos/${repo}/pulls/${String(number)}/merge`, { sha, merge_method: 'squash' })
    const answer = object(json)
    if (status === 200 && answer.merged === true) return { merged: true, sha: String(answer.sha ?? '') }
    return { merged: false, reason: String(answer.message ?? `GitHub answered ${String(status)}`).split('\n')[0]!.trim() }
  }
}

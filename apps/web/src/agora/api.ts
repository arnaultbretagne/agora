// The server's API (docs/specs/assistant-ui.md, "The exchanges", "Commands"). Pure of React; `fetch`
// is given, for the tests.
import { decode } from './stream.ts'
import type { Json } from './objects.ts'
import type { AccountLimits, AgentCommand, ListRow, Setting } from './view.ts'
import type { PromptCapabilities } from './attachments.ts'

export type CommandKind = 'Create' | 'Write' | 'Retract' | 'Cancel' | 'RespondPermission' | 'Configure' | 'Scope' | 'Stop' | 'Answer'

/** The identity the proxy passes, or none (docs/specs/log.md, "HTTP"). */
export interface Account {
  readonly email: string | null
}

/** A folder of the person's (docs/specs/log.md, "HTTP"): `agents`, the Workstreams of their runs' agents. */
export type Folder = 'agents'

/** The owner where the proxy passes no identity: the one the client creates with, and lists. */
export const NOBODY = '00000000-0000-4000-8000-000000000000'

/** A Workstream a search of the exchanges found (docs/specs/search.md, "Search"): its row and its latest matching line. */
export interface Hit {
  readonly row: ListRow
  readonly line: number
  readonly text: string
}

/** A page of a list (docs/specs/log.md, "The list"): its rows, and the next page's cursor or null. */
export interface Page {
  readonly rows: readonly ListRow[]
  readonly next: string | null
}

export interface Answer {
  readonly accepted: boolean
  readonly reason?: string
  /** The execution a Create started. */
  readonly execution?: string
}

export interface Pool {
  readonly name: string
  readonly harness: string
  readonly readyReplicas: number
  /** The settings its Sessions start with, as its catalogue entry declares them. */
  readonly sessionConfig?: readonly { readonly id: string; readonly value: string }[]
  /** What its last Session offered, or null: what a draft shows before it has a Session. */
  readonly settings?: readonly Setting[] | null
  readonly commands?: readonly AgentCommand[]
  /** What its last Session's agent accepted in a prompt beyond text, or null. */
  readonly promptCapabilities?: PromptCapabilities | null
  /** The profiles its Pods are warmed with: the accounts its executions draw from (docs/specs/credentials.md). */
  readonly baseProfiles?: readonly string[]
  /** Kept for the tests: not offered by the screen. */
  readonly testing?: boolean
}

export class Api {
  private readonly fetch: typeof fetch
  private readonly base: string

  constructor(base = '', fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.base = base
    this.fetch = fetcher
  }

  private async read(path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
    const response = await this.fetch(`${this.base}${path}`, init)
    const text = await response.text()
    return { status: response.status, body: (text === '' ? {} : decode(text)) as Json }
  }

  threadUrl(workstream: string, cursor: string): string {
    return `${this.base}/api/workstreams/${encodeURIComponent(workstream)}/thread?after=${encodeURIComponent(cursor)}`
  }

  /**
   * The caller's list, one of its folders', or a Workstream's sub-streams, from a cursor (docs/specs/log.md,
   * "The list"); the owner only counts without the proxy.
   */
  listUrl(folder: Folder | null, cursor: string, parent: string | null = null): string {
    const query = new URLSearchParams({ after: cursor, owner: NOBODY })
    if (folder !== null) query.set('folder', folder)
    if (parent !== null) query.set('parent', parent)
    return `${this.base}/api/workstreams/list?${query.toString()}`
  }

  /** The rows of a list older than `before` — the most recent without it —, those whose title holds `title` when given. */
  async page(folder: Folder | null, before: string | null, title = '', parent: string | null = null): Promise<Page> {
    const query = new URLSearchParams({ owner: NOBODY })
    if (folder !== null) query.set('folder', folder)
    if (parent !== null) query.set('parent', parent)
    if (before !== null) query.set('before', before)
    if (title.trim() !== '') query.set('title', title.trim())
    const { status, body } = await this.read(`/api/workstreams/page?${query.toString()}`)
    if (status !== 200) throw new Error(String(body.reason ?? 'unavailable'))
    return { rows: (Array.isArray(body.rows) ? body.rows : []) as ListRow[], next: typeof body.next === 'string' ? body.next : null }
  }

  /**
   * The Workstreams whose exchanges hold a text, as typed and ignoring case (docs/specs/search.md, "Search"):
   * the text is escaped, so that the pattern is the text itself.
   */
  async search(text: string): Promise<Hit[]> {
    const pattern = text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const query = new URLSearchParams({ pattern, ignore_case: 'true', head_limit: '50', owner: NOBODY })
    const { status, body } = await this.read(`/api/search?${query.toString()}`)
    if (status !== 200) throw new Error(String(body.reason ?? 'unavailable'))
    return (Array.isArray(body.results) ? body.results : []).flatMap((r) => {
      const result = r as { row?: ListRow | null; line?: unknown; text?: unknown }
      return result.row ? [{ row: result.row, line: Number(result.line), text: String(result.text ?? '') }] : []
    })
  }

  /** A Workstream's row (docs/specs/log.md, "HTTP"): its line, for the header; null before its first entry. */
  async row(workstream: string): Promise<ListRow | null> {
    const { status, body } = await this.read(`/api/workstreams/${encodeURIComponent(workstream)}/row`)
    return status === 200 ? (body as unknown as ListRow) : null
  }

  /** The pending merge card's state, read from GitHub (docs/specs/merge.md, "The card"); null without one. */
  async merge(workstream: string): Promise<{ question: string; state: string; head: string } | null> {
    const { status, body } = await this.read(`/api/workstreams/${encodeURIComponent(workstream)}/merge`)
    return status === 200 ? { question: String(body.question), state: String(body.state), head: String(body.head) } : null
  }

  /** Who the proxy says the caller is (docs/specs/log.md, "HTTP"). */
  async account(): Promise<Account> {
    const { body } = await this.read('/api/account')
    return { email: typeof body.email === 'string' ? body.email : null }
  }

  /** Whether a team can be launched from here (docs/specs/flows.md, "Launching from Agora"). */
  async teams(): Promise<boolean> {
    const { status, body } = await this.read('/api/teams')
    return status === 200 && body.available === true
  }

  /** A team on a goal, its lead's Workstream the id given: created by the server, which starts the run. */
  async team(id: string, goal: string): Promise<Answer> {
    try {
      const { status, body } = await this.read('/api/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, goal, owner: NOBODY }),
      })
      return status === 200 ? { accepted: true } : { accepted: false, reason: String(body.reason ?? 'unavailable') }
    } catch {
      return { accepted: false, reason: 'unreachable' }
    }
  }

  /** The profiles the access picker offers (docs/specs/credentials.md, "Offered profiles"). */
  async offered(): Promise<string[]> {
    const credentials = (await this.read('/api/config')).body.credentials as { offered?: unknown } | null | undefined
    return Array.isArray(credentials?.offered) ? credentials.offered.filter((p): p is string => typeof p === 'string') : []
  }

  async pools(): Promise<Pool[]> {
    return ((await this.read('/api/pools')).body.pools ?? []) as Pool[]
  }

  /** The accounts' limits, by base profile (docs/specs/credentials.md, "Limits"). */
  async limits(): Promise<Record<string, AccountLimits>> {
    return ((await this.read('/api/limits')).body.limits ?? {}) as unknown as Record<string, AccountLimits>
  }

  async create(id: string): Promise<Answer> {
    const { status, body } = await this.read('/api/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The owner is the proxy's identity; this one only stands in where there is none.
      body: JSON.stringify({ id, owner: NOBODY }),
    })
    return status === 200 ? { accepted: true } : { accepted: false, reason: String(body.reason ?? 'unavailable') }
  }

  /**
   * One command, with an id of the client's: after a network failure it is sent again with the same
   * id — replayed, it runs once. Its effect is read in the thread, never here.
   */
  async command(workstream: string, kind: CommandKind, target: Json, body: Json, id: string = crypto.randomUUID()): Promise<Answer> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { body: answer } = await this.read(`/api/workstreams/${encodeURIComponent(workstream)}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, kind, target, body }),
        })
        if (answer.accepted !== true) return { accepted: false, reason: String(answer.reason ?? 'unavailable') }
        return typeof answer.execution === 'string' ? { accepted: true, execution: answer.execution } : { accepted: true }
      } catch (error) {
        if (attempt === 2) return { accepted: false, reason: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'unreachable' }
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
  }
}

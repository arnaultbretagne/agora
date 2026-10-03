// The server's API (docs/specs/assistant-ui.md, "The exchanges", "Commands"). Pure of React; `fetch`
// is given, for the tests.
import { decode } from './stream.ts'
import type { Json } from './objects.ts'
import type { AgentCommand, Setting, WorkstreamView } from './view.ts'

export type CommandKind = 'Create' | 'Write' | 'Cancel' | 'RespondPermission' | 'Configure' | 'Stop'

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

  async workstreams(): Promise<WorkstreamView[]> {
    return ((await this.read('/api/workstreams')).body.workstreams ?? []) as WorkstreamView[]
  }

  async pools(): Promise<Pool[]> {
    return ((await this.read('/api/pools')).body.pools ?? []) as Pool[]
  }

  async create(id: string): Promise<Answer> {
    const { status, body } = await this.read('/api/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The owner is the proxy's identity; this one only stands in where there is none.
      body: JSON.stringify({ id, owner: '00000000-0000-4000-8000-000000000000' }),
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

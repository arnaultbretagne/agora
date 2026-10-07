// Reading a Workstream's thread (docs/specs/assistant-ui.md, "The exchanges"): server-sent events read
// with EventSource, parsed losslessly, applied to the objects. At its first error it is closed and
// opened again from the last cursor: 1 s, then doubling up to 10 s; left to itself, it would reopen from
// the address it started with. Not fetch: WebKit holds a streamed fetch body's small events back, and
// on an iPhone the snapshot's end never arrived. Pure of React; EventSource and the timers are given.
import { isSafeNumber, parse } from 'lossless-json'
import { apply, reopen, type ThreadRow, type ThreadState } from './objects.ts'

export type Connection = 'connecting' | 'connected' | 'offline'

export interface StreamOptions {
  /** The thread's address for a cursor. */
  readonly url: (cursor: string) => string
  readonly open?: (url: string) => EventSource
  /** Called with each new state, and the connection's. */
  readonly onChange: (state: ThreadState, connection: Connection) => void
  /** Delays before reopening, in milliseconds; the last repeats. */
  readonly delays?: readonly number[]
}

/** A number beyond 2^53 stays a decimal string: nothing is rounded on the way. */
export function decode(text: string): unknown {
  return parse(text, undefined, (value) => (isSafeNumber(value) ? Number(value) : value))
}

export class ThreadStream {
  private state: ThreadState
  private connection: Connection = 'connecting'
  private readonly options: StreamOptions
  private readonly abort = new AbortController()
  private attempt = 0

  constructor(initial: ThreadState, options: StreamOptions) {
    this.state = initial
    this.options = options
  }

  get current(): ThreadState {
    return this.state
  }

  start(): void {
    void this.run()
  }

  stop(): void {
    this.abort.abort()
  }

  private notify(connection: Connection): void {
    this.connection = connection
    this.options.onChange(this.state, this.connection)
  }

  private async run(): Promise<void> {
    const delays = this.options.delays ?? [1000, 2000, 4000, 8000, 10000]
    while (!this.abort.signal.aborted) {
      this.state = reopen(this.state)
      this.notify('connecting')
      await this.read()
      if (this.abort.signal.aborted) return
      this.notify('offline')
      const delay = delays[Math.min(this.attempt++, delays.length - 1)]!
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  /** One read, until its first error, a row it cannot apply, or the stop. */
  private read(): Promise<void> {
    return new Promise((resolve) => {
      const source = (this.options.open ?? ((url) => new EventSource(url)))(this.options.url(this.state.cursor))
      const end = () => {
        source.close()
        this.abort.signal.removeEventListener('abort', end)
        resolve()
      }
      source.onmessage = (event: MessageEvent<string>) => {
        try {
          this.state = apply(this.state, decode(event.data) as ThreadRow)
        } catch {
          return end()
        }
        if (this.state.complete) this.attempt = 0
        this.notify(this.state.complete ? 'connected' : 'connecting')
      }
      source.onerror = end
      this.abort.signal.addEventListener('abort', end)
    })
  }
}

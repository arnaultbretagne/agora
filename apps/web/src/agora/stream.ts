// Reading a Workstream's thread (docs/specs/assistant-ui.md, "The exchanges"): server-sent events read
// with fetch — EventSource would reopen on its own, from the address it started with, not from the
// cursor — parsed losslessly, applied to the objects, and opened again from the last cursor after a
// cut: 1 s, then doubling up to 10 s. Pure of React; `fetch` and the timers are given.
import { isSafeNumber, parse } from 'lossless-json'
import { apply, reopen, type ThreadRow, type ThreadState } from './objects.ts'

export type Connection = 'connecting' | 'connected' | 'offline'

export interface StreamOptions {
  /** The thread's address for a cursor. */
  readonly url: (cursor: string) => string
  readonly fetch?: typeof fetch
  /** Called with each new state, and the connection's. */
  readonly onChange: (state: ThreadState, connection: Connection) => void
  /** Delays before reopening, in milliseconds; the last repeats. */
  readonly delays?: readonly number[]
}

/** A number beyond 2^53 stays a decimal string: nothing is rounded on the way. */
export function decode(text: string): unknown {
  return parse(text, undefined, (value) => (isSafeNumber(value) ? Number(value) : value))
}

/** Splits a stream of server-sent events into the data of each. */
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const event = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data !== '') yield data
    }
  }
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
      try {
        const response = await (this.options.fetch ?? fetch)(this.options.url(this.state.cursor), {
          headers: { accept: 'text/event-stream' },
          signal: this.abort.signal,
        })
        if (!response.ok || response.body === null) throw new Error(`thread answered ${String(response.status)}`)
        for await (const data of events(response.body)) {
          this.state = apply(this.state, decode(data) as ThreadRow)
          if (this.state.complete) this.attempt = 0
          this.notify(this.state.complete ? 'connected' : 'connecting')
        }
      } catch {
        if (this.abort.signal.aborted) return
      }
      if (this.abort.signal.aborted) return
      this.notify('offline')
      const delay = delays[Math.min(this.attempt++, delays.length - 1)]!
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

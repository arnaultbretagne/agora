// Deadlines for calls that must not outlive the tick that made them (S13, P7).
//
// Everything the control plane says to an adapter happens inside a verb execution, and a verb
// execution holds the Workstream's claim and, usually, a database client. A call with no deadline
// therefore does not merely wait: it holds the claim until the lease expires, holds the client for
// ever, and after a handful of them the pool is empty and EVERY tick blocks in `pool.connect()`
// with nothing to see server-side. That is what the first live deployment reached, and the symptom
// — a silent worker with a claimed work row — says nothing about the cause.
//
// The one thing deliberately NOT bounded by this is a prompt turn: a model answering for three
// minutes is working, not hung. Control calls (list, new, resume, set_session_config) are bounded,
// because none of them has any reason to take longer than an adapter needs to answer at all.

/** Rejects if `work` has not settled inside `timeoutMs`. `undefined` leaves the call unbounded, which only a test should choose. */
export async function within<T>(work: Promise<T>, timeoutMs: number | undefined, what: string): Promise<T> {
  if (timeoutMs === undefined) return work
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AdapterTimeoutError(what, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class AdapterTimeoutError extends Error {
  readonly code = 'adapter_timeout'

  constructor(readonly what: string, readonly timeoutMs: number) {
    super(`${what} did not answer within ${String(timeoutMs)}ms`)
    this.name = 'AdapterTimeoutError'
  }
}

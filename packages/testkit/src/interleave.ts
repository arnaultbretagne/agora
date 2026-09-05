// Scripted-concurrency harness: named one-shot latches let tests pause a worker, executor or
// transaction at a chosen point, run the racing side, then resume — forcing the interleavings the
// acceptance scenarios describe (process pauses, clock advances are handled by the clock).
export interface Latch {
  readonly released: Promise<void>
  release(): void
  readonly isReleased: boolean
}

export function latch(): Latch {
  let release!: () => void
  let isReleased = false
  const released = new Promise<void>((resolve) => {
    release = () => {
      isReleased = true
      resolve()
    }
  })
  return { released, release, get isReleased() { return isReleased } }
}

/** Wait until the latch is released; a timeout turns a stuck interleaving into a failure. */
export async function holdAt(l: Latch, timeoutMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      l.released,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('interleave latch was never released')), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

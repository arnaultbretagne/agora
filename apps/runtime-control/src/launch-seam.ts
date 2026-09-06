// Launch seam (execution.md — Session birth and admission): the harness container waits on the
// seam until the control plane confirms the Agora Session exists. A process restart inside the Pod
// produces a new generation — the old incarnation's evidence is invalid, no silent reuse (SESSION-A06).
import { createHash } from 'node:crypto'

export interface SeamState {
  readonly incarnation: string
  readonly generation: number
  readonly released: boolean
  readonly sessionId: string | null
  readonly processGeneration: number
}

export class LaunchSeam {
  readonly #incarnation: string
  #generation = 0
  #processGeneration = 0
  #released = false
  #sessionId: string | null = null

  constructor(incarnation: string) {
    this.#incarnation = incarnation
  }

  /** The Pod reports a process restart: evidence invalidates and the incarnation retires. */
  processRestart(): { readonly incarnation: string; readonly generation: number } {
    this.#processGeneration += 1
    this.#generation += 1
    this.#released = false
    this.#sessionId = null
    return { incarnation: `${this.#incarnation}#${this.#processGeneration}`, generation: this.#generation }
  }

  /** Birth-then-release ordering: the release is refused until a Session id is bound. */
  release(sessionId: string): boolean {
    if (this.#sessionId === null) {
      this.#sessionId = sessionId
      this.#released = true
      return true
    }
    return this.#sessionId === sessionId && this.#released
  }

  state(): SeamState {
    return {
      incarnation: this.#incarnation,
      generation: this.#generation,
      released: this.#released,
      sessionId: this.#sessionId,
      processGeneration: this.#processGeneration,
    }
  }
}

/** The admitted spec digest: what the API server admitted, not what a request asked for. */
export function admittedSpecDigest(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}

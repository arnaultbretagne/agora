/**
 * One prompt turn in flight per Session, ever.
 *
 * WHY THIS EXISTS, from a real incident (2026-08-09). An operator sent three more messages while a
 * Session was still working. Nothing stopped them: `handlePromptSession` dispatched each one
 * straight to the Agent. The Agent was `codex`, which folds extra prompts into the running turn
 * and answers them — but never answers their JSON-RPC requests. So three `session/prompt` calls
 * never returned, three Commands stayed `dispatching` and three turns stayed `running` forever.
 * A turn with no `ended_at` makes a Session ineligible for the idle reaper (`listIdleSessions`),
 * so the Session was still holding a Pod eleven hours later, immune to collection.
 *
 * WHY A QUEUE RATHER THAN A REFUSAL. docs/specs/03 line 60 already said "only one prompt turn may
 * be in flight per Session in v1", and its steps 5/8 already said to mark the Session `busy`; both
 * were simply never implemented. Refusing the second prompt would satisfy the spec, but the four
 * ACP Agents we can actually launch were measured on 2026-08-10 (see
 * `docs/acp-concurrent-prompt-behaviour.md`) and every one of them accepts a concurrent prompt —
 * each mishandling it in its own way, including one that silently truncates the running turn and
 * still reports `end_turn`. There is no portable behaviour to build on, so the product does not
 * expose the concurrency at all: it takes the message, and sends it when the Agent is free.
 *
 * WHY IN MEMORY. This serializes dispatch, and dispatch requires the live ACP connection, which is
 * itself process-local by construction (`connections.ts`, ADR 0012). A queue outliving the process
 * would be a queue for a connection that no longer exists. What IS durable is each queued prompt's
 * Command row, `accepted` in Postgres from the moment the API answers — so nothing a user typed is
 * lost on a restart, it is visible and settleable. `failStrandedPromptCommands` is the other half
 * of that contract: it settles them at startup instead of leaving them `accepted` forever.
 */
export class SessionPromptQueue {
  /** Tail of each Session's chain. Absent means idle — the entry is dropped when the chain drains. */
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly waiting = new Map<string, number>()

  /**
   * Runs `task` after every task already queued for this Session has settled.
   *
   * The returned promise is the caller's own result. Callers that answer an HTTP request must NOT
   * await it — that is the point of the split: the API answers on `acceptPrompt`, and the turn
   * runs here. They must still attach a rejection handler, which `runDetached` does for them.
   */
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    this.waiting.set(sessionId, (this.waiting.get(sessionId) ?? 0) + 1)

    // A predecessor that rejected must not cancel its successors: one failed turn cannot be
    // allowed to strand every message typed after it (that is the same wedge, one level up).
    const result = previous.then(
      () => task(),
      () => task(),
    )

    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    const tail = settled.then(() => {
      const left = (this.waiting.get(sessionId) ?? 1) - 1
      if (left > 0) {
        this.waiting.set(sessionId, left)
      } else {
        // Idle: drop both entries so a long-lived process does not accumulate one resolved
        // promise per Session it has ever served.
        this.waiting.delete(sessionId)
        if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
      }
    })
    this.tails.set(sessionId, tail)
    return result
  }

  /** `run`, for callers that are answering something else and will never look at the outcome. */
  runDetached(sessionId: string, task: () => Promise<unknown>, onError: (error: unknown) => void): void {
    this.run(sessionId, task).catch(onError)
  }

  /** How many prompts are queued or running for this Session. 0 means the Agent is free. */
  depth(sessionId: string): number {
    return this.waiting.get(sessionId) ?? 0
  }

  /** Resolves when this Session's chain has drained. Exists so tests never poll. */
  async drain(sessionId: string): Promise<void> {
    let tail = this.tails.get(sessionId)
    while (tail) {
      await tail
      const next = this.tails.get(sessionId)
      if (next === tail) break
      tail = next
    }
  }
}

import type { RuleId, Verb } from '@agora/domain'

export interface VerbContext {
  readonly workstreamId: string
  readonly intentSeq: number
  readonly workGeneration: number
  readonly claimToken: string
  readonly rule: RuleId
}

export interface VerbExecutor {
  execute(verb: Verb, context: VerbContext): Promise<void>
}

export class RecordingVerbExecutor implements VerbExecutor {
  readonly calls: Array<{ verb: Verb; context: VerbContext }> = []
  readonly failures = new Map<Verb, () => Error>()

  failWith(verb: Verb, error: () => Error): this {
    this.failures.set(verb, error)
    return this
  }

  async execute(verb: Verb, context: VerbContext): Promise<void> {
    this.calls.push({ verb, context })
    const failure = this.failures.get(verb)
    if (failure !== undefined) throw failure()
  }
}

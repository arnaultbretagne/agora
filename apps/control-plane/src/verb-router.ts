// Routes each verb to the executor that actually knows it (S8): BUILD/TURN_OFF/GRANT/REVOKE go
// through the owner-request path (session-opener wrapping OwnerVerbRunner); START goes through the
// real ACP bridge instead — OwnerVerbRunner itself throws UnwiredVerbError for it (packages/engine
// deliberately has no owner-request shape for an ACP-facing verb). Verbs neither table names
// (SET_MODEL/SET_EFFORT/RESTORE/REFILL, still S8 Step 3+/S9) fall through to the owner-request path
// too, purely to get OwnerVerbRunner's own typed UnwiredVerbError rather than inventing a second one.
import type { Verb } from '@agora/domain'
import type { VerbContext, VerbExecutor } from '@agora/engine'

export function createVerbRouter(routes: Partial<Record<Verb, VerbExecutor>>, fallback: VerbExecutor): VerbExecutor {
  return {
    async execute(verb: Verb, context: VerbContext): Promise<void> {
      const executor = routes[verb] ?? fallback
      await executor.execute(verb, context)
    },
  }
}

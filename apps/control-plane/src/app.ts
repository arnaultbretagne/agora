import type pg from 'pg'
import { createPool, requireDatabaseUrl } from '@agora/store-pg'
import { bootstrapSession, cancelSession, promptSession, type BootstrapSessionInput, type PromptSessionInput } from '@agora/acp'

/**
 * The minimal internal API this plan promises later plans (docs/specs, plans/03 exit criteria:
 * "P05 and P06 have stable application interfaces"). No HTTP server here — that is P05's "Web and
 * projections" layer; this is the composition root a deployable's entry point would call into.
 */
export interface ControlPlane {
  readonly pool: pg.Pool
  readonly bootstrapSession: (input: Omit<BootstrapSessionInput, 'pool'>) => ReturnType<typeof bootstrapSession>
  readonly promptSession: (input: Omit<PromptSessionInput, 'pool'>) => ReturnType<typeof promptSession>
  readonly cancelSession: typeof cancelSession
}

export function createControlPlane(pool: pg.Pool = createPool(requireDatabaseUrl())): ControlPlane {
  return {
    pool,
    bootstrapSession: (input) => bootstrapSession({ pool, ...input }),
    promptSession: (input) => promptSession({ pool, ...input }),
    cancelSession,
  }
}

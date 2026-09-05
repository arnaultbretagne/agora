// Control-plane process (S2): HTTP API and reconciliation worker in one process, with a mode flag
// to run either alone. No external system is mutated before later slices: the worker observes
// through a source that reports every field unavailable (no invented evidence, engine contract)
// and carries no verb executor, so rules can only schedule work, never act.
import { createPool, requireDatabaseUrl, createScan, startTickSource, type VerbExecutor } from '@agora/engine'
import type { ObservationSource } from '@agora/engine'
import type { Acquired, ObservationFieldName, ObservationReader } from '@agora/domain'
import { createControlPlaneServer } from './http.js'

const UNAVAILABLE: Acquired<never> = { ok: false, reason: 'unavailable' }

class UnavailableObservationSource implements ObservationSource {
  reader(): ObservationReader {
    const read = (_field: ObservationFieldName): Acquired<never> => UNAVAILABLE
    return {
      power: () => read('observation.power'),
      construction: () => read('observation.construction'),
      session: () => read('observation.session'),
      anchor: () => read('observation.anchor'),
      sync: () => read('observation.sync'),
      model: () => read('observation.model'),
      effort: () => read('observation.effort'),
      grantsAttached: () => read('observation.grants.attached'),
      grantsEffective: () => read('observation.grants.effective'),
    }
  }
}

class NoVerbExecutor implements VerbExecutor {
  async execute(): Promise<void> {
    throw new Error('no verb executor is wired before the runtime slices')
  }
}

export interface MainOptions {
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

export async function run(options: MainOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const args = options.args ?? process.argv.slice(2)
  const mode = args.includes('--api-only') ? 'api' : args.includes('--worker-only') ? 'worker' : (env.AGORA_MODE ?? 'both')
  const databaseUrl = requireDatabaseUrl(env)
  const port = Number(env.PORT ?? 8080)
  const pollIntervalMs = Number(env.TICK_POLL_MS ?? 5_000)

  const productPool = createPool(databaseUrl)
  const enginePool = createPool(databaseUrl)

  if (mode === 'api' || mode === 'both') {
    const server = createControlPlaneServer({ productPool, enginePool })
    await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve))
    console.log(`control plane API listening on :${port}`)
  }
  if (mode === 'worker' || mode === 'both') {
    const scan = createScan({
      pool: enginePool,
      observationSource: new UnavailableObservationSource(),
      executor: new NoVerbExecutor(),
      resolve: { harnessDigest: () => '', capabilityGrants: () => new Set() },
      logger: (message) => console.log(message),
    })
    const ticks = await startTickSource({
      pool: enginePool,
      connectionString: databaseUrl,
      scan: async () => {
        await scan()
      },
      pollIntervalMs,
    })
    console.log(`reconciliation worker scanning every ${pollIntervalMs}ms`)
    const stop = async (): Promise<void> => {
      await ticks.stop()
      await enginePool.end()
      await productPool.end()
      process.exit(0)
    }
    process.on('SIGINT', () => void stop())
    process.on('SIGTERM', () => void stop())
  } else {
    process.on('SIGINT', () => void process.exit(0))
    process.on('SIGTERM', () => void process.exit(0))
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  run().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}

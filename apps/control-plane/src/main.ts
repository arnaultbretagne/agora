// Control-plane process (S2, wired to the real owners in S8): HTTP API and reconciliation worker
// in one process, with a mode flag to run either alone.
import { createPool, requireDatabaseUrl, createScan, startTickSource, OwnerVerbRunner, type VerbExecutor } from '@agora/engine'
import type { ObservationSource } from '@agora/engine'
import type { Acquired, ObservationFieldName, ObservationReader } from '@agora/domain'
import { createControlPlaneServer } from './http.js'
import { AgentChannels } from './agent-channel.js'
import { loadCatalogueView, catalogueRevisionSet, loadHarnessDigests, loadBridgePort } from './catalogue.js'
import { HttpObservationSource } from './observation-source.js'
import { createHttpOwnerTransport } from './owner-transport.js'
import { createSessionOpeningExecutor } from './session-opener.js'
import { createStartExecutor } from './verbs/start.js'
import { createSetConfigExecutor } from './verbs/set-config.js'
import { createVerbRouter } from './verb-router.js'

const UNAVAILABLE: Acquired<never> = { ok: false, reason: 'unavailable' }

/** Before HARNESS_DEFINITIONS_PATH/POLICY_CAPABILITIES_PATH/RUNTIME_CONTROL_URL/BROKER_URL are all configured, every field is unavailable — rules can only schedule work, never act, exactly as S2 always did. */
class UnavailableObservationSource implements ObservationSource {
  async reader(): Promise<ObservationReader> {
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

  const harnessDefinitionsPath = env.HARNESS_DEFINITIONS_PATH
  const capabilitiesPath = env.POLICY_CAPABILITIES_PATH
  const catalogue = harnessDefinitionsPath && capabilitiesPath ? loadCatalogueView(harnessDefinitionsPath, capabilitiesPath) : undefined
  const revisionSet = harnessDefinitionsPath && capabilitiesPath ? catalogueRevisionSet(harnessDefinitionsPath, capabilitiesPath) : undefined
  const harnessDigests = harnessDefinitionsPath ? loadHarnessDigests(harnessDefinitionsPath) : undefined
  const runtimeSettingsPath = env.RUNTIME_SETTINGS_PATH
  const bridgePort = runtimeSettingsPath ? loadBridgePort(runtimeSettingsPath) : undefined

  // Computed once, shared by the API side's admission checklist (S8 Step 4) and the worker's own
  // reconciliation scan — both must agree on exactly the same fresh evidence and resolve.
  const runtimeControlBaseUrl = env.RUNTIME_CONTROL_URL
  const brokerBaseUrl = env.BROKER_URL
  const wired = runtimeControlBaseUrl !== undefined && brokerBaseUrl !== undefined && harnessDigests !== undefined && bridgePort !== undefined
  const observationSource: ObservationSource = wired
    ? new HttpObservationSource({
        pool: enginePool,
        productPool,
        runtimeControlBaseUrl,
        brokerBaseUrl,
        bridgePort,
        harnessCatalogue: harnessDigests.map((d) => ({ imageDigest: d.imageDigest })),
        logger: (message) => console.log(message),
      })
    : new UnavailableObservationSource()
  // resolve.harnessDigest is a real, static catalogue lookup — resolve.capabilityGrants stays
  // empty: computing it needs the SAME live OneCLI resolution only apps/broker's own compile step
  // has (packages/policy compile()), and RuleResolution.capabilityGrants is synchronous (domain's
  // evaluate() is called without awaiting it) — an explicit, documented gap, not a guess. CAPS rule
  // rows that need it stay unavailable until a caching bridge exists (admission never converges
  // through them either, honestly, rather than fabricating a grant read).
  const resolve = {
    harnessDigest: (harness: string) => harnessDigests?.find((d) => d.harnessId === harness)?.imageDigest ?? '',
    capabilityGrants: () => new Set<never>(),
  }

  if (mode === 'api' || mode === 'both') {
    const channels = new AgentChannels({ pool: productPool, logger: (message) => console.log(message) })
    const server = createControlPlaneServer({
      productPool,
      enginePool,
      channels,
      ...(catalogue ? { catalogue } : {}),
      ...(revisionSet ? { revisionSet } : {}),
      ...(wired ? { admission: { observationSource, resolve } } : {}),
    })
    await new Promise<void>((ready) => server.listen(port, '0.0.0.0', ready))
    console.log(`control plane API listening on :${port}`)
  }
  if (mode === 'worker' || mode === 'both') {
    const executor: VerbExecutor = wired
      ? createVerbRouter(
          {
            START: createStartExecutor({ productPool, runtimeControlBaseUrl, bridgePort, logger: (message) => console.log(message) }),
            SET_MODEL: createSetConfigExecutor({ productPool, enginePool, runtimeControlBaseUrl, bridgePort, logger: (message) => console.log(message) }),
            SET_EFFORT: createSetConfigExecutor({ productPool, enginePool, runtimeControlBaseUrl, bridgePort, logger: (message) => console.log(message) }),
          },
          createSessionOpeningExecutor({
            inner: new OwnerVerbRunner({ pool: enginePool, transport: createHttpOwnerTransport({ runtimeControlBaseUrl, brokerBaseUrl }), logger: (message) => console.log(message) }),
            productPool,
            enginePool,
            runtimeControlBaseUrl,
            logger: (message) => console.log(message),
          }),
        )
      : new NoVerbExecutor()

    const scan = createScan({
      pool: enginePool,
      observationSource,
      executor,
      resolve,
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
    console.log(`reconciliation worker scanning every ${pollIntervalMs}ms${wired ? '' : ' (owners unwired: observation unavailable, no verb executor)'}`)
    const stop = async (): Promise<void> => {
      await ticks.stop()
      await enginePool.end()
      await productPool.end()
      process.exit(0)
    }
    process.on('SIGINT', () => void stop())
    process.on('SIGTERM', () => void stop())
  } else if (mode === 'api') {
    process.on('SIGINT', () => void process.exit(0))
    process.on('SIGTERM', () => void process.exit(0))
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

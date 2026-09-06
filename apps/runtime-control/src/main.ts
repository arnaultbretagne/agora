// Runtime-control entrypoint (S6): owner API, Pod watch feeding the engine's wake source, and a
// bounded reconciliation sweep — one deployable (ADR 0001) whose only Kubernetes authority is Pods
// (plus read-only Nodes, for P6 fencing evidence).
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { HttpK8sClient } from './k8s-client.js'
import { PgObligationStore, sweepRetirementObligations } from './retirement.js'
import { LaunchSeam } from './launch-seam.js'
import { createOwnerApi } from './owner-api.js'
import { PgOwnerGate } from '@agora/owner-requests'
import { loadHarnessDefinitions, loadRuntimeSettings, type RuntimeSettings } from './k8s-pod-spec.js'
import { LABEL_APP, LABEL_WORKSTREAM } from './k8s-labels.js'
import { WakeLog } from './wakes.js'
import type { K8sClient } from './k8s-client.js'

const SWEEP_INTERVAL_MS = 30_000

export interface MainOptions {
  readonly env?: NodeJS.ProcessEnv
}

export function main(options: MainOptions = {}): { readonly stop: () => void } {
  const env = options.env ?? process.env
  const settings: RuntimeSettings = loadRuntimeSettings(env.RUNTIME_SETTINGS_PATH ?? '/etc/agora/runtime-settings.json')
  const harnesses = loadHarnessDefinitions(env.HARNESS_DEFINITIONS_PATH ?? '/etc/agora/harness-definitions.json')
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const bridgeAuthSecret = env.BRIDGE_AUTH_SECRET
  if (!bridgeAuthSecret) throw new Error('BRIDGE_AUTH_SECRET is required')

  const pool = new pg.Pool({ connectionString: databaseUrl })
  const k8s = new HttpK8sClient({ namespace: settings.namespace })
  const obligations = new PgObligationStore(pool)
  const seams = new Map<string, LaunchSeam>()
  const gate = new PgOwnerGate(pool, 'runtime-control')
  const wakes = new WakeLog()

  const server = createOwnerApi({ k8s, obligations, seams, gate, harnesses, settings, wakes, bridgeAuthSecret })
  server.listen(Number(env.PORT ?? 8090), '0.0.0.0', () => {
    console.log(`runtime-control owner API on :${env.PORT ?? 8090}`)
  })

  const watch = runWatchLoop(k8s, wakes, (message) => console.error(message))
  const sweepTimer = setInterval(() => {
    void sweepRetirementObligations(k8s, obligations).catch((error: unknown) => console.error('retirement sweep failed', error))
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()

  return {
    stop: () => {
      watch.stop()
      clearInterval(sweepTimer)
      server.close()
      void pool.end()
    },
  }
}

/**
 * Watches every Agora-managed Pod across the namespace and pushes its Workstream id to the wake
 * log on each event. A 410 Gone (or any transport failure) relists from scratch (resourceVersion
 * '') and resumes — the wake log's own cursor discipline covers callers that polled through the gap.
 */
function runWatchLoop(k8s: K8sClient, wakes: WakeLog, onError: (message: string) => void): { stop: () => void } {
  let stopped = false
  void (async () => {
    let resourceVersion = ''
    while (!stopped) {
      try {
        if (resourceVersion === '') {
          const list = await k8s.listPods(`${LABEL_APP}=runtime-controlled`)
          resourceVersion = list.metadata?.resourceVersion ?? ''
          for (const pod of list.items) pushWorkstream(wakes, pod)
        }
        for await (const event of k8s.watchPods(`${LABEL_APP}=runtime-controlled`, resourceVersion)) {
          if (stopped) break
          pushWorkstream(wakes, event.object)
          if (event.resourceVersion !== null) resourceVersion = event.resourceVersion
        }
      } catch (error) {
        onError(`runtime-control watch lost, relisting: ${error instanceof Error ? error.message : String(error)}`)
        resourceVersion = '' // relist unconditionally — a lost watch cannot resume a stale cursor.
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
  })()
  return {
    stop: () => {
      stopped = true
    },
  }
}

function pushWorkstream(wakes: WakeLog, pod: Record<string, unknown>): void {
  const workstreamId = (pod['metadata'] as { labels?: Record<string, string> } | undefined)?.labels?.[LABEL_WORKSTREAM]
  if (workstreamId !== undefined) wakes.push(workstreamId)
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  main()
}

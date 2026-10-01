import type { CredentialSource, KubeApi } from '@agora/executions'
import type { DriverOptions } from './driver.ts'
import type { LogStore } from './store.ts'
import { uuid } from './json.ts'

/** Assigned-execution base grants for the admin lab; pool warmup and resource bindings are separate. */
export function gatewayCredentials(store: LogStore, kube: KubeApi, source: CredentialSource):
  NonNullable<DriverOptions['credentials']> {
  return async (workstream, execution) => {
    const current = (await store.state(uuid(workstream))).current
    if (!current || current.id !== uuid(execution) || current.stopped || current.ended || current.lost || current.failed)
      throw new Error('execution_unavailable')
    const pool = (await kube.listPools('agora.bretagne.dev/harness'))
      .find((candidate) => candidate.metadata.name === current.body.pool)
    const harness = pool?.metadata.labels?.['agora.bretagne.dev/harness']
    if (harness === 'mock') return null
    if (harness !== 'claude-code') throw new Error('unreviewed_harness')
    return source.mint({ label: `agora ${current.id}`, ttlSeconds: 3600, profiles: ['anthropic'] })
  }
}

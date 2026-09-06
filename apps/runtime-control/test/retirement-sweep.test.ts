import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTestDatabase } from '@agora/testkit'
import { PgObligationStore, sweepRetirementObligations } from '../src/retirement.js'
import type { K8sClient, K8sObject } from '../src/k8s-client.js'

class FakeK8sClient implements K8sClient {
  readonly namespace = 'agora-runs'
  constructor(
    private readonly pods: Map<string, K8sObject | undefined>,
    private readonly nodes: Map<string, boolean>,
  ) {}

  async getPod(name: string): Promise<K8sObject | undefined> {
    return this.pods.get(name)
  }

  async getNode(name: string): Promise<K8sObject | undefined> {
    const ready = this.nodes.get(name)
    if (ready === undefined) return undefined
    return { status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] } }
  }

  async createPod(pod: K8sObject): Promise<K8sObject> {
    return pod
  }

  async listPods(): Promise<{ items: readonly K8sObject[] }> {
    return { items: [] }
  }

  async deletePod(): Promise<void> {
    /* not exercised */
  }

  // eslint-disable-next-line require-yield
  async *watchPods(): AsyncGenerator<{ type: string; object: K8sObject; resourceVersion: string | null }> {
    return
  }
}

test('sweepRetirementObligations: a Succeeded Pod with terminated containers discharges', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const obligations = new PgObligationStore(db.pool as never)
    await obligations.record({ podName: 'pod-a', workstreamId, reason: 'cleanup_pod', deadline: new Date(), nodeName: 'node-1' })

    const pods = new Map<string, K8sObject | undefined>([
      ['pod-a', { status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: {} } }] } }],
    ])
    const result = await sweepRetirementObligations(new FakeK8sClient(pods, new Map()), obligations)
    assert.deepEqual(result.discharged, ['pod-a'])
    assert.deepEqual(await obligations.obligationsFor(workstreamId), [])
  })
})

test('sweepRetirementObligations: a force-deleted Pod on a NotReady node leaves the obligation unresolved', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const obligations = new PgObligationStore(db.pool as never)
    await obligations.record({ podName: 'pod-b', workstreamId, reason: 'cleanup_pod', deadline: new Date(), nodeName: 'node-2' })

    const pods = new Map<string, K8sObject | undefined>([['pod-b', undefined]])
    const result = await sweepRetirementObligations(new FakeK8sClient(pods, new Map([['node-2', false]])), obligations)
    assert.deepEqual(result.discharged, [], 'a partitioned/NotReady node cannot corroborate termination')
    assert.equal((await obligations.obligationsFor(workstreamId)).length, 1)
  })
})

test('sweepRetirementObligations: the same force-deleted Pod discharges once its node is confirmed Ready', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const obligations = new PgObligationStore(db.pool as never)
    await obligations.record({ podName: 'pod-c', workstreamId, reason: 'cleanup_pod', deadline: new Date(), nodeName: 'node-3' })

    const pods = new Map<string, K8sObject | undefined>([['pod-c', undefined]])
    const result = await sweepRetirementObligations(new FakeK8sClient(pods, new Map([['node-3', true]])), obligations)
    assert.deepEqual(result.discharged, ['pod-c'])
  })
})

test('sweepRetirementObligations: a never-scheduled Pod that is gone discharges without any node evidence', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const obligations = new PgObligationStore(db.pool as never)
    await obligations.record({ podName: 'pod-d', workstreamId, reason: 'cleanup_pod', deadline: new Date(), nodeName: null })

    const pods = new Map<string, K8sObject | undefined>([['pod-d', undefined]])
    const result = await sweepRetirementObligations(new FakeK8sClient(pods, new Map()), obligations)
    assert.deepEqual(result.discharged, ['pod-d'])
  })
})

test('an explicit operator fence discharges an obligation the automatic sweep would leave open', async () => {
  await withTestDatabase(async (db) => {
    const workstreamId = randomUUID()
    await db.pool.query('INSERT INTO workstreams (id, owner_principal, title, create_request_key) VALUES ($1, $2, $3, $4)', [workstreamId, 'p', 't', randomUUID()])
    const obligations = new PgObligationStore(db.pool as never)
    await obligations.record({ podName: 'pod-e', workstreamId, reason: 'cleanup_pod', deadline: new Date(), nodeName: 'node-4' })
    assert.equal(await obligations.discharge('pod-e', 'fenced'), true)
    assert.equal(await obligations.discharge('pod-e', 'fenced'), false, 'already discharged')
  })
})

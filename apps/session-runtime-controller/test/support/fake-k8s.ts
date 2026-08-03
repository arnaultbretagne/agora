import type { HttpError, K8sObject, KubernetesPods } from '../../src/k8s-client.js'

function conflict(message: string): HttpError {
  const err = new Error(message) as HttpError
  err.status = 409
  return err
}

/**
 * In-memory double for `KubernetesPods`, standing in for the real API server in reconciler tests.
 * `createPod`/`createServiceAccount` reject with the same 409 shape a real create-on-existing-name
 * would — that shared contract is what makes the "concurrent PUT creates one Pod" test meaningful
 * against this fake and not just against a live cluster.
 */
export class FakeK8s implements KubernetesPods {
  readonly pods = new Map<string, K8sObject>()
  readonly serviceAccounts = new Map<string, K8sObject>()
  private seq = 0

  async createPod(pod: K8sObject): Promise<K8sObject> {
    const name = pod.metadata?.name
    if (!name) throw conflict('pod missing metadata.name')
    if (this.pods.has(name)) throw conflict(`pod ${name} already exists`)
    const stored = this.withCreationMeta(pod)
    this.pods.set(name, stored)
    return stored
  }

  async getPod(name: string): Promise<K8sObject | undefined> {
    return this.pods.get(name)
  }

  async listPods(labelSelector: string): Promise<readonly K8sObject[]> {
    const [key, value] = labelSelector.split('=')
    return [...this.pods.values()].filter((p) => p.metadata?.labels?.[key ?? ''] === value)
  }

  async deletePod(name: string): Promise<void> {
    this.pods.delete(name)
  }

  async createServiceAccount(serviceAccount: K8sObject): Promise<K8sObject> {
    const name = serviceAccount.metadata?.name
    if (!name) throw conflict('service account missing metadata.name')
    if (this.serviceAccounts.has(name)) throw conflict(`service account ${name} already exists`)
    this.serviceAccounts.set(name, serviceAccount)
    return serviceAccount
  }

  async getServiceAccount(name: string): Promise<K8sObject | undefined> {
    return this.serviceAccounts.get(name)
  }

  async deleteServiceAccount(name: string): Promise<void> {
    this.serviceAccounts.delete(name)
  }

  /** Directly injects a Pod (bypassing create's conflict semantics) to simulate kubelet-reported
   * status/timestamps a real API server would own — e.g. two Pods for one Session, or a Ready condition. */
  seedPod(pod: K8sObject): void {
    const name = pod.metadata?.name
    if (name) this.pods.set(name, this.withCreationMeta(pod))
  }

  private withCreationMeta(pod: K8sObject): K8sObject {
    this.seq += 1
    return {
      ...pod,
      metadata: {
        uid: `uid-${this.seq}`,
        creationTimestamp: new Date(this.seq * 1000).toISOString(),
        ...pod.metadata,
      },
    }
  }
}

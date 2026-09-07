// Inventory (002 observation — observation.power/construction sources): every Pod for a Workstream
// in ANY phase, plus unresolved retirement obligations. A listing that could not complete reports
// `complete: false` — the normalizer then produces no `off` value.
import type { K8sClient, K8sObject } from './k8s-client.js'
import { LABEL_APP, LABEL_WORKSTREAM } from './k8s-labels.js'

export interface PodInventoryEntry {
  readonly uid: string
  readonly name: string
  readonly phase: string
  readonly node: string | null
  readonly nodeReady: boolean | null
  readonly containersTerminated: boolean
  readonly imageId: string | null
  readonly admittedDigest: string | null
  readonly incarnation: string | null
  readonly forcedDeletion: boolean
  readonly creationTimestamp: string | null
  /** null before the kubelet assigns one (Pending) — the ACP bridge is unreachable until then. */
  readonly podIP: string | null
}

export interface RetirementObligation {
  /** The Pod's stable, deterministic name (podName()) — discoverable even after the K8s-assigned uid is gone. */
  readonly podName: string
  readonly reason: string
  readonly deadline: string
  /** The node the Pod was last observed on, recorded at cleanup time — null if never scheduled. */
  readonly nodeName: string | null
}

export interface WorkstreamInventory {
  readonly workstreamId: string
  readonly pods: readonly PodInventoryEntry[]
  readonly obligations: readonly RetirementObligation[]
  readonly observedAt: string
  readonly resourceVersion: string | null
  readonly complete: boolean
}

export interface ObligationStore {
  obligationsFor(workstreamId: string): Promise<readonly RetirementObligation[]>
  record(input: { podName: string; workstreamId: string; reason: string; deadline: Date; nodeName: string | null }): Promise<void>
}

export async function inventoryWorkstream(k8s: K8sClient, obligations: ObligationStore, workstreamId: string): Promise<WorkstreamInventory> {
  let pods: readonly K8sObject[]
  let resourceVersion: string | null = null
  let complete = true
  try {
    const list = await k8s.listPods(`${LABEL_WORKSTREAM}=${workstreamId}`)
    pods = list.items
    resourceVersion = list.metadata?.resourceVersion ?? null
  } catch {
    complete = false
    pods = []
  }
  const entries = await Promise.all(pods.map((pod) => toPodEntry(pod, k8s)))
  return {
    workstreamId,
    pods: entries,
    obligations: complete ? await obligations.obligationsFor(workstreamId) : [],
    observedAt: new Date().toISOString(),
    resourceVersion,
    complete,
  }
}

/** Every distinct Workstream currently reported by any Agora-managed Pod (S6 wakes: relist fallback). */
export async function distinctLiveWorkstreamIds(k8s: K8sClient): Promise<readonly string[]> {
  const list = await k8s.listPods(`${LABEL_APP}=runtime-controlled`)
  const ids = new Set<string>()
  for (const pod of list.items) {
    const id = (pod['metadata'] as { labels?: Record<string, string> } | undefined)?.labels?.[LABEL_WORKSTREAM]
    if (id !== undefined) ids.add(id)
  }
  return [...ids]
}

interface ContainerState {
  readonly terminated?: unknown
}

async function toPodEntry(pod: K8sObject, k8s: K8sClient): Promise<PodInventoryEntry> {
  const metadata = pod['metadata'] as { uid?: string; name?: string; labels?: Record<string, string>; creationTimestamp?: string; deletionTimestamp?: string } | undefined
  const spec = pod['spec'] as { nodeName?: string; containers?: readonly { image?: string }[] } | undefined
  const status = pod['status'] as {
    phase?: string
    podIP?: string
    containerStatuses?: readonly { imageID?: string; state?: { terminated?: ContainerState } }[]
  } | undefined
  const node = spec?.nodeName ?? null
  const nodeReady = node !== null ? await readNodeReady(k8s, node) : null
  return {
    uid: metadata?.uid ?? '',
    name: metadata?.name ?? '',
    phase: status?.phase ?? 'Unknown',
    node,
    nodeReady,
    containersTerminated: (status?.containerStatuses ?? []).every((state) => state.state?.terminated !== undefined) && (status?.containerStatuses?.length ?? 0) > 0,
    // The kubelet publishes a container status with an EMPTY imageID while the image is still
    // being pulled. Empty is not an image id — it is the absence of one — and passing it on as a
    // string made the construction observation read "a Pod running an image the catalogue does not
    // know", which selects TURN_OFF. Every harness Pod was destroyed mid-pull, so no image slower
    // to pull than one tick could ever converge. Found on the first live deployment.
    imageId: emptyToNull(status?.containerStatuses?.[0]?.imageID),
    admittedDigest: spec?.containers?.[0]?.image ?? null,
    incarnation: metadata?.labels?.['agora.dev/incarnation'] ?? null,
    forcedDeletion: metadata?.deletionTimestamp !== undefined,
    creationTimestamp: metadata?.creationTimestamp ?? null,
    podIP: status?.podIP ?? null,
  }
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

async function readNodeReady(k8s: K8sClient, nodeName: string): Promise<boolean | null> {
  const node = await k8s.getNode(nodeName)
  if (node === undefined) return null
  const conditions = (node['status'] as { conditions?: readonly { type?: string; status?: string }[] } | undefined)?.conditions ?? []
  const ready = conditions.find((c) => c.type === 'Ready')
  return ready === undefined ? null : ready.status === 'True'
}

/** P7: a Pod that never reached Running within the pinned startup deadline is unusable evidence. */
export function isStartupDeadlineExpired(creationTimestamp: string | null, phase: string, nowIso: string, startupDeadlineSeconds: number): boolean {
  if (creationTimestamp === null) return false
  if (phase === 'Running' || phase === 'Succeeded' || phase === 'Failed') return false
  const ageSeconds = (Date.parse(nowIso) - Date.parse(creationTimestamp)) / 1000
  return ageSeconds > startupDeadlineSeconds
}

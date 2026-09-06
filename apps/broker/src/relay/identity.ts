// Resolves a connecting Pod's Workstream/incarnation from its source IP (P10). The label keys are
// a wire-level contract with apps/runtime-control/src/k8s-labels.ts (ADR 0001 forbids a deployable
// depending on another, so the two small string constants are mirrored, not imported) — runtime-
// control is the one place that WRITES these labels; broker only ever reads them back.
import type { K8sObject, K8sPodLookup } from './k8s-pod-lookup.js'

const LABEL_WORKSTREAM = 'agora.dev/workstream'
const LABEL_INCARNATION = 'agora.dev/incarnation'

export interface RelayIdentity {
  readonly workstreamId: string
  readonly incarnation: string
}

/** The Pod cannot forge its own source IP within the CNI (field-findings §3.3) — this is the one fact this resolution trusts. */
export async function resolveIdentity(lookup: K8sPodLookup, sourceIp: string): Promise<RelayIdentity | undefined> {
  const pod = await lookup.findByPodIP(sourceIp)
  if (pod === undefined) return undefined
  return labelsOf(pod)
}

function labelsOf(pod: K8sObject): RelayIdentity | undefined {
  const labels = (pod['metadata'] as { labels?: Record<string, string> } | undefined)?.labels
  const workstreamId = labels?.[LABEL_WORKSTREAM]
  const incarnation = labels?.[LABEL_INCARNATION]
  if (workstreamId === undefined || incarnation === undefined) return undefined
  return { workstreamId, incarnation }
}

import type { AgentRuntimeDefinition } from '@agora/agent-registry'
import type { HttpError, K8sObject, KubernetesPods } from './k8s-client.js'
import { LABEL_AGENT_ID, LABEL_RUNTIME_DEFINITION_VERSION, LABEL_SESSION_ID, podName, requiredLabels, serviceAccountName } from './labels.js'
import { buildPodSpec } from './pod-spec.js'
import type { RelayBundle } from './relay-bundle.js'

export type LiveState = 'absent' | 'provisioning' | 'ready' | 'capturing' | 'terminating' | 'failed'

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail?: string
}

export interface ReconciledStatus {
  readonly state: LiveState
  readonly podUid?: string
  readonly agentId?: string
  readonly runtimeDefinitionVersion?: string
  readonly failure?: Problem
}

function podPhase(pod: K8sObject): string | undefined {
  return (pod.status as { phase?: string } | undefined)?.phase
}

function podReady(pod: K8sObject): boolean {
  const conditions = (pod.status as { conditions?: readonly { type?: string; status?: string }[] } | undefined)?.conditions ?? []
  return conditions.some((c) => c.type === 'Ready' && c.status === 'True')
}

function isTerminal(pod: K8sObject): boolean {
  return Boolean(pod.metadata?.deletionTimestamp) || podPhase(pod) === 'Succeeded'
}

function deriveState(pod: K8sObject): LiveState {
  if (pod.metadata?.deletionTimestamp) return 'terminating'
  if (podPhase(pod) === 'Failed') return 'failed'
  return podReady(pod) ? 'ready' : 'provisioning'
}

function podUid(pod: K8sObject): string | undefined {
  return (pod.metadata as { uid?: string } | undefined)?.uid
}

function podIdentityLabels(pod: K8sObject): { agentId?: string; runtimeDefinitionVersion?: string } {
  const labels = pod.metadata?.labels
  const agentId = labels?.[LABEL_AGENT_ID]
  const runtimeDefinitionVersion = labels?.[LABEL_RUNTIME_DEFINITION_VERSION]
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(runtimeDefinitionVersion !== undefined ? { runtimeDefinitionVersion } : {}),
  }
}

function creationOrder(a: K8sObject, b: K8sObject): number {
  const at = (a.metadata as { creationTimestamp?: string } | undefined)?.creationTimestamp ?? ''
  const bt = (b.metadata as { creationTimestamp?: string } | undefined)?.creationTimestamp ?? ''
  if (at !== bt) return at < bt ? -1 : 1
  return String(a.metadata?.name ?? '').localeCompare(String(b.metadata?.name ?? ''))
}

/**
 * docs/specs/08 "If multiple Pods are observed for one Session, the controller MUST fail closed,
 * stop returning a ready endpoint and reconcile according to a deterministic survivor policy."
 * Survivor = oldest by `creationTimestamp` (name as a stable tiebreak) — deterministic regardless
 * of which reconciler process/replica observes the duplicate.
 */
async function reconcileDuplicates(k8s: KubernetesPods, pods: readonly K8sObject[]): Promise<void> {
  const sorted = [...pods].sort(creationOrder)
  for (const extra of sorted.slice(1)) {
    const name = extra.metadata?.name
    if (name) await k8s.deletePod(name)
  }
}

/**
 * docs/specs/08 "Reconciliation": reconstructs truth from Kubernetes labels/status alone — no
 * in-memory map is authoritative, so this gives the identical answer whether it is the first call
 * after a materialize or the first call after a controller restart (required: "Restart with an
 * existing Pod reconstructs the same Session Runtime state by session_id").
 */
export async function reconcileSessionRuntime(k8s: KubernetesPods, sessionId: string): Promise<ReconciledStatus> {
  const pods = await k8s.listPods(`${LABEL_SESSION_ID}=${sessionId}`)
  const nonTerminal = pods.filter((p) => !isTerminal(p))

  if (nonTerminal.length === 0) {
    const [lastKnown] = pods
    if (!lastKnown) return { state: 'absent' }
    return { state: 'terminating', ...podIdentityLabels(lastKnown) }
  }

  if (nonTerminal.length > 1) {
    const [firstObserved] = nonTerminal
    await reconcileDuplicates(k8s, nonTerminal)
    return {
      state: 'failed',
      ...(firstObserved ? podIdentityLabels(firstObserved) : {}),
      failure: {
        type: 'https://agora.invalid/problems/duplicate-session-runtime-pod',
        title: 'Duplicate Session Runtime Pods observed; reconciling to a single survivor',
        status: 500,
        code: 'duplicate_pod',
      },
    }
  }

  const pod = nonTerminal[0]
  if (!pod) return { state: 'absent' }
  const result: ReconciledStatus = { state: deriveState(pod), ...podIdentityLabels(pod) }
  const uid = podUid(pod)
  return uid ? { ...result, podUid: uid } : result
}

export interface MaterializeInput {
  readonly sessionId: string
  readonly definition: AgentRuntimeDefinition
  readonly workspaceMountRef: string
  readonly executionGrantRef: string
  readonly relayBundle: RelayBundle
  readonly controllerRevision: string
  readonly runAsUser?: number
  readonly runtimeClassName?: string
  /** Operator-configured pull credential for the registry `AgentRuntimeDefinition.imageDigest`
   * resolves to (e.g. a private GHCR repository) — never caller-supplied; bound to the per-Session
   * ServiceAccount, never the materialize request. */
  readonly imagePullSecretName?: string
  readonly restoreFrom?: { readonly url: string; readonly credential: string }
}

export interface MaterializeResult {
  readonly httpStatus: 200 | 202
  readonly status: ReconciledStatus
}

/**
 * Idempotent `PUT` (docs/specs/08 "Materialize"). Kubernetes' own name uniqueness (the Pod name is
 * deterministic from `sessionId`) is what makes "required: concurrent PUT creates one Pod" true:
 * two racing calls both try to create the SAME name; the loser's 409 is caught here and turned
 * into "read back whoever won", never a second Pod and never a surfaced error.
 */
export async function materializeSessionRuntime(k8s: KubernetesPods, input: MaterializeInput): Promise<MaterializeResult> {
  const existing = await reconcileSessionRuntime(k8s, input.sessionId)
  if (existing.state !== 'absent') return { httpStatus: 200, status: existing }

  const saName = serviceAccountName(input.sessionId)
  if (!(await k8s.getServiceAccount(saName))) {
    try {
      await k8s.createServiceAccount({
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: saName,
          labels: requiredLabels({
            sessionId: input.sessionId,
            agentId: input.definition.agentId,
            runtimeDefinitionVersion: input.definition.version,
            executionGrantRef: input.executionGrantRef,
            controllerRevision: input.controllerRevision,
          }),
        },
        ...(input.imagePullSecretName ? { imagePullSecrets: [{ name: input.imagePullSecretName }] } : {}),
      })
    } catch (error) {
      if ((error as HttpError).status !== 409) throw error
    }
  }

  const podSpec = buildPodSpec(input)
  try {
    await k8s.createPod(podSpec)
  } catch (error) {
    if ((error as HttpError).status === 409) {
      const afterRace = await reconcileSessionRuntime(k8s, input.sessionId)
      return { httpStatus: 200, status: afterRace }
    }
    throw error
  }

  return {
    httpStatus: 202,
    status: { state: 'provisioning', agentId: input.definition.agentId, runtimeDefinitionVersion: input.definition.version },
  }
}

export interface DematerializeResult {
  readonly httpStatus: 202 | 204
  readonly status: ReconciledStatus
}

/** Idempotent `DELETE` (docs/specs/08 "Dematerialize"). required: "DELETE for a non-materialized
 * Session Runtime succeeds" (204, not an error). */
export async function dematerializeSessionRuntime(k8s: KubernetesPods, sessionId: string): Promise<DematerializeResult> {
  const existing = await reconcileSessionRuntime(k8s, sessionId)
  if (existing.state === 'absent') return { httpStatus: 204, status: existing }
  await k8s.deletePod(podName(sessionId))
  await k8s.deleteServiceAccount(serviceAccountName(sessionId))
  return { httpStatus: 202, status: { ...existing, state: 'terminating' } }
}

import type { AgentRuntimeDefinition } from '@agora/agent-registry'
import type { K8sObject } from './k8s-client.js'
import { podName, requiredLabels, serviceAccountName } from './labels.js'
import type { RelayBundle } from './relay-bundle.js'

export interface BuildPodSpecInput {
  readonly sessionId: string
  readonly definition: AgentRuntimeDefinition
  readonly executionGrantRef: string
  readonly relayBundle: RelayBundle
  readonly controllerRevision: string
  /**
   * Numeric UID/GID every Agent image runs as (agent-runtime's images all use 1000 for their
   * non-root `node` user — see reuse-audit note in pod-spec.test.ts). The schema has no per-image
   * UID field; kubelet needs a NUMERIC `runAsUser` even when the image's own `USER` directive names
   * the account (agent-runtime hit this live — a named user is not accepted as proof of non-root).
   */
  readonly runAsUser?: number
  /** gVisor sandboxing — the established posture for untrusted Agent execution (docs/specs/11
   * threat model: prompt injection = arbitrary code execution). Omit only if the target namespace
   * has no such RuntimeClass installed. */
  readonly runtimeClassName?: string
  /**
   * docs/specs/07-custody.md "Restore contract": present only when this materialize resumes from a
   * snapshot. The Pod pulls its own native state from `url` using this one-time `credential` before
   * opening for readiness — it never receives the snapshot id, a database credential or the bytes
   * themselves at materialize time.
   */
  readonly restoreFrom?: { readonly url: string; readonly credential: string }
}

const DEFAULT_UID = 1000
const RELAY_ENDPOINT_ENV = 'AGORA_BROKER_RELAY_ENDPOINT'
const ONECLI_CA_PATH = '/etc/agora/onecli-ca.pem'
const AUTH_STUBS_DIR = '/etc/agora/onecli-stubs'

/**
 * Deterministic PodSpec builder (docs/specs/08 "Materialize", docs/specs/11 "Kubernetes"): built
 * ONLY from the registry-resolved `AgentRuntimeDefinition` and the plan's own trusted inputs — no
 * field of the materialize request is trusted to name an image, command, env or K8s fragment.
 */
export function buildPodSpec(input: BuildPodSpecInput): K8sObject {
  const { definition } = input
  const uid = input.runAsUser ?? DEFAULT_UID
  const authStubEntries = Object.entries(input.relayBundle.authStubs)

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName(input.sessionId),
      labels: requiredLabels({
        sessionId: input.sessionId,
        agentId: definition.agentId,
        runtimeDefinitionVersion: definition.version,
        executionGrantRef: input.executionGrantRef,
        controllerRevision: input.controllerRevision,
      }),
    },
    spec: {
      restartPolicy: 'Never',
      ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
      serviceAccountName: serviceAccountName(input.sessionId),
      automountServiceAccountToken: false,
      securityContext: {
        fsGroup: uid,
        runAsNonRoot: true,
        runAsUser: uid,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'agent',
          image: definition.imageDigest,
          command: [...definition.acpCommand],
          ports: [{ containerPort: definition.bridge.listenPort }],
          env: [
            { name: RELAY_ENDPOINT_ENV, value: input.relayBundle.relayEndpoint },
            { name: 'AGORA_ONECLI_CA_PATH', value: ONECLI_CA_PATH },
            { name: 'AGORA_ONECLI_STUBS_DIR', value: AUTH_STUBS_DIR },
            { name: 'AGORA_WORKSPACE_ROOT', value: '/home/node/work' },
            ...(input.restoreFrom
              ? [
                  { name: 'AGORA_CUSTODY_RESTORE_URL', value: input.restoreFrom.url },
                  { name: 'AGORA_CUSTODY_RESTORE_CREDENTIAL', value: input.restoreFrom.credential },
                ]
              : []),
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            readOnlyRootFilesystem: false,
            runAsNonRoot: true,
            runAsUser: uid,
          },
          resources: {
            requests: { cpu: definition.resources.requests.cpu, memory: definition.resources.requests.memory },
            limits: {
              cpu: definition.resources.limits.cpu,
              memory: definition.resources.limits.memory,
              'ephemeral-storage': definition.resources.limits.ephemeralStorage,
            },
          },
          readinessProbe: {
            httpGet: { path: definition.health.path, port: definition.bridge.listenPort },
            initialDelaySeconds: definition.health.initialDelaySeconds,
            timeoutSeconds: definition.health.timeoutSeconds,
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/home/node/work' },
            { name: 'onecli-ca', mountPath: ONECLI_CA_PATH, subPath: 'ca.pem', readOnly: true },
            { name: 'onecli-stubs', mountPath: AUTH_STUBS_DIR, readOnly: true },
          ],
        },
      ],
      volumes: [
        // Operator decision, P11 (2026-08-06): the workspace is ALWAYS an ephemeral per-Pod
        // `emptyDir`, and this file deliberately exposes no way to mount a PersistentVolumeClaim —
        // there is no claim-name input to pass, so a PVC cannot be attached to a Session Runtime by
        // construction, not merely by convention.
        //
        // Why this is safe: durable Session state is custody (the Agent's own native transcript,
        // captured/restored around Pod replacement) plus the Workstream journal — never the working
        // directory. The workspace is scratch by design.
        //
        // Why the previous shape was actively wrong: a claim name is a cluster-wide handle, so every
        // Session materialized with the same reference mounted the SAME volume. That is exactly what
        // happened live — every Session mounted a shared `pvc-default` — which violates
        // docs/specs/08 "cannot access another Session's workspace/custody". An `emptyDir` is
        // per-Pod by definition and cannot be pointed at another Session's data.
        { name: 'workspace', emptyDir: {} },
        { name: 'onecli-ca', configMap: { name: 'agora-onecli-ca', items: [{ key: 'ca.pem', path: 'ca.pem' }] } },
        // Secret, not ConfigMap: unlike the CA above (a public trust cert, no confidentiality
        // need), a harness stub can carry real account-identifying content — e.g. Codex's own
        // `codex-auth-json` stub must hold the real linked account's id_token, not a fabricated
        // one, or codex-acp's own local identity validation rejects it (agents/codex/SPIKE.md).
        // Found live, P11: the original ConfigMap-backed design was flagged in P10's own Evidence
        // as "worth reconsidering a higher-sensitivity channel later" — this is that fix.
        {
          name: 'onecli-stubs',
          projected: {
            sources: [
              {
                secret: {
                  name: 'agora-onecli-stubs',
                  items: authStubEntries.map(([key]) => ({ key, path: key })),
                },
              },
            ],
          },
        },
      ],
    },
  }
}

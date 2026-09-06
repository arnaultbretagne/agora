// Deterministic PodSpec from the reviewed harness definition and trusted inputs only (ADR 0006,
// ADR 0007; findings §4): image by digest, fixed command, numeric runAsUser, no ServiceAccount
// token, resource limits, sandbox runtime class. No request field may name an image, argv, env or
// PodSpec fragment — the API shape makes those unrepresentable.
import { readFileSync } from 'node:fs'
import type { K8sObject } from './k8s-client.js'
import { podName, requiredLabels } from './k8s-labels.js'

export interface HarnessDefinition {
  readonly harnessId: string
  readonly imageDigest: string
  readonly launchCommand: readonly string[]
  readonly mounts: readonly { readonly name: string; readonly mountPath: string; readonly readOnly?: boolean }[]
}

export interface RuntimeSettings {
  readonly namespace: string
  readonly startupDeadlineSeconds: number
  readonly terminationGraceSeconds: number
  readonly inventoryFreshnessMs: number
  readonly runtimeClassName: string
  readonly runAsUser: number
}

export interface PodSpecInput {
  readonly workstreamId: string
  readonly attemptKey: string
  readonly incarnation: string
  readonly harnessId: string
}

export function loadHarnessDefinitions(path: string): readonly HarnessDefinition[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { harnesses: readonly HarnessDefinition[] }).harnesses
}

export function loadRuntimeSettings(path: string): RuntimeSettings {
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimeSettings
}

export function buildPodSpec(input: PodSpecInput, harness: HarnessDefinition, settings: RuntimeSettings): K8sObject {
  const activeDeadline = `agora.dev/startup-deadline`
  void activeDeadline
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName(input.workstreamId, input.incarnation.slice(0, 10)),
      labels: requiredLabels({
        workstreamId: input.workstreamId,
        attemptKey: input.attemptKey,
        incarnation: input.incarnation,
      }),
    },
    spec: {
      runtimeClassName: settings.runtimeClassName,
      serviceAccountName: 'harness',
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: settings.startupDeadlineSeconds,
      terminationGracePeriodSeconds: settings.terminationGraceSeconds,
      containers: [
        {
          name: 'harness',
          image: harness.imageDigest,
          command: [...harness.launchCommand],
          imagePullPolicy: 'IfNotPresent',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: settings.runAsUser,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
          },
          resources: {
            limits: { cpu: '1', memory: '1Gi' },
            requests: { cpu: '100m', memory: '128Mi' },
          },
          volumeMounts: harness.mounts.map((mount) => ({ name: mount.name, mountPath: mount.mountPath, readOnly: mount.readOnly ?? true })),
        },
      ],
      volumes: harness.mounts.map((mount) => ({ name: mount.name, emptyDir: {} })),
    },
  }
}

export class RequestSuppliesPodInputError extends Error {
  readonly code = 'request_supplies_pod_input'

  constructor(field: string) {
    super(`request field "${field}" is not accepted: Pod inputs come from the reviewed catalogue only`)
    this.name = 'RequestSuppliesPodInputError'
  }
}

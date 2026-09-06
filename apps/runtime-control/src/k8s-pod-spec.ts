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
  /** P11: the named capability admission verifies is granted before the first prompt — model/provider access, never implicit (AUTH-009). */
  readonly bootstrapCapability?: string
  /** P11: the reviewed, curated model/effort catalogue — a deliberate subset of what the adapter actually offers (harnesses/claude-code/README.md). */
  readonly models?: Readonly<Record<string, { readonly efforts: readonly string[] }>>
}

export interface RuntimeSettings {
  readonly namespace: string
  readonly startupDeadlineSeconds: number
  readonly terminationGraceSeconds: number
  readonly inventoryFreshnessMs: number
  readonly runtimeClassName: string
  readonly runAsUser: number
  /** The Secret (and its key) holding the P4 bridge signing secret — the same one runtime-control itself uses, mounted read-only into every harness Pod. */
  readonly bridgeAuthSecretName: string
  readonly bridgeAuthSecretKey: string
  readonly bridgePort: number
  readonly ownerApiBaseUrl: string
  /** ADR 0009: the Pod's egress goes through the Broker relay only — never OneCLI or a provider directly, and never with the OneCLI bearer, which stays Broker-private. */
  readonly relayHost: string
  readonly relayPort: number
  /** The ConfigMap (public — a CA certificate, not a secret) publishing OneCLI's gateway CA, so the Pod trusts the relay's TLS interception. */
  readonly relayCaConfigMapName: string
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
  // Not `.slice(0, 10)` here — podName() already caps its slot argument to 20 chars internally.
  // Slicing again here first, to a DIFFERENT length, silently produced a Pod name that disagreed
  // with owner-api.ts's own `podName(workstreamId, target.id)` (unsliced) whenever an incarnation
  // ran past 10 characters — breaking "discoverable by pre-recorded correlation" exactly when it
  // would matter most. Found while wiring S8's real incarnation values through for the first time.
  const name = podName(input.workstreamId, input.incarnation)
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
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
          ports: [{ containerPort: settings.bridgePort, name: 'bridge' }],
          env: [
            { name: 'AGORA_INCARNATION', value: input.incarnation },
            { name: 'AGORA_EVIDENCE_URL', value: `${settings.ownerApiBaseUrl}/v1/pods/${name}/evidence` },
            { name: 'BRIDGE_PORT', value: String(settings.bridgePort) },
            { name: 'BRIDGE_AUTH_SECRET', valueFrom: { secretKeyRef: { name: settings.bridgeAuthSecretName, key: settings.bridgeAuthSecretKey } } },
            // No credential in this URL — the relay identifies the Pod by its own source IP
            // (P10) and holds the OneCLI bearer itself (ADR 0009). Uppercase and lowercase forms:
            // not every HTTP client in the harness image honors only one casing.
            { name: 'HTTPS_PROXY', value: `http://${settings.relayHost}:${settings.relayPort}` },
            { name: 'https_proxy', value: `http://${settings.relayHost}:${settings.relayPort}` },
            { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/agora/relay-ca/ca.pem' },
          ],
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
      // `emptyDir` here used to hand the Pod a directory with no content at all — the mount
      // existed but the CA it's meant to hold never did. The relay-ca mount is a real ConfigMap
      // (public: a CA certificate, never a secret) that an operator (or, once automated, the
      // Broker) publishes from OneCLI's own gateway CA.
      volumes: harness.mounts.map((mount) => (mount.name === 'relay-ca' ? { name: mount.name, configMap: { name: settings.relayCaConfigMapName } } : { name: mount.name, emptyDir: {} })),
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

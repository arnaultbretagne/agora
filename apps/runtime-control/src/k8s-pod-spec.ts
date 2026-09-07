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
  /**
   * Where the harness keeps its own native state — its `HOME`. S9 custody: the driver reads and
   * places the transcript under it, so it must be backed by a writable mount, and the root
   * filesystem stays read-only. Declared here, in the reviewed catalogue, never by a request.
   */
  readonly harnessHome: string
  /** The fixed workspace root the adapter is launched with; the transcript's directory slug derives from it. */
  readonly workspaceRoot: string
  /** P11: the named capability admission verifies is granted before the first prompt — model/provider access, never implicit (AUTH-009). */
  readonly bootstrapCapability?: string
  /** P11: the reviewed, curated model/effort catalogue — a deliberate subset of what the adapter actually offers (harnesses/claude-code/README.md). */
  readonly models?: Readonly<Record<string, { readonly efforts: readonly string[] }>>
  /**
   * Reviewed, non-secret environment this harness's adapter needs to select the right auth MODE —
   * `CLAUDE_CODE_OAUTH_TOKEN=onecli-managed`, codex's `SSL_CERT_FILE` (a Rust binary ignores
   * NODE_EXTRA_CA_CERTS). Catalogue content, never request-suppliable, and never a credential: the
   * bearer stays Broker-private (ADR 0009) and OneCLI injects it upstream.
   */
  readonly podEnv?: Readonly<Record<string, string>>
  /** Files the adapter expects to find in its HOME before it starts, written by the bridge. Markers, not credentials (field findings §2.2, §2.3). */
  readonly credentialStubs?: readonly { readonly path: string; readonly content: string }[]
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

/**
 * Names a harness definition may not supply: every one of them is decided by this file from
 * trusted inputs, and letting the catalogue overwrite one would turn a reviewed value into a
 * negotiable one (ADR 0006).
 */
const RESERVED_ENV = new Set([
  'AGORA_INCARNATION',
  'AGORA_EVIDENCE_URL',
  'HOME',
  'AGORA_HARNESS_HOME',
  'AGORA_WORKSPACE_ROOT',
  'AGORA_CUSTODY_URL',
  'AGORA_POD_UID',
  'AGORA_CREDENTIAL_STUBS',
  'BRIDGE_PORT',
  'BRIDGE_AUTH_SECRET',
  'HTTPS_PROXY',
  'https_proxy',
  'NODE_EXTRA_CA_CERTS',
])

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
      // The root filesystem stays read-only, so the ONE writable place is the harness-home emptyDir
      // — and an emptyDir is root-owned unless an fsGroup is set. Without this the adapter cannot
      // write the transcript it is later captured from, and a restore would have nowhere to land.
      // `seccompProfile` and the container's `capabilities.drop` below are what the Pod Security
      // Standard "restricted" requires, and the API server refuses the Pod outright without them —
      // found the first time this spec met a cluster that enforces it. They belong here anyway:
      // this Pod runs someone else's model output, and dropping every capability is the floor.
      securityContext: { fsGroup: settings.runAsUser, seccompProfile: { type: 'RuntimeDefault' } },
      // NO `activeDeadlineSeconds`. It bounds the Pod's WHOLE life, not its startup, so setting it
      // to the startup deadline killed every harness Pod after two minutes of perfectly healthy
      // work — with `DeadlineExceeded`, which reads like a hung launch rather than a policy. The
      // startup deadline is an OBSERVATION (`isStartupDeadlineExpired`, inventory.ts): the engine
      // decides what a Pod that never reached Running means, because only the engine knows whether
      // anything is waiting on it.
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
            // S9 custody: where the harness's native state lives, and where it fetches and reports a
            // restored Save. The Pod never sees a Save id or a store credential — the offer arrives
            // on the evidence endpoint it already polls, and these are just the addresses.
            { name: 'HOME', value: harness.harnessHome },
            { name: 'AGORA_HARNESS_HOME', value: harness.harnessHome },
            { name: 'AGORA_WORKSPACE_ROOT', value: harness.workspaceRoot },
            { name: 'AGORA_CUSTODY_URL', value: `${settings.ownerApiBaseUrl}/v1/pods/${name}/custody` },
            // The Pod's own UID, from the downward API rather than from anything it could assert:
            // it is half of a Save's capture key, so it must be what Kubernetes says it is.
            { name: 'AGORA_POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
            { name: 'BRIDGE_PORT', value: String(settings.bridgePort) },
            { name: 'BRIDGE_AUTH_SECRET', valueFrom: { secretKeyRef: { name: settings.bridgeAuthSecretName, key: settings.bridgeAuthSecretKey } } },
            // No credential in this URL — the relay identifies the Pod by its own source IP
            // (P10) and holds the OneCLI bearer itself (ADR 0009). Uppercase and lowercase forms:
            // not every HTTP client in the harness image honors only one casing.
            { name: 'HTTPS_PROXY', value: `http://${settings.relayHost}:${settings.relayPort}` },
            { name: 'https_proxy', value: `http://${settings.relayHost}:${settings.relayPort}` },
            { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/agora/relay-ca/ca.pem' },
            // The stubs travel as data the bridge writes into HOME before spawning the adapter.
            // Empty for a harness that declares none, and absent from the spec entirely rather
            // than present-and-empty, so a diff of two PodSpecs says which harness needs one.
            ...(harness.credentialStubs !== undefined && harness.credentialStubs.length > 0
              ? [{ name: 'AGORA_CREDENTIAL_STUBS', value: JSON.stringify(harness.credentialStubs) }]
              : []),
            // Last, and from the reviewed catalogue only: a harness definition may ADD to this
            // environment, never redefine what the spec above already decided.
            ...Object.entries(harness.podEnv ?? {})
              .filter(([name]) => !RESERVED_ENV.has(name))
              .map(([name, value]) => ({ name, value })),
          ],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: settings.runAsUser,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
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

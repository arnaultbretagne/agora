// Spike only: a throwaway Pod running a production harness image exactly as its pool runs it, with
// three differences: our own bridge key, no anchor push, a hard deadline (activeDeadlineSeconds).
// It carries the label the sandboxes' network policies select (bridge ingress from the host, egress
// to the gateway and DNS only) and is not a Sandbox: Agora, which lists Sandboxes, never sees it.
//   node pod.ts <claude-code|codex> <name> <bridge public pem> | sudo -n k0s kubectl apply -f -
import { readFileSync } from 'node:fs'

const IMAGES: Record<string, string> = {
  // The pools' images on 2026-11-12, the measurement taken again after the harnesses' upgrade (SandboxTemplates
  // claude-code-220dcdea6c5d and codex-156dc39bef82: claude-agent-acp 0.106.0, codex-acp 2.6.0). On 2026-11-11 they were
  // claude-code-6c8bf87a9038 and codex-3013411865ab.
  'claude-code': 'ghcr.io/arnaultbretagne/agora-harness-claude-code@sha256:220dcdea6c5d9b39322c4e795b2742b771fc23427e91228afe1ac03fc25c01cd',
  codex: 'ghcr.io/arnaultbretagne/agora-harness-codex@sha256:156dc39bef8270db4426746839bd57a881912cea4a500dac7d525b37402b19c4',
}
const [harness, name, publicPem] = process.argv.slice(2) as [string, string, string]
const image = IMAGES[harness]
if (!image) throw new Error(`unknown harness ${harness}`)
const ca = '/etc/agora/credential-proxy/ca.pem'
const env: Record<string, unknown>[] = [
  { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
  { name: 'BRIDGE_PUBLIC_KEY', value: readFileSync(publicPem, 'utf8') },
  { name: 'NODE_EXTRA_CA_CERTS', value: ca },
  { name: 'GIT_SSL_CAINFO', value: ca },
]
if (harness === 'codex')
  env.push({ name: 'SSL_CERT_FILE', value: ca }, { name: 'CODEX_ACCOUNT_ID', valueFrom: { secretKeyRef: { name: 'codex-account', key: 'account_id' } } })
const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name,
    namespace: 'agora-sandboxes',
    labels: { 'app.kubernetes.io/part-of': 'agora-sandboxes', 'agora.bretagne.dev/spike': 'acp-subagents' },
  },
  spec: {
    runtimeClassName: 'kata',
    restartPolicy: 'Never',
    activeDeadlineSeconds: 5400,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    terminationGracePeriodSeconds: 5,
    imagePullSecrets: [{ name: 'ghcr-pull' }],
    securityContext: { runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [
      {
        name: 'sandbox',
        image,
        imagePullPolicy: 'IfNotPresent',
        env,
        ports: [{ name: 'bridge', containerPort: 8080 }],
        readinessProbe: { httpGet: { path: '/healthz', port: 'bridge' }, periodSeconds: 2, failureThreshold: 1 },
        resources: { requests: { cpu: '50m', memory: '512Mi' }, limits: { cpu: '1', memory: harness === 'codex' ? '2Gi' : '2560Mi' } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [
          { name: 'scratch', mountPath: '/home/harness', subPath: 'home' },
          { name: 'scratch', mountPath: '/tmp', subPath: 'tmp' },
          { name: 'credential-proxy', mountPath: '/etc/agora/credential-proxy', readOnly: true },
        ],
      },
    ],
    volumes: [
      { name: 'scratch', emptyDir: { sizeLimit: '2Gi' } },
      { name: 'credential-proxy', configMap: { name: 'credential-proxy-ca' } },
    ],
  },
}
process.stdout.write(JSON.stringify(pod))

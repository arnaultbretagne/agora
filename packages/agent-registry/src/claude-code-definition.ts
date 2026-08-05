import type { AgentRuntimeDefinition } from './types.js'

/**
 * `agents/claude-code/SPIKE.md` (2026-08-05, real infra, real Claude Max subscription, no fakes):
 * `@agentclientprotocol/claude-agent-acp@0.64.2`, wrapped by `agents/claude-code/src/bridge-server.ts`
 * behind the ACP bridge WebSocket listener, image built+pushed and smoke-tested live (a real Pod
 * running this image answered `/healthz`; the full ACP+custody flow was proven against the same
 * OneCLI/adapter combination outside Kubernetes in the spike — a real Session Runtime Pod
 * end-to-end pass is tracked separately, not yet done, hence `rollout: 'internal'` below).
 */
export const CLAUDE_CODE_DEFINITION: AgentRuntimeDefinition = {
  agentId: 'claude-code',
  version: '2026-08-05',
  label: 'Claude Code',
  description: 'Claude Code via the official Agent Client Protocol adapter, credentialed through the Broker/OneCLI path.',
  // The multi-arch index digest (`docker push`'s own reported digest for the `:latest` tag) —
  // containerd/k0s resolve this to the right platform manifest automatically, same as pulling by
  // tag would, but pinned so a later `:latest` push can never silently change what launches.
  imageDigest: 'ghcr.io/arnaultbretagne/agora-claude-code@sha256:73c20e6ab7d93c32f7cb3f9daf2dd0d7715250bdc57d55ef09676be6086fe4b3',
  // Matches agents/claude-code/image/Dockerfile's actual layout: the whole monorepo is built in
  // place under /repo, and the entrypoint lives where that build put it (same pattern
  // fake-definition.ts's own comment already established for this repo's images).
  acpCommand: ['node', '/repo/agents/claude-code/dist/src/bridge-server.js'],
  bridge: { transport: 'websocket', listenPort: 8080 },
  stableAcpVersions: [1],
  custody: {
    driverId: 'claude-code-transcript',
    readFormats: [{ formatId: 'claude-code-transcript-v1', formatVersion: '1' }],
    writeFormat: { formatId: 'claude-code-transcript-v1', formatVersion: '1' },
    // The one native-state root the spike identified — never the rest of $HOME/.claude, which is
    // global installation state, not Session-specific (agents/claude-code/src/custody.ts's own doc).
    captureRoots: ['/home/node/.claude/projects/-home-node-work'],
    // The OneCLI placeholder never actually reaches disk (CLAUDE_CODE_OAUTH_TOKEN is an env var,
    // verified live) — this is the same defensive-placeholder pattern `fake-definition.ts` already
    // uses: the path real Claude Code writes interactive OAuth state to if it ever fell back to
    // that mode (misconfiguration, not this harness's real auth path), so a future driver change
    // can never silently start sweeping it up.
    credentialExclusions: ['/home/node/.claude/.credentials.json'],
    consistency: 'process-quiescence',
    restoreCollision: 'fail-if-present',
    // A generous, bounded cap for a real, potentially long-running transcript — not tuned against
    // real production usage yet, first-pass estimate pending live observation.
    maxBytes: 16_777_216,
  },
  resources: {
    // First-pass estimate for a real Node 22 + Claude Agent SDK process, heavier than the trivial
    // fake Agent's — not yet tuned against live measured usage.
    requests: { cpu: '250m', memory: '256Mi' },
    limits: { cpu: '1000m', memory: '1Gi', ephemeralStorage: '512Mi' },
  },
  health: { path: '/healthz', initialDelaySeconds: 2, timeoutSeconds: 2 },
  // Registered and launchable for staff/testing, not yet general availability: the full
  // materialize -> real ACP handshake -> capture -> Pod replacement -> restore -> resume path has
  // not been re-proven inside an actual Kubernetes Pod (the spike proved it as a plain process).
  rollout: 'internal',
}

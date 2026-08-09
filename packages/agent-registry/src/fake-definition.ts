import type { AgentRuntimeDefinition } from './types.js'

/**
 * The registry entry for the fake Agent runtime image (packages/acp's `createFakeAgent`, wrapped
 * behind an ACP bridge listener — see apps/session-runtime-controller/fake-agent-image/). Used by
 * this plan's own tests and by P04's live-cluster verification; `imageDigest` is filled in once
 * that image is actually built and pushed (plans/04-session-runtime-controller.md Evidence has the
 * real digest).
 */
export const FAKE_AGENT_DEFINITION: AgentRuntimeDefinition = {
  agentId: 'fake-agent',
  version: '2026-08-03',
  label: 'Fake Agent (tests)',
  description: 'Deterministic in-process fake ACP Agent, wrapped for Session Runtime controller tests.',
  imageDigest: 'ghcr.io/arnaultbretagne/agora-fake-agent@sha256:6a89f69b789cf01dda473de205c4be559a827eeb159532268425a38d05854fac',
  // Matches fake-agent-image/Dockerfile's actual layout: the whole monorepo is copied to /repo and
  // built in place, so the entrypoint lives where the build put it, not at some separate /app.
  acpCommand: ['node', '/repo/apps/session-runtime-controller/dist/src/fake-agent-server.js'],
  bridge: { transport: 'websocket', listenPort: 8080 },
  stableAcpVersions: [1],
  custody: {
    driverId: 'fake-agent-null',
    readFormats: [{ formatId: 'fake-agent-null', formatVersion: '1' }],
    writeFormat: { formatId: 'fake-agent-null', formatVersion: '1' },
    captureRoots: ['/home/node/work'],
    credentialExclusions: ['/home/node/work/.credentials'],
    consistency: 'process-quiescence',
    restoreCollision: 'fail-if-present',
    maxBytes: 1_048_576,
  },
  resources: {
    requests: { cpu: '50m', memory: '64Mi' },
    limits: { cpu: '250m', memory: '128Mi', ephemeralStorage: '256Mi' },
  },
  health: { path: '/healthz', initialDelaySeconds: 1, timeoutSeconds: 1 },
  rollout: 'enabled',
}

import type { AgentRuntimeDefinition } from './types.js'

/**
 * `agents/codex/SPIKE.md` (2026-08-05, real infra, real ChatGPT Plus subscription, no fakes):
 * `@agentclientprotocol/codex-acp@1.1.9`, wrapped by `agents/codex/src/bridge-server.ts` behind the
 * ACP bridge WebSocket listener — same shape as `claude-code-definition.ts`. A live Kubernetes Pod
 * pass (mirroring `claude-code`'s own) was completed the same day: real `initialize` ->
 * `session/new` -> `session/prompt` -> `/custody` capture, a real auth-stub bug found and fixed
 * along the way (a fabricated id_token failed codex-acp's own local identity validation; fixed by
 * reading the real linked account's id_token from a stub file instead). `rollout` stayed
 * `'internal'` through all of that on purpose — general availability is a product call for a human
 * to make. That call was made 2026-08-06 (the operator, after hitting the gate live trying to
 * create a real Workstream through the real product UI): `rollout: 'enabled'`.
 */
export const CODEX_DEFINITION: AgentRuntimeDefinition = {
  agentId: 'codex',
  version: '2026-08-05',
  label: 'Codex',
  description: 'OpenAI Codex via the official Agent Client Protocol adapter, credentialed through the Broker/OneCLI path.',
  // The multi-arch index digest (`docker push`'s own reported digest for the `:latest` tag) —
  // containerd/k0s resolve this to the right platform manifest automatically, same as pulling by
  // tag would, but pinned so a later `:latest` push can never silently change what launches.
  imageDigest: 'ghcr.io/arnaultbretagne/agora-codex@sha256:9fab3cbb5a1af528ce37e3ec28d8cd76e86027cee2e2b57b5789cc6ad6001326',
  // Matches agents/codex/image/Dockerfile's actual layout: the whole monorepo is built in place
  // under /repo, and the entrypoint lives where that build put it (same pattern claude-code's own
  // definition already established for this repo's images).
  acpCommand: ['node', '/repo/agents/codex/dist/src/bridge-server.js'],
  bridge: { transport: 'websocket', listenPort: 8080 },
  stableAcpVersions: [1],
  custody: {
    driverId: 'codex-transcript',
    readFormats: [{ formatId: 'codex-transcript-v1', formatVersion: '1' }],
    writeFormat: { formatId: 'codex-transcript-v1', formatVersion: '1' },
    // The one native-state root the spike identified holds ONE file that matters — the exact
    // rollout under it is date-partitioned, not deterministic from sessionId alone, so
    // `agents/codex/src/custody.ts` locates it by search within this root rather than a fixed
    // sub-path (unlike claude-code's single deterministic file). Never the rest of $HOME/.codex
    // (`*.sqlite` state/memories/goals/logs, `cache/`, `skills/`), which is global installation
    // state, not Session-specific — proven live: resume worked from a bare HOME with ONLY the one
    // rollout file present, no sqlite state at all.
    captureRoots: ['/home/node/.codex/sessions'],
    // The OneCLI placeholder never actually reaches the network (verified live: codex-acp validates
    // it locally as a real JWT shape and never gets past that check with it) — same defensive-
    // placeholder pattern `claude-code-definition.ts` already uses: a fixed, non-secret, never-
    // functional credential file this harness's own image constructs deterministically (see
    // `agents/codex/src/bridge-server.ts`'s `ensureCodexAuthStub`), so a future driver change can
    // never silently start sweeping up a REAL one from here.
    credentialExclusions: ['/home/node/.codex/auth.json'],
    consistency: 'process-quiescence',
    restoreCollision: 'fail-if-present',
    // A generous, bounded cap for a real, potentially long-running rollout transcript — not tuned
    // against real production usage yet, first-pass estimate pending live observation (same
    // approach `claude-code-definition.ts` took).
    maxBytes: 16_777_216,
  },
  resources: {
    // First-pass estimate, same shape as claude-code's own — not yet tuned against live measured
    // usage.
    requests: { cpu: '250m', memory: '256Mi' },
    limits: { cpu: '1000m', memory: '1Gi', ephemeralStorage: '512Mi' },
  },
  health: { path: '/healthz', initialDelaySeconds: 2, timeoutSeconds: 2 },
  // General availability, decided 2026-08-06 (module doc comment) — new Sessions may launch this
  // agent through the normal product flow now, not just resume/staff-testing paths.
  rollout: 'enabled',
}

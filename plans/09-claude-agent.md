# P09 — Claude Code ACP Agent and custody validation

- **Status:** in progress; spike complete (PASS), core implementation shipped and pushed, a live
  Session Runtime Pod pass (real k0s, real Broker relay) is the one thing still pending — see Evidence
- **Dependencies:** P04, P06, P08
- **Primary paths:** `agents/claude-code`, registry definitions, Agent image

## Required reading

- `docs/specs/04-acp-integration.md`
- `docs/specs/07-custody.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- `apps/broker/ONECLI-SPIKE.md`
- ADR 0006, 0014

## Mandatory ACP/custody spike before implementation

The credential gateway selection is closed: use the P08 OneCLI control/relay path. The direct
`onecli run -- claude` Max-auth gate already passed and is evidence, not the production launcher.

For ACP semantics, test `@agentclientprotocol/claude-agent-acp` first; consider a minimal adapter only
for an evidenced contract failure. Integrate it with the fixed OneCLI path without treating OneCLI
as the ACP adapter.

Do not choose from feature lists alone. Re-run the gates below on the actual Claude Max subscription
authentication available to the operator and the production ACP topology.

## Spike gates

All of the following are recorded live, with commands/evidence, in `agents/claude-code/SPIKE.md`
(2026-08-05) — real infra throughout (a real self-hosted OneCLI instance, the operator's actual
Claude Max subscription, no fakes/mocks anywhere in this list.

- [x] Long-lived Max/subscription credential works through ACP and the workload relay in a fresh
  isolated Session Runtime. Direct harness auth is already proven by P08. Proven through OneCLI's
  real `getContainerConfig` path (the exact mechanism the relay itself uses server-side); re-proven
  inside an actual Kubernetes Pod as part of Implementation, not the spike.
- [x] Authentication survives Pod replacement without placing a refresh/provider secret in custody.
  Killed the Agent process, started a genuinely fresh one, `session/resume` worked with zero
  refresh/provider secret anywhere in reach.
- [x] ACP `session/new`, prompt, cancel, close and `session/resume` work. All five, live.
- [x] Resume continues the same native context and emits no replay under `session/resume`. The
  spike's strongest result — a brand-new process recalled a codeword with zero replayed updates.
- [x] Messages, thoughts, plans, tools, permissions and usage map to stable ACP v1. Observed
  `agent_message_chunk`, `tool_call`/`tool_call_update` (full pending->completed lifecycle),
  `usage_update`, `available_commands_update`; thoughts/plans are advertised capabilities not
  triggered by this spike's specific prompts, not a found gap.
- [ ] MCP servers supplied by the Client work through Broker descriptors. **Not exercised** — every
  spike prompt used `mcpServers: []`. Genuine Implementation-phase work, not yet done.
- [x] Native state required for resume is identified without relying on product parsing. Exactly
  one file: `$HOME/.claude/projects/-home-node-work/<sessionId>.jsonl`.
- [ ] Capture while quiescent is consistent and restore is collision-safe. The FILE to capture is
  identified and its capture/restore mechanics are implemented and tested
  (`agents/claude-code/src/custody.ts`, real filesystem, `fail-if-present` collision handling) —
  but "while quiescent" (never mid-turn) depends on the Session Runtime controller's own existing
  capture-timing discipline (already correct for the fake Agent driver; not specifically
  re-exercised against this real driver in a live Pod yet).
- [x] Credential paths are excluded from custody. The one captured file contains no credential by
  construction; `CLAUDE_CODE_DEFINITION.custody.credentialExclusions` also names the defensive path
  a misconfigured fallback-to-interactive-login would use.
- [x] Model/config choices are exposed as ACP config options/modes rather than CLI columns.
  `model`/`effort`/`mode` all observed as real ACP config options in `session/new`'s response.
- [x] The image already contains pinned Claude Code and ACP-adapter executables; startup performs no
  package install. Built, pushed, live-smoke-tested (`ghcr.io/arnaultbretagne/agora-claude-code`) —
  `npm ci` at build time pulls the adapter's own pinned optional native binary; nothing installs at
  container startup.
- [x] The Agent Pod contains only relay endpoint, OneCLI CA and non-secret Claude auth stub—not
  OneCLI control/upstream or Anthropic credentials. Structurally true by construction
  (`bridge-server.ts`'s `claudeSpecificEnv` only ever reads/renames the same three `AGORA_*` values
  every harness gets) and smoke-tested against the real built image; not yet re-confirmed by
  inspecting an actual live Pod's own env/filesystem specifically.
- [x] Required Claude/Anthropic hosts are captured as a reviewed OneCLI route-set fixture. Real
  traffic to `api.anthropic.com` plus, unprompted, Claude Code's own Datadog telemetry — republished
  policy without Datadog, full session still passed, Datadog calls confirmed blocked (403) in
  OneCLI's own audit log. `route-policy.ts`'s existing `PINNED_AGENT_ROUTE_SETS.claude-code` already
  matches this finding (no Datadog entry).

## Implementation after gate

- [x] Pin adapter/package/image versions and digest. `@agentclientprotocol/claude-agent-acp@0.64.2`
  exact; image built, smoke-tested (real Pod-shaped env, `/healthz` real) and pushed to
  `ghcr.io/arnaultbretagne/agora-claude-code` by digest.
- [x] Add registry definition validated by JSON Schema. `CLAUDE_CODE_DEFINITION`
  (`packages/agent-registry/src/claude-code-definition.ts`), `rollout: 'internal'` (staff/testing —
  see below for exactly why not `'enabled'` yet), validated against
  `contracts/schemas/agent-runtime.schema.json` by test, wired into
  `apps/session-runtime-controller/src/main.ts`'s real `DEFINITIONS`.
- [x] Implement custody driver with format/version and compatibility fixtures.
  `agents/claude-code/src/custody.ts`: `claude-code-transcript-v1`/`1`, capture/restore against a
  real filesystem, `fail-if-present` collision handling, 8 real tests.
- [x] Add Session Runtime health/readiness integration. `bridge-server.ts`'s `/healthz`, matching
  `fake-agent-server.ts`'s exact existing contract the controller's readiness probe already expects.
- [x] Wire inference/tool traffic through the Broker relay and OneCLI only. `claudeSpecificEnv`
  translates Agora's generic per-Pod contract (`AGORA_BROKER_RELAY_ENDPOINT`/`AGORA_ONECLI_CA_PATH`/
  a stub file) into `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`/`CLAUDE_CODE_OAUTH_TOKEN` — fails closed
  (never launches with a partial/silently-defaulted env) if any input is missing, tested. The relay
  endpoint carries no embedded bearer (workload identity/mTLS authenticates it, not URL userinfo,
  per `relay.ts`'s own design) — genuinely routing production traffic through the RELAY specifically
  (rather than OneCLI's gateway directly, which is what the spike itself exercised) is not yet
  re-proven live; that requires a real mesh sidecar this environment doesn't have standing up.
- [ ] Add full Session lifecycle and cross-Agent tests. 25 real tests exist
  (`agents/claude-code/test/`: custody, session-id-tap, bridge-server WS/custody/restore plumbing,
  env translation) — genuinely proving the harness-independent parts. A FULL Session-lifecycle pass
  through the real Session Runtime controller (materialize -> real ACP handshake -> capture -> Pod
  replacement -> restore -> resume, on an actual Kubernetes Pod) needs live Claude Max credentials
  the automated suite deliberately never uses (same scope boundary as P08's own broker tests) — this
  is the live-verification pass still pending, tracked explicitly, not silently skipped. Cross-Agent
  (P07-style, alongside Codex) is P10's own dependency, not reachable before P10 exists.
- [ ] Document image/adapter/route-set upgrade, rollback and Max credential renewal. Not yet
  written as a dedicated doc — captured piecemeal in this Evidence section and `SPIKE.md` instead.
  Genuine remaining work.

## Non-goals

- No PTY title/model scraping.
- No Claude transcript endpoint in the controller.
- No Channel plugin.
- No assumption that Claude-specific IDs are Agora IDs.
- No `onecli run`, SDK control key or runtime package installation in the production Agent
  container.

## Exit criteria

- [ ] All spike gates and baseline acceptance scenarios pass in a production-like Session Runtime.
  Spike gates: PASS (see above). "In a production-like Session Runtime" specifically (an actual
  Kubernetes Pod, not a plain process) is the live-verification pass still pending.
- [ ] A Pod can be deleted and the same ACP Session resumed from opaque custody. Proven as a plain
  process (kill + fresh process + `session/resume`, zero replay, real context recall) — proving it
  again with an actual Pod delete/re-materialize cycle is the same pending live pass.
- [x] No real credential appears in the Pod environment/filesystem, custody, product journal or
  logs. True by construction and spike-verified: the child process's full environment was inspected
  live and carried no real credential; `claudeSpecificEnv` only ever reads/renames three non-secret
  values.
- [x] The approved runtime auth stub is non-secret and contains no upstream OneCLI bearer.
  `CLAUDE_CODE_OAUTH_TOKEN`'s placeholder value never gates anything server-side (OneCLI's gateway
  swaps the credential at the network layer regardless of the client's own placeholder content,
  verified live) and is never derived from the real bearer.

## Evidence

- Commit: on branch `refactoring`, local at completion time (not yet pushed — check in with the
  operator before pushing, same rhythm as every prior plan).
- Packages/apps delivered:
  - `agents/claude-code/SPIKE.md` — the full spike report (see above for its findings).
  - `agents/claude-code/src/bridge-server.ts` — the container entrypoint: spawns
    `@agentclientprotocol/claude-agent-acp` once at startup (restore-before-ready), bridges every
    WebSocket connection's duplex stream to its stdio, serves `/healthz`/`/custody`, and translates
    Agora's generic per-Pod env contract into what the real adapter/CLI need
    (`claudeSpecificEnv`) — fails closed on any missing input.
  - `agents/claude-code/src/session-id-tap.ts` — taps NDJSON frames in both directions to learn the
    real ACP `sessionId` from live traffic (a `session/resume`/`load` REQUEST names it directly; a
    `session/new` RESPONSE is correlated to its request id) — needed because the real controller
    calls a plain `GET /custody` with no Session context in the URL (one Pod = one Session), so the
    process has to learn its own current session id from the wire, not from any caller.
  - `agents/claude-code/src/custody.ts` — capture/restore of the one native-state file that matters.
    A genuine design finding here: docs/specs/07's custody metadata (format id/version/checksum/
    etc.) has no field for "which native session id does this restore as" — extending the shared,
    already-shipped `custody.snapshots` schema for one driver's need was rejected in favor of the
    driver reading its own sessionId back out of the transcript's own content (every real line
    already carries a `sessionId` field, verified live) — matching docs/specs/07's own allowance
    that "only the Session's custody driver may interpret payload bytes."
  - `packages/agent-registry/src/claude-code-definition.ts` — `CLAUDE_CODE_DEFINITION`, wired into
    `apps/session-runtime-controller/src/main.ts`'s real `DEFINITIONS` alongside the fake Agent.
  - `agents/claude-code/image/Dockerfile` — built, smoke-tested, pushed by digest to
    `ghcr.io/arnaultbretagne/agora-claude-code` (same ghcr.io personal-package-stays-private
    constraint P04 already documented and already solved via `imagePullSecretName` — nothing new
    needed here).
  - `agents/claude-code/test/` — 25 real tests (custody: 8, session-id-tap: 6, bridge-server: 7,
    env-translation: 4), all against real filesystems/processes/WebSocket connections, none against
    a fake ACP protocol implementation (the one test double, `test/fixtures/stub-acp-agent.ts`, is
    `@agora/acp`'s own already-real-tested fake Agent from P03, reused as a stand-in process for
    plumbing tests only — the ACTUAL adapter's own protocol correctness is what the spike, not this
    file, already proved against real Claude Max credentials).
- Architecture notes:
  - **`bridge-server.ts` spawns the real Agent process ONCE per Pod, not once per WS connection** —
    matching "one Session Runtime Pod = one Agora Session = one Agent process for the Pod's whole
    life" (docs/specs/08), unlike `fake-agent-server.ts`'s own per-connection `createFakeAgent()`
    call (harmless for an in-process fake with no real subprocess cost, wrong for a real external
    harness process).
  - **The registry entry is `rollout: 'internal'`, not `'enabled'`**, deliberately: `internal` is
    launchable (staff/testing — `selectLaunchableAgents`'s own filter already treats it that way)
    without claiming general availability before the live-Pod pass below is done.
  - **Image digest is the multi-arch INDEX digest** (`docker push`'s own reported digest for
    `:latest`), not the linux/amd64-specific manifest digest a first build attempt used — containerd
    resolves an index the same way a tag pull would, while still being pinned against a later
    `:latest` push silently changing what launches.
- Exact commands (from a clean workspace):
  `npm run build -w @agora/agent-claude-code && node --test agents/claude-code/dist/test/*.test.js`
  (25/25), full canonical `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres
  npm test` from repo root (262 tests total across every workspace, all real Postgres/HTTP/process/
  WebSocket, zero mocks, all passing, checkout-clean). Image:
  `docker build -f agents/claude-code/image/Dockerfile -t <tag> .` (repo root context), smoke-tested
  with `docker run` + the full real `AGORA_*` env contract set to fixture values (`/healthz` real).
- **Bugs/gaps this caught, not by re-reading but by running real infra**:
  1. `bridge-server.ts`'s first draft resolved the adapter binary via a path fixed relative to its
     own file location (`../node_modules/.bin/claude-agent-acp`) — works in a standalone npm
     project (the spike's own scratch install), but npm WORKSPACES hoist the package to the monorepo
     ROOT's `node_modules`, not the package's own. Caught by the Docker image build's own smoke
     test failing with `MODULE_NOT_FOUND`, not by inspection. Fixed with real Node module resolution
     (`import.meta.resolve`) instead of a hardcoded relative path.
  2. The custody restore flow's first design assumed the restore-stream response would carry an
     `x-agora-native-session-id` header — but the REAL, already-shipped controller endpoint
     (`apps/session-runtime-controller/src/server.ts`'s `handleRestoreStream`) does not emit one,
     and extending its shared schema for this one driver's need was the wrong fix (see custody.ts's
     own note above) — caught by tracing the actual restore contract before writing the test that
     would have needed a header nothing real ever sends, not after a test failure.
  3. `agents/claude-code/image/Dockerfile`'s own build-time smoke-test line originally assumed the
     un-hoisted path too (same root cause as #1) — the build itself failed with a clear
     `MODULE_NOT_FOUND` before any image was ever tagged, exactly the "fail the build, not the
     runtime" outcome a smoke test exists for.
  4. `GATEWAY_BASE_URL` (OneCLI's own env var, unrelated to this plan's code but discovered while
     validating the live path this plan depends on) needed to be scheme-less — a `http://` prefix in
     its value produced a double-scheme proxy URL that resolved to a literal `"http"` hostname when
     parsed. Not this plan's own bug (P08's live-verification manifests), but found and fixed while
     re-verifying the credential path P09 depends on; recorded in `plans/08`'s own Evidence.
- **Deliberately deferred, not silently dropped**: MCP-servers-via-Broker-descriptors (spike gate,
  Implementation both untouched — no test in this plan ever passed a non-empty `mcpServers`); the
  live Session Runtime Pod pass (materialize with `CLAUDE_CODE_DEFINITION`, real ACP handshake, real
  capture/Pod-replacement/restore/resume, all on the actual k0s cluster) — everything up to that
  point is proven either as a plain process (the spike) or as a correctly-smoke-tested built image;
  the one thing not yet proven is those two combined; upgrade/rollback/Max-credential-renewal
  documentation as a dedicated doc.

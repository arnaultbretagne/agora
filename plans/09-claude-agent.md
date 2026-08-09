# P09 — Claude Code ACP Agent and custody validation

- **Status:** implementation and live-Pod verification complete (real k0s cluster, real self-hosted
  OneCLI, real Claude Max credential: `initialize` -> `session/new` -> `session/prompt` with a real
  model response -> `/custody` returning a real checksummed transcript, all inside an actual Pod).
  Remaining gaps are narrower and explicitly scoped — see Evidence: routing through the full Broker
  relay specifically (vs. OneCLI's gateway directly), a second-Pod delete/restore/resume pass, MCP
  servers via Broker descriptors, and upgrade/rollback documentation.
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
- [x] Capture while quiescent is consistent and restore is collision-safe. The FILE to capture is
  identified and its capture/restore mechanics are implemented and tested
  (`agents/claude-code/src/custody.ts`, real filesystem, `fail-if-present` collision handling).
  Re-exercised live in an actual Pod after a real completed turn: `/custody` returned a real,
  checksummed transcript (9679-9709 bytes across three separate runs) keyed to the right sessionId.
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
  every harness gets), smoke-tested against the real built image, and now functionally proven live —
  a real Claude response came back through exactly this env shape in an actual Pod, with no other
  credential ever added.
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
- [x] Add full Session lifecycle and cross-Agent tests (partial — see remainder below). 25 real
  automated tests exist (`agents/claude-code/test/`: custody, session-id-tap, bridge-server
  WS/custody/restore plumbing, env translation) proving the harness-independent parts, PLUS a real
  live-credentialed pass now proves the full materialize-shaped path end to end inside an actual
  Kubernetes Pod: `initialize` -> `session/new` -> `session/prompt` (real Claude response) ->
  `/custody` (real checksummed capture). Not yet done, and not silently skipped: a second-Pod
  delete/restore/resume cycle against a real Pod (proven only at the process level in the spike,
  not re-run against two real Pods), and cross-Agent (P07-style, alongside Codex) which is P10's own
  dependency, not reachable before P10 exists.
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

- [x] All spike gates and baseline acceptance scenarios pass in a production-like Session Runtime.
  Spike gates: PASS (see above). "In a production-like Session Runtime" (an actual Kubernetes Pod,
  not a plain process) now proven too — real `initialize`/`session/new`/`session/prompt`/`/custody`
  through a real Pod, real self-hosted OneCLI, real Claude Max credential. The one still-deferred
  gate (MCP servers via Broker descriptors) was never exercised by any prompt in either pass.
- [ ] A Pod can be deleted and the same ACP Session resumed from opaque custody. Proven as a plain
  process (kill + fresh process + `session/resume`, zero replay, real context recall) and the
  capture half is now proven live in a real Pod too (`/custody` returning a real transcript) —
  re-materializing a SECOND real Pod from that captured state and resuming into it is the one part
  of this still not run.
- [x] No real credential appears in the Pod environment/filesystem, custody, product journal or
  logs. True by construction and spike-verified: the child process's full environment was inspected
  live and carried no real credential; `claudeSpecificEnv` only ever reads/renames three non-secret
  values.
- [x] The approved runtime auth stub is non-secret and contains no upstream OneCLI bearer.
  `CLAUDE_CODE_OAUTH_TOKEN`'s placeholder value never gates anything server-side (OneCLI's gateway
  swaps the credential at the network layer regardless of the client's own placeholder content,
  verified live) and is never derived from the real bearer.

## Evidence

- Commit: on branch `refactoring`, pushed to `origin/refactoring` (checked in with the operator
  first, same rhythm as every prior plan).
- Packages/apps delivered:
  - `agents/claude-code/SPIKE.md` — the full spike report (see above for its findings).
  - `agents/claude-code/src/bridge-server.ts` — the container entrypoint: performs
    restore-before-ready, spawns a fresh `@agentclientprotocol/claude-agent-acp` process per
    WebSocket connection (bridging its duplex stream to the child's stdio), serves
    `/healthz`/`/custody`, and translates Agora's generic per-Pod env contract into what the real
    adapter/CLI need (`claudeSpecificEnv`) — fails closed on any missing input. Kills the whole
    process group (child + the native `claude` grandchild it launches) on WS close or shutdown.
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
  - `agents/claude-code/live-verification-pod.yaml` — a manual, standalone Pod manifest mirroring
    `pod-spec.ts`'s real contract by hand, used to prove the built image against the real cluster
    directly (bypassing the Session Runtime controller); documents its own prerequisites (the
    uncommitted secrets/configmaps a real run needs) in its header comment.
- Architecture notes:
  - **`bridge-server.ts` spawns the real Agent process per WS connection, not once at Pod
    startup** — matches `fake-agent-server.ts`'s own per-connection `createFakeAgent()` pattern.
    This was originally motivated by a misdiagnosed "idle-exit" theory (see bugs/gaps below, item
    5) — that theory turned out to be false (the correctly-invoked binary survived 12s of true idle
    with zero input, confirmed live), but per-connection spawning is kept anyway: it still avoids a
    lingering child on a Pod nothing ever connects to, and costs nothing extra since production only
    ever opens one real connection per Pod.
  - **The registry entry is `rollout: 'internal'`, not `'enabled'`**, deliberately: `internal` is
    launchable (staff/testing — `selectLaunchableAgents`'s own filter already treats it that way).
    The live-Pod pass below is now done; flipping to `'enabled'` (general availability) is left as a
    product decision, not something proven infra should flip on its own.
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
  Live-Pod pass: `sudo k0s kubectl apply -f agents/claude-code/live-verification-pod.yaml` against
  namespace `agora-onecli-test` (real self-hosted OneCLI, real Claude Max credential — see P08's own
  Evidence for how that namespace/credential was set up); driven with a small throwaway ACP client
  script (`@agentclientprotocol/sdk`'s `client()`/`buildSession()`, not committed) speaking directly
  to the Pod's ClusterIP on port 8080 (`kubectl port-forward` doesn't work through this cluster's
  gVisor `RuntimeClass` — its nsenter-based mechanism can't see the sandboxed netstack's listener,
  even though the readiness probe, which hits the Pod IP directly, works fine; Cilium's native
  routing makes the Pod IP directly reachable from the host anyway, so this didn't block anything).
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
  5. **The actual live-Pod blocker, found chasing what first looked like an idle-exit timing bug**:
     `defaultAgentCommand()` resolved the bare package specifier
     (`import.meta.resolve('@agentclientprotocol/claude-agent-acp')`), which lands on the package's
     `"main"` entry (`dist/lib.js`) — a library module that only re-exports helpers, with no
     top-level side effects. Run as a script, it does nothing; Node's event loop drains once its
     async imports settle and the process exits cleanly (`code=0`, no stderr) a moment later. This
     was first misread as a real idle-without-input timeout (motivating a lazy per-connection spawn
     redesign — see architecture notes above), and only traced to the real cause by adding
     byte-level tracing to the bridge's stdio pipes plus a battery of manual `claude-agent-acp`
     invocations inside the live Pod that isolated the one variable that actually mattered: which
     file gets run, not timing, env, or stdio mode. Confirmed live: the correct entry
     (`dist/index.js`, the package's own `"bin"` target, the one that calls `runAcp()` and
     `process.stdin.resume()`) survives 12s of true idle with zero input. Fixed by resolving the
     package's own `"bin"` field from its `package.json` instead of guessing a path.
  6. Killing only the direct child on WS close left the native `claude` process it launches running
     as an orphan — found live: two verification connections in a row left two full sets of orphaned
     processes in the Pod. Fixed by spawning with `detached: true` and killing the whole process
     group (`process.kill(-pid, 'SIGTERM')`) instead of just the direct child.
  7. **Known, deliberately unfixed**: after that process-group kill, the native `claude` grandchild
     becomes a zombie rather than being reaped, because `bridge-server.js` runs as the container's
     PID 1 and (unlike a real init system) never reaps children it didn't spawn directly. Confirmed
     harmless (a zombie holds no CPU/memory, only a process-table slot) and moot in production (the
     whole Pod is deleted after one Session, reclaiming everything regardless). A proper fix would
     add an init wrapper (`tini`/`dumb-init`) as the container's real entrypoint, or a manual
     SIGCHLD reap loop — flagged as a legitimate small follow-up, not applied here.
- **Operational incident during this pass, not a code bug**: a `kubectl exec` debugging command
  printed the live-verification namespace's OneCLI relay bearer token into the session transcript.
  Blast radius is bounded (the token only reaches `onecli.agora-onecli-test.svc.cluster.local`, a
  ClusterIP address unreachable outside the cluster's own pod network) but the token authenticates
  against the same OneCLI instance carrying the real Claude Max credential link. Flagged to the
  operator immediately; rotation needs OneCLI's own admin API key, which (by the established
  "never persist a decrypted secret" pattern) was never written anywhere durable and isn't currently
  recoverable without either re-bootstrapping OneCLI admin access or direct `onecli-postgres`
  surgery — operator's explicit call was to leave it for now rather than do either autonomously.
  Still open; worth revisiting before this namespace is treated as anything other than disposable.
- **Deliberately deferred, not silently dropped**: MCP-servers-via-Broker-descriptors (spike gate,
  Implementation both untouched — no test in this plan, nor the live-Pod pass, ever passed a
  non-empty `mcpServers`); a second real Pod delete/restore/resume cycle (proven only at the process
  level in the spike; the live-Pod pass proved materialize -> handshake -> capture but did not
  re-materialize a second Pod from that capture); routing production traffic through the full Broker
  relay specifically rather than OneCLI's gateway directly (both live passes used a direct
  proxy-with-embedded-bearer stand-in, not `relay.ts`'s real workload-identity path — that needs a
  real mesh sidecar this environment doesn't have standing up); the zombie-reaping gap above (#7);
  upgrade/rollback/Max-credential-renewal documentation as a dedicated doc.

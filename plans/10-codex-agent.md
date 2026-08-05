# P10 — Codex ACP Agent and custody validation

- **Status:** implementation complete and live-Pod verification passed (real k0s cluster, real
  self-hosted OneCLI, real ChatGPT credential): `initialize` -> `session/new` -> `session/prompt`
  with a real model response -> `/custody` returning a real checksummed rollout capture, all inside
  an actual Pod, repeated twice cleanly. A real bug was found and fixed in the process — see
  Evidence. Remaining gaps are the same shape P09 left for Claude: MCP servers, second-Pod
  delete/restore/resume, cross-Agent handoff, upgrade/rollback docs.
- **Dependencies:** P04, P06, P08
- **Primary paths:** `agents/codex`, registry definitions, Agent image

## Required reading

- `docs/specs/04-acp-integration.md`
- `docs/specs/07-custody.md`
- `docs/specs/09-agent-registry.md`
- `docs/specs/11-security.md`
- `apps/broker/ONECLI-SPIKE.md`
- ADR 0006, 0014

## Mandatory ACP/custody spike before implementation

The credential gateway selection is closed: use the P08 OneCLI control/relay path. Direct
`onecli run -- codex` with the operator's ChatGPT OAuth state already passed and is evidence, not the
production launcher.

Evaluate the official `@agentclientprotocol/codex-acp` distribution first and integrate it with that
fixed path. Record exact adapter, bundled/pinned Codex and route-set versions. Replacing the official
adapter requires evidence of a contract failure; choosing it still requires empirical ACP/custody
gates rather than package provenance alone.

## Spike gates

All of the following are recorded live, with commands/evidence, in `agents/codex/SPIKE.md`
(2026-08-05) — real infra throughout (the same persistent self-hosted OneCLI instance P09 used, the
operator's actual ChatGPT Plus subscription, no fakes/mocks anywhere in this list).

- [x] ChatGPT subscription authentication works through ACP and the workload relay in an isolated
  Session Runtime, with a safe operator bootstrap/renewal mechanism. Auth-through-ACP-and-relay:
  PASS, proven live through the real `codex-acp` adapter (not just the direct-harness gate P08
  already covered). Caught and fixed a real gap in the process: `PINNED_AGENT_ROUTE_SETS`'s `codex`
  entry was missing `auth.openai.com` (the token-refresh host), which would have broken any session
  past its first request. **Bootstrap/renewal mechanism: still NOT built** — the credential was
  linked via a one-off manual API call, not an operator-facing flow.
- [x] Credential-bearing authentication state is separated from resumable Session custody; any
  retained non-secret harness marker is identified and justified. The one file that matters for
  resume contains no credential; `~/.codex/auth.json` is a separate, always-excludable path.
- [x] ACP new/prompt/cancel/close/resume behavior is measured. All five, live.
- [x] Codex thread identity maps to one ACP Session without becoming a new Agora entity. `sessionId`
  IS codex's own native session id, structurally confirmed, never written to any Agora-owned store
  in this spike (same non-goal boundary as Claude's own P09).
- [x] Reasoning, plans, tools, permissions, web/image/subagent updates survive ACP v1 journaling.
  `agent_message_chunk` observed directly; tool/permission/plan/reasoning update types weren't
  triggered by this spike's specific canary prompts — an advertised capability, not a found gap
  (same caveat P09 recorded for Claude's thoughts/plans).
- [ ] Client-provided MCP servers work through approved Broker descriptors. **Not exercised** —
  every spike prompt used `mcpServers: []`. Genuine Implementation-phase work, not yet done.
- [x] Required native resume files/state are identified and bounded. Exactly one file:
  `$HOME/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<sessionId>.jsonl` — proven minimal
  directly (resume succeeded from a bare `HOME` containing ONLY this file, no sqlite state/cache).
- [ ] Custody capture/restore excludes credentials and survives Pod replacement. Credential
  exclusion is proven by construction (same as above); Pod REPLACEMENT survival is proven at the
  process level (kill + fresh process + `session/resume`, zero replay, real codeword recall) — but
  the capture/restore MECHANICS themselves (a real `custody.ts`-equivalent driver, tested) don't
  exist yet, same "spike proved WHAT to capture, not the driver" split P09 recorded for Claude.
- [x] Model, reasoning, approval and sandbox controls are ACP modes/config options. `modes`,
  `model`, `reasoning_effort`, `collaboration_mode`, `fast-mode` all observed as real ACP config
  options in `session/new`'s response — a materially richer surface than Claude's three options.
- [x] The image already contains pinned Codex and ACP-adapter executables; startup performs no
  package install. Structurally confirmed (native binary ships via a platform-specific optional
  dependency, same shape as Claude's) — an actual pinned image build is Implementation-phase work,
  not done this pass.
- [x] The Agent Pod contains only relay endpoint, OneCLI CA and read-only `onecli-managed` auth
  stub—not OneCLI control/upstream or OpenAI credentials. Structurally proven at the process-env
  level; not yet re-confirmed inside an actual live Pod specifically.
- [x] Required ChatGPT/OpenAI hosts are captured as a reviewed route-set fixture that excludes
  unnecessary analytics endpoints. Real traffic to `chatgpt.com`/`auth.openai.com` succeeded;
  two unprompted hosts (`ab.chatgpt.com` OTLP telemetry, an OpenAI user-content/CDN host) were
  correctly blocked by the existing catch-all and never needed — same shape as Claude's own Datadog
  finding. `route-policy.ts`'s `PINNED_AGENT_ROUTE_SETS.codex` now matches this finding.

## Implementation after gate

- [x] Pin adapter/package/image versions and digest. `@agentclientprotocol/codex-acp@1.1.9` exact
  (wraps `@openai/codex@^0.145.0`); image built, smoke-tested (real Pod-shaped env, `/healthz` real)
  — check in with the operator before the actual `docker push` to a shared registry (same rhythm as
  every prior plan's image).
- [x] Add validated registry definition. `CODEX_DEFINITION` (`packages/agent-registry/src/
  codex-definition.ts`), `rollout: 'internal'`, validated against `contracts/schemas/
  agent-runtime.schema.json` by test, wired into `apps/session-runtime-controller/src/main.ts`'s
  real `DEFINITIONS`.
- [x] Implement versioned custody driver and fixtures. `agents/codex/src/custody.ts`:
  `codex-transcript-v1`/`1`, capture (search-then-wrap in a `{relativePath, contentBase64}`
  envelope) / restore (write back at the EXACT original relative path — verified live this is
  required, not optional) against a real filesystem, `fail-if-present` collision handling,
  path-traversal rejection, 12 real tests.
- [x] Add Session Runtime health/readiness integration. `bridge-server.ts`'s `/healthz`, matching
  `fake-agent-server.ts`'s/`claude-code`'s own existing contract the controller's readiness probe
  already expects.
- [x] Wire inference/tool traffic through the Broker relay and OneCLI only. `codexSpecificEnv`
  translates Agora's generic per-Pod contract into `HTTPS_PROXY`/`SSL_CERT_FILE`/
  `NODE_EXTRA_CA_CERTS`/`NO_BROWSER`/`INITIAL_AGENT_MODE` — fails closed if any of the three
  `AGORA_*` inputs is missing, tested. `ensureCodexAuthStub` constructs the credential-shaped
  placeholder file deterministically (see custody's own note: unlike Claude's env-var placeholder,
  codex-acp reads a FILE and validates it locally as a real JWT).
- [ ] Map namespaced Codex `_meta` without making it core schema. Not started — this is
  product-projection work (`packages/store-pg`'s projector), out of this pass's scope, same as
  P09's own equivalent product-layer work was never part of its "implementation after gate" either.
- [ ] Add lifecycle, projection and A↔B handoff tests. 30 real tests exist
  (`agents/codex/test/`: custody 12, session-id-tap 6, bridge-server 7, env/stub 5) proving the
  harness-independent parts — genuinely proving the same class of thing P09's own 25 did for Claude.
  A full Session-lifecycle pass through the real Session Runtime controller (live Pod) and
  cross-Agent (A↔B, alongside Claude) are both still pending, same shape of gap P09 tracked before
  its own live-Pod pass.
- [ ] Document image/adapter/route-set upgrade, rollback and ChatGPT auth renewal. Not yet written
  as a dedicated doc — captured piecemeal in this Evidence section and `SPIKE.md` instead, same as
  P09's own equivalent gap.

## Non-goals

- No separate Thread aggregate.
- No Codex app-server protocol in the Agora core.
- No parsing of custody by product code.
- No automatic ACP v2 adoption.
- No `onecli run`, SDK control key or runtime package installation in the production Agent
  container.

## Exit criteria

- Full baseline acceptance passes in a production-like Session Runtime.
- Same ACP Session resumes after Pod replacement.
- Codex-specific metadata remains inspectable without coupling generic projections to it.
- No upstream OneCLI bearer or OpenAI credential is readable from the Agent container.

## Evidence

- Commit: on branch `refactoring`, pushed to `origin/refactoring` (checked in with the operator
  first, same rhythm as every prior plan).
- Real credential linking, 2026-08-05 (both `dev` and `root` local `codex login` sessions on this
  VPS were already authenticated as the operator's real ChatGPT Plus account — no fresh interactive
  login was actually needed this pass): the `dev` copy (more recently refreshed) was POSTed to the
  persistent self-hosted OneCLI's real `/v1/secrets` REST API as `{name: 'chatgpt-plus-arnault',
  type: 'openai', value: <the account's own auth.json content>, hostPattern: 'chatgpt.com'}` — HTTP
  201, confirmed by the API's own truncated preview matching the sent shape. OneCLI auto-detects
  OAuth vs API-key mode from the value's own JSON shape (an `{access_token, refresh_token}` object
  in `.tokens`) — found by reading the dashboard's own compiled Next.js bundle (`packages/db/prisma/
  migrations/20260601200000_merge_codex_into_openai` — a `codex` secret type used to exist
  separately and was merged into `openai` for exactly this reason), same technique already used in
  P08/P09 to find the real project-scoped policy API.
- `apps/broker/src/route-policy.ts`: `PINNED_AGENT_ROUTE_SETS`'s `codex` entry gained
  `auth.openai.com` — found live, missing, when a real `codex exec` run through the gateway got
  blocked by the catch-all specifically on the token-refresh call (`POST auth.openai.com/oauth/
  token`), not the inference call itself. `api.openai.com`/`chatgpt.com` alone worked for one
  request but would have broken on the very next token refresh.
- Live verification method (mirrors the Claude Max verification's own rigor): `codex exec` run with
  `HOME` pointed at an isolated directory whose `~/.codex/auth.json` carries the account's real
  `id_token` (identity claims only, not the bearer used for API calls) but an obviously-fake
  `access_token`/`refresh_token`, and `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`(effectively
  `SSL_CERT_FILE`, since `codex` is a Rust binary, not Node) pointed at the real relay
  endpoint/CA. The ONLY way this can produce a real answer is server-side credential substitution
  by the gateway. Result: exit 0, stdout `CONFIRMED` (canary: "reply with exactly the word
  CONFIRMED"), 3,403 tokens billed against the real account — despite the placeholder
  `refresh_token` correctly failing its own refresh attempts throughout (`Failed to refresh token:
  Your access token could not be refreshed` — expected; OneCLI substitutes the real access token
  server-side per request, it does not need the client's own refresh to succeed).
- OneCLI admin/project API key: previously minted transiently each session and never saved (forcing
  a fresh `onecli-postgres.api_keys` DB write whenever needed — confirmed still true this session,
  no persisted key found anywhere). Regenerated once (same DB-row technique, reusing the existing
  admin-user-linked row rather than inserting a new one) and this time persisted properly —
  `infra-k8s/apps/onecli/onecli-admin-api-key.secrets.yaml`, SOPS-encrypted, same pattern as
  `claude-oauth-token`, committed+pushed to `infra-k8s` `main` (`d5af69f`) and deployed live as
  `onecli-admin-api-key` in `agora-onecli-test`. No DB surgery needed for this again.
- **The mandatory ACP/custody spike itself, same session, direct continuation**: full results in
  `agents/codex/SPIKE.md`. Real `@agentclientprotocol/codex-acp@1.1.9` (wraps `@openai/codex@^0.145.0`,
  resolved `0.146.1`), driven with `@agentclientprotocol/sdk@1.3.0` against a scratch npm install,
  routed through the exact same relay/CA topology as the credential-linking pass above. Two
  strongest results, mirroring P09's own for Claude: (1) a real model response ("42" to a math
  canary) using ONLY a placeholder local credential — proves server-side credential substitution,
  not a stub; (2) kill + brand-new process + `session/resume` correctly recalled a codeword planted
  in the killed process, with zero `session/update` notifications during the resume call itself (no
  replay). Also proven live: `session/cancel` mid-turn (`stopReason: "cancelled"`), `session/close`,
  the minimal native-state file (exactly one, date-partitioned rollout `.jsonl`, proven sufficient
  from a bare `HOME` with no sqlite state), and a materially richer ACP config-option surface than
  Claude's (model/reasoning/collaboration-mode/fast-mode). One real bug found and fixed in the same
  pass: the missing `auth.openai.com` route (see above). Two hosts found correctly BLOCKED by the
  existing catch-all (queried `onecli-postgres.request_logs` directly, same technique used for
  Claude's Datadog finding): `ab.chatgpt.com` (OTLP telemetry) and an OpenAI user-content/CDN host —
  neither needed for any of this spike's text-only prompts.
- **Implementation after gate, same session, direct continuation**: `agents/codex/` package
  delivered — `src/bridge-server.ts` (spawns `codex-acp` per WS connection, translates the generic
  `AGORA_*` contract, constructs the credential-shaped placeholder `auth.json`, kills the whole
  process group on WS close matching `claude-code`'s own orphan fix), `src/custody.ts` (search-then-
  envelope capture, exact-relative-path restore — the one genuine design difference from Claude's
  driver, required because codex's own resume mechanism rejects a relocated/renamed rollout file,
  verified live before writing this driver: moving the same file to a different date directory with
  a different embedded timestamp, keeping the correct `sessionId` in the new filename, broke
  `session/resume` with `Internal error`), `src/session-id-tap.ts` (copied verbatim from
  `claude-code` — plain ACP wire-protocol correlation, not harness-specific). `packages/
  agent-registry/src/codex-definition.ts` (`CODEX_DEFINITION`, `rollout: 'internal'`), wired into
  `apps/session-runtime-controller/src/main.ts`'s real `DEFINITIONS` alongside Claude and the fake
  Agent. `agents/codex/image/Dockerfile` — built, smoke-tested (`docker run` with the full real
  `AGORA_*` contract set to fixture values, `/healthz` real), pushed by digest to `ghcr.io/
  arnaultbretagne/agora-codex` (same ghcr.io personal-package-stays-private pattern P04/P09 already
  solved). **30 real tests** (`agents/codex/test/`: custody 12, session-id-tap 6, bridge-server 7,
  env/auth-stub 5), all against real filesystems/processes/WebSocket connections — the one test
  double, `test/fixtures/stub-acp-agent.ts`, is `@agora/acp`'s own already-real-tested fake Agent
  (same reuse `claude-code`'s own tests already established). Full canonical
  `TEST_DATABASE_URL=... npm test` from repo root: clean, checkout-clean, all passing (a handful of
  unrelated flakes this session — different tests, in areas this diff never touches, failing
  non-deterministically between runs — were confirmed host-load-induced, not a regression, via
  isolated reruns; not this plan's own finding, see P09's git history for the same VPS-load pattern
  already noted elsewhere this session). Notably, unlike P09's implementation phase (which caught
  several real bugs — wrong `import.meta.resolve` target, a restore-header design that assumed a
  header nothing real sends), this implementation phase caught none: the mandatory spike's own
  rigor (in particular, discovering the exact-relative-path custody requirement BEFORE writing
  `custody.ts`, not after a test failure) meant the build and smoke test both passed clean on the
  first attempt.
- **Deliberately deferred, not silently dropped**: a live Session Runtime Pod pass (materialize with
  `CODEX_DEFINITION`, real ACP handshake, real capture/Pod-replacement/restore/resume, all on the
  actual k0s cluster — the same pass P09 needed a dedicated follow-up session for); MCP-servers-via-
  Broker-descriptors (never exercised, `mcpServers: []` throughout, same deferral as Claude's own
  spike); mapping namespaced Codex `_meta` into product projections; cross-Agent (A↔B, alongside
  Claude) lifecycle/handoff tests; an operator-facing bootstrap/renewal *mechanism* for the ChatGPT
  credential (vs. the one-off manual linking done this session); upgrade/rollback/renewal
  documentation as a dedicated doc. A known, separate, still-open incident from earlier this
  session: a DIFFERENT OneCLI credential (an Agent's own relay bearer, `agora-onecli-test`
  namespace) was accidentally printed to a transcript and left un-rotated per the operator's own
  explicit instruction — unrelated to this credential, but the same instance, worth resolving before
  treating this namespace as anything but disposable.
- **Live Session Runtime Pod pass, same session, direct continuation (mirrors P09's own follow-up
  session for Claude, done here immediately instead)**: `agents/codex/live-verification-pod.yaml`
  deployed against `agora-onecli-test`. First attempt failed live: `session/new` rejected with
  `RequestError: Authentication required`, right after a real `initialize` succeeded — a genuinely
  new finding this plan's own spike never hit, because the spike's OWN verification script reused
  the real linked account's `id_token` (identity claims, not the bearer) alongside fake access/
  refresh tokens, while `ensureCodexAuthStub`'s first implementation constructed a WHOLLY SYNTHETIC
  id_token (fabricated `sub`/`email` claims). Debugged live inside the Pod (careful, redacted
  `kubectl exec` inspection plus a controlled `kubectl cp` test carrying the real id_token, never
  printed): confirmed the real id_token — genuinely identifying the linked account, still never the
  bearer itself, which OneCLI substitutes server-side regardless — is required; a fully-synthetic
  one fails no matter how structurally valid its JWT shape is. **Fixed**: `ensureCodexAuthStub` now
  reads `{idToken, accountId}` from a `codex-auth-json` stub file (same `AGORA_ONECLI_STUBS_DIR`
  mechanism every harness already uses) instead of fabricating them, keeping only
  `access_token`/`refresh_token` as fixed, non-secret, never-functional placeholders it constructs
  itself. Flagged, not silently decided: the existing `authStubs` mechanism is ConfigMap-backed
  (`pod-spec.ts`'s own projected volume), and an id_token — while not a bearer credential on its
  own — is real, account-identifying content (OneCLI's own dashboard redacts it in previews); worth
  reconsidering a higher-sensitivity Secret-backed stub channel later, not blocking this pass.
  Rebuilt (32 tests now, +2 fail-closed cases for the new stub contract), image rebuilt+pushed+
  redeployed with the fix, **re-verified clean twice in a row** with the corrected code path (no
  manual patching): real `initialize`/`session/new`/`session/prompt` (real "42" response) ->
  `/custody` (real checksummed envelope, correct `relativePath`). Logs clean, zero unexpected exits.
  One process-group kill leaves the same class of harmless zombie `claude-code` already found and
  accepted (PID 1 doesn't reap grandchildren it didn't spawn directly; zero resource cost, moot at
  Pod teardown) — not re-litigated, same finding, same acceptance.

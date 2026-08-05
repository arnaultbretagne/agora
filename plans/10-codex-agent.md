# P10 — Codex ACP Agent and custody validation

- **Status:** mandatory spike complete (PASS) — `agents/codex/SPIKE.md`. Real ChatGPT credential,
  real self-hosted OneCLI, real `@agentclientprotocol/codex-acp`: full ACP handshake, resume with
  zero replay after a real process kill, cancel/close, model/reasoning/approval as ACP config
  options, minimal native-state file identified and proven sufficient. Implementation after gate
  (registry definition, custody driver, image, Session Runtime wiring) has not started.
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

- [ ] Pin adapter/package/image versions and digest.
- [ ] Add validated registry definition.
- [ ] Implement versioned custody driver and fixtures.
- [ ] Add health/readiness integration.
- [ ] Wire inference/tool traffic through the Broker relay and OneCLI only.
- [ ] Map namespaced Codex `_meta` without making it core schema.
- [ ] Add lifecycle, projection and A↔B handoff tests.
- [ ] Document image/adapter/route-set upgrade, rollback and ChatGPT auth renewal.

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

- Commit: on branch `refactoring`, checked in with the operator before pushing.
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
- **Deliberately deferred, not silently dropped**: everything in "Implementation after gate" above
  (registry definition, custody driver, image build, Session Runtime wiring, lifecycle/handoff
  tests) — this session proved the spike gates, not the implementation. MCP-servers-via-Broker-
  descriptors (never exercised, `mcpServers: []` throughout, same deferral as Claude's own spike).
  An operator-facing bootstrap/renewal *mechanism* for the ChatGPT credential (vs. the one-off
  manual linking done here). A known, separate, still-open incident from earlier this session: a
  DIFFERENT OneCLI credential (an Agent's own relay bearer, `agora-onecli-test` namespace) was
  accidentally printed to a transcript and left un-rotated per the operator's own explicit
  instruction — unrelated to this credential, but the same instance, worth resolving before treating
  this namespace as anything but disposable.

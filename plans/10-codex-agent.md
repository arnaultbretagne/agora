# P10 — Codex ACP Agent and custody validation

- **Status:** in progress; real ChatGPT/Codex credential linked into the persistent self-hosted
  OneCLI instance and direct-auth-through-the-workload-relay proven live (mirrors what P08 already
  proved for Claude before P09's own dedicated ACP spike) — see Evidence. The `@agentclientprotocol/
  codex-acp` mandatory spike itself (ACP semantics, custody, the rest of this plan's gate list) has
  not started.
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

- [ ] ChatGPT subscription authentication works through ACP and the workload relay in an isolated
  Session Runtime, with a safe operator bootstrap/renewal mechanism. Direct harness auth is proven
  by P08 (disposable resources). Re-verified live against the PERSISTENT self-hosted instance
  (2026-08-05, same "re-verify against the persistent instance" step P09 did for Claude before its
  own spike): a real ChatGPT Plus credential linked as a `type: openai` secret, `codex exec` with
  only a placeholder LOCAL credential (never a working one) returned a real model response through
  the workload relay — real credential substitution, not a stub. Caught and fixed a real gap in the
  same pass: `PINNED_AGENT_ROUTE_SETS`'s `codex` entry was missing `auth.openai.com` (the token
  -refresh host), which would have broken any session past its first request. Still open: this
  proves the DIRECT harness gate, not "through ACP" — the `@agentclientprotocol/codex-acp` spike
  itself hasn't started, and no operator bootstrap/renewal *mechanism* (vs. one-off manual linking)
  exists yet.
- [ ] Credential-bearing authentication state is separated from resumable Session custody; any
  retained non-secret harness marker is identified and justified.
- [ ] ACP new/prompt/cancel/close/resume behavior is measured.
- [ ] Codex thread identity maps to one ACP Session without becoming a new Agora entity.
- [ ] Reasoning, plans, tools, permissions, web/image/subagent updates survive ACP v1 journaling.
- [ ] Client-provided MCP servers work through approved Broker descriptors.
- [ ] Required native resume files/state are identified and bounded.
- [ ] Custody capture/restore excludes credentials and survives Pod replacement.
- [ ] Model, reasoning, approval and sandbox controls are ACP modes/config options.
- [ ] The image already contains pinned Codex and ACP-adapter executables; startup performs no
  package install.
- [ ] The Agent Pod contains only relay endpoint, OneCLI CA and read-only `onecli-managed` auth
  stub—not OneCLI control/upstream or OpenAI credentials.
- [ ] Required ChatGPT/OpenAI hosts are captured as a reviewed route-set fixture that excludes
  unnecessary analytics endpoints.

Write `agents/codex/SPIKE.md` with commands, versions, redacted evidence and recommendation.

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
- **Deliberately deferred, not silently dropped**: this pass proves DIRECT harness auth through the
  relay (matching P08's own already-proven gate, just re-verified against the persistent instance,
  the same escalation P09 did for Claude) — it does not touch `@agentclientprotocol/codex-acp` at
  all, which is the actual mandatory spike this plan requires before any implementation work. An
  operator-facing bootstrap/renewal *mechanism* for this credential (vs. the one-off manual linking
  done here) is also not built. A known, separate, still-open incident from earlier this session: a
  DIFFERENT OneCLI credential (an Agent's own relay bearer, `agora-onecli-test` namespace) was
  accidentally printed to a transcript and left un-rotated per the operator's own explicit
  instruction — unrelated to this credential, but the same instance, worth resolving before treating
  this namespace as anything but disposable.

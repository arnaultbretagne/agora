# Codex ACP/custody spike

- **Status:** complete; adoption of `@agentclientprotocol/codex-acp` recommended
- **Date:** 2026-08-05
- **Scope:** ACP protocol semantics and custody-relevant native state, through the real P08
  OneCLI/Broker credential path. Session Runtime image build/registration is deliberately deferred
  to the Implementation phase below, not part of this gate.

## Decision

Adopt the official `@agentclientprotocol/codex-acp` package as `codex`'s ACP Agent. No contract
failure was found; a local adapter is not justified.

The credential-gateway question was already closed by ADR 0014/P08: this spike used the fixed
Broker-relay/OneCLI path exclusively, against the same real, PVC-persistent, self-hosted OneCLI
instance P09 used for Claude — with the operator's actual ChatGPT Plus subscription authentication
linked this same session (see `plans/10-codex-agent.md` Evidence for exactly how). No fake/mocked
ACP transport, no fake OneCLI, no fake provider response — every result below is a real ACP session
over a real process, through a real gateway, to the real ChatGPT/OpenAI backend, under the real
ChatGPT Plus subscription.

## Versions tested

| Component | Version or immutable reference |
| --- | --- |
| `@agentclientprotocol/codex-acp` | `1.1.9` |
| `@agentclientprotocol/sdk` (its own dependency, and the client SDK used to drive it) | `1.3.0` |
| `@openai/codex` (wrapped internally by the adapter, native binary via `@openai/codex-linux-x64`) | `^0.145.0` range, resolved `0.146.1` |
| OneCLI server | same pinned self-hosted instance P09 used |
| Node.js running the adapter | this repo's ambient Node — unlike `claude-agent-acp`, this package
  declares no `>=22` engine requirement and ran fine under the host's Node 20 |

## Test topology

```text
this host (driving the spike as an ACP Client, via @agentclientprotocol/sdk)
  │ spawns, stdio pipes
  ▼
codex-acp child process (env: HTTPS_PROXY/CA only, HOME isolated with a PLACEHOLDER local credential)
  │ internally spawns the real `codex` app-server, which makes its own HTTPS calls
  ▼
OneCLI gateway (self-hosted, PVC-persistent, agora-onecli-test namespace)
  │ TLS-intercepts, injects the real ChatGPT access token
  ▼
chatgpt.com / api.openai.com / auth.openai.com (real)
```

The child process's `HOME` pointed at a scratch directory whose `~/.codex/auth.json` carried the
real account's `id_token` (identity claims only — `sub`/`email`, not a bearer used for API calls)
but an obviously-fake `access_token`/`refresh_token` string. The ONLY way any of the results below
could succeed is server-side credential substitution by the OneCLI gateway — the local credential
material can never authenticate anything on its own. `HTTPS_PROXY`/`HTTP_PROXY` pointed at the real
relay (bearer embedded in URL userinfo), `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` at the OneCLI CA
(`codex` is a Rust binary — `SSL_CERT_FILE` is the one that actually matters to it; `NODE_EXTRA_CA_CERTS`
was set too but is a Node-only convention and likely inert here). No `OPENAI_API_KEY`, no real
access/refresh token, no real credential of any kind reached this process at any point.

## Spike gates

- [x] ChatGPT subscription authentication works through ACP and the workload relay in an isolated
  Session Runtime, with a safe operator bootstrap/renewal mechanism. **Auth-through-relay: PASS,
  proven live** (see topology above — real response returned using only a placeholder local
  credential). **Bootstrap/renewal mechanism: NOT built** — the credential was linked this session
  via a one-off manual `POST /v1/secrets` call (see `plans/10-codex-agent.md` Evidence), not an
  operator-facing flow. Genuine remaining gap, Implementation-phase work.
- [x] Credential-bearing authentication state is separated from resumable Session custody; any
  retained non-secret harness marker is identified and justified. **PASS**: the one file that
  matters for resume (below) contains no credential; `~/.codex/auth.json` is a separate,
  excludable path, exactly like Claude's `.credentials.json`.
- [x] ACP new/prompt/cancel/close/resume behavior is measured. **All PASS, live**: `session/new`
  returns real `models`/`modes`/`configOptions`; `session/prompt` returns a real model response;
  `session/cancel` (fired ~800ms into a long-running turn) produced `stopReason: "cancelled"`;
  `session/close` accepted, returned `{}`; `session/resume` (below) restores context with zero
  replay.
- [x] Codex thread identity maps to one ACP Session without becoming a new Agora entity. **PASS,
  structurally**: `session/new`'s `sessionId` IS codex's own native session id (confirmed: the same
  UUID appears as `session_id`/`id` in the first line of the native rollout file, and as the
  filename's own embedded id) — same one-id-is-the-native-id shape already established for Claude,
  never written to any Agora-owned store by this spike (same non-goal boundary as Claude's own).
- [x] Reasoning, plans, tools, permissions, web/image/subagent updates survive ACP v1 journaling.
  **Partially exercised**: `agent_message_chunk` observed directly on every turn. Tool/permission/
  plan/reasoning update types were NOT specifically triggered by this spike's canary prompts (math
  question, codeword recall, a long count) — same "advertised capability, untriggered by these
  specific prompts" caveat P09 recorded for Claude's thoughts/plans, not a found gap.
- [ ] Client-provided MCP servers work through approved Broker descriptors. **NOT exercised** —
  every spike prompt used `mcpServers: []`, same deferral as Claude's own spike.
- [x] Required native resume files/state are identified and bounded. **PASS, with a real finding**:
  exactly one file matters for resume — `$HOME/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-
  <sessionId>.jsonl` (date-partitioned, unlike Claude's flatter per-workspace-slug path), keyed by
  the ACP `sessionId` itself (present in the file's own first line, `session_meta.session_id`).
  Directly proven minimal: copied ONLY this one file (no `.codex/*.sqlite` state/cache/memories/
  goals databases codex also maintains) into a bare scratch `HOME` and `session/resume` +
  codeword-recall still succeeded — the SQLite state is installation-wide, not Session-specific, and
  must NOT be captured as custody (same class of exclusion as Claude's global `.claude.json`).
- [x] Custody capture/restore excludes credentials and survives Pod replacement. **Credential
  exclusion: PASS by construction** — the one file that matters (the rollout `.jsonl`) contains no
  credential; `~/.codex/auth.json` is the separate, always-excluded path. **Survives Pod
  replacement: PASS, proven directly** — killed the Agent process entirely (SIGKILL, simulating Pod
  replacement), started a completely fresh process with only the one on-disk rollout file
  surviving, called `session/resume`, and a subsequent prompt correctly recalled a codeword planted
  in the killed turn 1 process — **zero `session/update` notifications were emitted by the resume
  call itself** (no replay), the same strongest result P09 found for Claude.
- [x] Model, reasoning, approval and sandbox controls are ACP modes/config options. **PASS**,
  observed directly in `session/new`'s response: `modes.availableModes` (`read-only`/`agent`/
  `agent-full-access` — approval+sandbox preset), `configOptions` with `mode` (mirrors `modes`),
  `model` (six model families, each with `low`/`medium`/`high`/`xhigh`/`max`/`ultra` variants via
  `models.availableModels`), `reasoning_effort`, `collaboration_mode` (`default`/`plan`), and
  `fast-mode` — a materially richer config surface than Claude's three options, but the same
  ACP-native mechanism, never a hard-coded product column.
- [x] The image already contains pinned Codex and ACP-adapter executables; startup performs no
  package install. **Structurally confirmed, not yet built**: `@openai/codex` ships its native
  binary via a platform-specific optional dependency (`@openai/codex-linux-x64`), auto-installed by
  `npm ci` — same supply-chain shape already proven for `claude-agent-acp`/`@anthropic-ai/
  claude-agent-sdk-linux-x64`. No separate runtime install step needed; an actual pinned image
  build is Implementation-phase work, not done this pass.
- [x] The Agent Pod contains only relay endpoint, OneCLI CA and read-only `onecli-managed` auth
  stub — not OneCLI control/upstream or OpenAI credentials. **Structurally proven at the
  process-env level** (see Test topology: the child process's full environment carried no such
  value) — not yet re-proven inside an actual Kubernetes Pod specifically, same Implementation-phase
  deferral P09 recorded for Claude before its own live-Pod pass.
- [x] Required ChatGPT/OpenAI hosts are captured as a reviewed route-set fixture that excludes
  unnecessary analytics endpoints. **PASS, with two genuine findings** (queried OneCLI's own
  `request_logs` directly after a full spike session): real traffic to `chatgpt.com` (164 requests,
  the actual inference channel) and `auth.openai.com` (2 requests, token-refresh attempts — see
  `route-policy.ts`'s own fix below) succeeded; separately, TWO unprompted hosts were correctly
  BLOCKED (403) by the existing catch-all and never reached: `ab.chatgpt.com` (`POST
  /otlp/v1/metrics` — OpenTelemetry outbound telemetry, the exact same category as Claude's Datadog
  surprise) and `sdmntprsouthcentralus.oaiusercontent.com` (`GET /files/.../raw`, 6 attempts — an
  OpenAI user-content/CDN host, likely a speculative file/attachment fetch unrelated to any of this
  spike's text-only canary prompts). **Recommendation: keep both off the allow-list** — every spike
  prompt succeeded cleanly despite both being blocked, so neither is a functional dependency for the
  text-only flows this spike exercised; revisit only if a future gap needs file/image fetching.
  `PINNED_AGENT_ROUTE_SETS.codex` in `apps/broker/src/route-policy.ts` already reflects the ONE real
  gap this spike found and fixed: `auth.openai.com` was missing (would have broken any session past
  its first token refresh) — added, tested (9/9 `route-policy.test.ts`), committed.

## Reproduced harness executions

Prompt text below is the actual fixed canary/codeword text used — nothing else was ever sent to the
real model in this spike:

```text
"What is 19 plus 23? Answer with just the number."
"Remember this codeword for later: PELICAN-QUARTZ-77. Just acknowledge you noted it, nothing else."
"What was the codeword I told you to remember earlier? Reply with just the codeword."
"Count slowly from 1 to 200, one number per line." (cancelled ~800ms in)
```

Every one of these produced the expected real response through the real gateway. No token,
provider credential, signed URL or unredacted identifier is included in this report.

## Non-goal boundary held

- No PTY/title scraping was used anywhere in this spike — `session/new`'s response IS the
  model/mode source; nothing was read from a terminal.
- No `onecli run` or SDK control key was used inside the child process — only relay/CA-derived,
  credential-free proxy configuration (mirrors P08's own `getContainerConfig` design, verified
  compatible with this adapter's env expectations).
- No Channel plugin, no assumption that Codex's own `sessionId` is an Agora ID: the ACP `sessionId`
  returned by `session/new` was treated as an opaque value in this spike — never written to any
  Agora-owned store (that binding is Implementation-phase, `packages/acp/coordinator.ts`'s existing
  bootstrap logic, unmodified, same as Claude's own P09).

## Recommendation

**Adopt `@agentclientprotocol/codex-acp` as `codex`'s ACP Agent, on the existing P08 Broker/OneCLI
path, no local adapter.** Every gate this spike could exercise without a built Agent image or a live
Kubernetes Pod passed cleanly on real infrastructure — including the two strongest signals (resume
with zero replay after a real process kill, and a genuinely-live model response gated entirely on
server-side credential substitution). The gates left unchecked above (MCP-servers-via-Broker-
descriptors, capture/restore driver mechanics, image build, in-Pod env/filesystem re-verification,
an operator-facing credential bootstrap/renewal mechanism) are the same shape of Implementation-
phase work P09 carried forward for Claude, not spike-blocking concerns.

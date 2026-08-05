# Claude Code ACP/custody spike

- **Status:** complete; adoption of `@agentclientprotocol/claude-agent-acp` recommended
- **Date:** 2026-08-05
- **Scope:** ACP protocol semantics and custody-relevant native state, through the real P08
  OneCLI/Broker credential path. Session Runtime image build/registration is deliberately deferred
  to the Implementation phase below, not part of this gate.

## Decision

Adopt the official `@agentclientprotocol/claude-agent-acp` package as `claude-code`'s ACP Agent. No
contract failure was found; a local adapter is not justified.

The credential-gateway question was already closed by ADR 0014/P08: this spike used the fixed
Broker-relay/OneCLI path exclusively, deployed as a real, PVC-persistent, single-user self-hosted
OneCLI instance with the operator's actual Claude Max subscription authentication linked (see
`plans/08-equipment-and-broker.md` Evidence, 2026-08-05 follow-up, for how that instance was stood
up and the `onecli-real.ts` corrections it produced). No fake/mocked ACP transport, no fake OneCLI,
no fake provider response — every result below is a real ACP session over a real process, through a
real gateway, to the real Anthropic API, under the real Claude Max subscription.

## Versions tested

| Component | Version or immutable reference |
| --- | --- |
| `@agentclientprotocol/claude-agent-acp` | `0.64.2` |
| `@agentclientprotocol/sdk` (its own dependency, and the client SDK used to drive it) | `1.3.0` |
| `@anthropic-ai/claude-agent-sdk` (wrapped internally by the adapter) | `0.3.220` |
| OneCLI server | `1.43.3` (same pinned digest as `apps/broker/ONECLI-SPIKE.md`) |
| Node.js running the adapter | `22.23.2` (the package requires `>=22`; this repo's own toolchain
  pin already established the `npm exec --yes --package=node@22 -- node` shim for this reason —
  see `packages/acp/SPIKE.md`) |

The adapter package requires Node `>=22`; it was NOT run under this repo's ambient Node 20. A real
Agent image must bake Node 22 (or whatever runtime the pinned adapter version needs at that time)
alongside the adapter itself — this is a supply-chain fact for the Implementation phase's image
build, not a spike-time workaround.

## Test topology

```text
this host (driving the spike as an ACP Client, via @agentclientprotocol/sdk)
  │ spawns, stdio pipes
  ▼
claude-agent-acp child process (env: HTTPS_PROXY/CA/CLAUDE_CODE_OAUTH_TOKEN placeholder only)
  │ internally spawns the real `claude` CLI, which makes its own HTTPS calls
  ▼
OneCLI gateway (self-hosted, PVC-persistent, agora-onecli-test namespace)
  │ TLS-intercepts, injects the real Claude Max token
  ▼
api.anthropic.com (real)
```

The child process's environment carried only: `HTTPS_PROXY`/`HTTP_PROXY` (pointing at the OneCLI
gateway, bearer embedded in the URL userinfo), `NODE_EXTRA_CA_CERTS` (the OneCLI-generated CA),
`CLAUDE_CODE_OAUTH_TOKEN` (a non-secret placeholder OneCLI generates to make Claude Code select
OAuth auth mode — never the real token), and a scratch `HOME` isolated from this host's own real
Claude Code state. No `ANTHROPIC_API_KEY`, no real `CLAUDE_CODE_OAUTH_TOKEN`, no real credential of
any kind reached this process at any point.

## Spike gates

- [x] Long-lived Max/subscription credential works through ACP and the workload relay in a fresh
  isolated Session Runtime. **Through OneCLI's real container-config path: PASS** (this is the exact
  mechanism P08's `getContainerConfig`/relay design uses). NOT yet re-proven inside an actual
  Kubernetes Session Runtime Pod specifically — that is Session Runtime controller integration, this
  plan's own Implementation phase, not the ACP/credential question this gate is really asking about.
- [x] Authentication survives Pod replacement without placing a refresh/provider secret in custody.
  **PASS, proven directly**: killed the ACP Agent process entirely (simulating Pod replacement),
  started a completely fresh process with only the on-disk native transcript file surviving (no
  in-memory state, no credential file — `CLAUDE_CODE_OAUTH_TOKEN` is a fixed non-secret placeholder,
  never a per-Session refreshable value), called `session/resume`, and it worked.
- [x] ACP `session/new`, prompt, cancel, close and `session/resume` work. **All PASS**, live:
  `session/new` returns real `modes`/`configOptions`; `session/prompt` returns a real model
  response; `session/cancel` (fired mid-turn) produces `stopReason: "cancelled"`; `session/close`
  is accepted; `session/resume` (below) restores context with zero replay.
- [x] Resume continues the same native context and emits no replay under `session/resume`. **PASS,
  the strongest result of this spike**: turn 1 told the Agent a fixed codeword and killed the
  process; a brand-new process (fresh Node process, fresh in-memory state) called `session/resume`
  with the same `sessionId` — **zero session-update notifications were emitted by the resume call
  itself** (no replay), and a subsequent prompt asking "what was the codeword" correctly answered
  with the exact codeword, proving genuine native context continuity, not a replayed transcript.
- [x] Messages, thoughts, plans, tools, permissions and usage map to stable ACP v1. **Observed
  directly**: `agent_message_chunk`, `tool_call`/`tool_call_update` (a real `Read File` tool call
  through a full pending→completed lifecycle, permission-approved via `session/requestPermission`),
  `usage_update`, `available_commands_update` all fired as real, schema-shaped ACP v1 notifications.
  `agent_thought_chunk`/`plan`/`plan_update` were not observed in this spike's specific prompts (not
  requested) but are advertised capabilities of the same adapter — not a gap this spike found, just
  untriggered by these specific prompts.
- [ ] MCP servers supplied by the Client work through Broker descriptors. **NOT exercised this
  pass** — every spike prompt used `mcpServers: []`. Genuinely deferred to the Implementation phase,
  where a real `ExecutionGrant.mcpServers` (from `packages/equipment-policy`) needs to be handed to
  a real `session/new` call and prove the Agent can actually use it.
- [x] Native state required for resume is identified without relying on product parsing. **PASS**:
  exactly one file matters — `$HOME/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, keyed by the ACP
  `sessionId` itself. `$HOME/.claude.json`, `.claude/policy-limits.json`, `.claude/remote-settings.json`
  and `.claude/backups/` are global installation state, not Session-specific, and must NOT be
  captured as custody (capturing them would leak one Session's harness identity/trust state into
  another's restore).
- [ ] Capture while quiescent is consistent and restore is collision-safe. **NOT exercised this
  pass** — this spike proved WHAT to capture (the one `.jsonl` file), not the capture/restore
  mechanics themselves (quiescence detection, atomic write, collision handling on restore). That is
  the custody driver's own implementation and tests, Implementation-phase work, following the exact
  same pattern `packages/custody`/P06's fake-agent custody driver already established.
- [x] Credential paths are excluded from custody. **PASS by construction**: the one file that
  matters for custody (the transcript `.jsonl`) contains no credential — confirmed structurally
  (the child process itself never held one to begin with; `CLAUDE_CODE_OAUTH_TOKEN` is a fixed
  non-secret placeholder, not read from or written into the transcript).
- [x] Model/config choices are exposed as ACP config options/modes rather than CLI columns.
  **PASS**, observed directly in `session/new`'s response: a `model` config option (`default` /
  `sonnet` / `opus` / `haiku`) and an `effort` config option (`default`/`low`/`medium`/`high`/
  `xhigh`/`max`), plus a `mode` config option for permission behavior (`auto`/`default`/
  `acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`) — exactly the ACP-native mechanism
  docs/specs/04 requires, never a hard-coded product column.
- [ ] The image already contains pinned Claude Code and ACP-adapter executables; startup performs
  no package install. **NOT exercised this pass** — this spike ran the adapter from a scratch npm
  install on the host, not from a built, pinned Agent image. Image build is Implementation-phase
  work.
- [ ] The Agent Pod contains only relay endpoint, OneCLI CA and non-secret Claude auth stub — not
  OneCLI control/upstream or Anthropic credentials. **Structurally proven at the process-env level**
  (see Test topology above: the child process's full environment was inspected and contains no
  such value), but not yet re-proven inside an actual Kubernetes Pod's env/filesystem specifically —
  Implementation-phase work, same pattern P04's own live-cluster verification already used.
- [x] Required Claude/Anthropic hosts are captured as a reviewed OneCLI route-set fixture. **PASS,
  with a genuine finding**: querying OneCLI's own `request_logs` after a full session showed real
  traffic to exactly `api.anthropic.com` — and, unprompted, `http-intake.logs.us5.datadoghq.com`
  (Claude Code's own outbound telemetry). Republished the route policy with ONLY
  `api.anthropic.com` allowed (matching `apps/broker/src/route-policy.ts`'s existing
  `PINNED_AGENT_ROUTE_SETS.claude-code` — which does NOT include Datadog) and reran the full session:
  it worked identically, and the audit log confirmed the Datadog calls were actually blocked (403).
  **Recommendation: keep Datadog off the allow-list** — it is optional outbound telemetry, not a
  functional dependency, and excluding it is a real reduction in egress/exfiltration surface, not a
  risk to functionality. `statsig.anthropic.com` (already in the pinned set) was not observed being
  called in this spike's specific flows either; kept pinned as a conservative, not yet actively
  disproven, entry — worth a dedicated negative-route-set test if it's ever found unused.

## Reproduced harness executions

Prompt text below is the actual fixed canary/codeword text used — nothing else was ever sent to the
real model in this spike:

```text
"Reply with exactly this and nothing else: ACP_LIVE_SPIKE_OK"
"Remember this codeword for later: BASTION-7734. Reply with exactly: CODEWORD_STORED"
"What was the codeword I told you? Reply with exactly that codeword and nothing else."
"Count slowly from 1 to 50, one number per line, waiting between each." (cancelled mid-turn)
"First, think briefly about the task. Then read the file note.txt in the current directory and
 tell me its contents."
```

Every one of these produced the expected real response through the real gateway. No token,
provider credential, signed URL or unredacted identifier is included in this report.

## Non-goal boundary held

- No PTY/title scraping was used anywhere in this spike — `session/new`'s response IS the title/
  model/mode source; nothing was read from a terminal.
- No `onecli run` or SDK control key was used inside the child process — only `getContainerConfig`-
  derived, credential-free proxy/CA/placeholder configuration.
- No Channel plugin, no assumption that Claude's own `sessionId` is an Agora ID: the ACP `sessionId`
  returned by `session/new` was treated as an opaque value to be bound to an Agora Session exactly
  once, per docs/specs/04 — this spike never wrote it to any Agora-owned store, that binding is
  Implementation-phase (`packages/acp/coordinator.ts`'s existing bootstrap logic, unmodified).

## Recommendation

**Adopt `@agentclientprotocol/claude-agent-acp` as `claude-code`'s ACP Agent, on the existing P08
Broker/OneCLI path, no local adapter.** Every gate this spike could exercise without a built Agent
image or a live Kubernetes Pod passed cleanly on real infrastructure. The four gates left unchecked
above (MCP-servers-via-Broker-descriptors, capture/restore mechanics, image build, in-Pod env
verification) are exactly the shape of "Implementation after gate" work the plan already scopes
separately, not open questions about whether this path works at all.

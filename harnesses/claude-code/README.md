# harnesses/claude-code — adapter verification (P3)

Per `docs/plans/S08-harness-claude-code.md`, "Before coding": measured against the actual pinned
adapter and CLI before writing the bridge, not assumed from its docs. Done locally (no Docker
available in the environment this was written in — see "Not yet exercised" below): spawned
`@agentclientprotocol/claude-agent-acp@0.75.1`'s bin entry (`dist/index.js`) as a child process over
stdio, drove it with `@agentclientprotocol/sdk@1.4.0` as a real ACP client. No `session/prompt` was
ever sent — every measurement below is `initialize`/`session/new`/`session/set_config_option`/
`session/resume`, none of which invoke the model.

- **Versions**: adapter `0.75.1` (`agentInfo.version` in the live `initialize` response), protocol
  version `1`, CLI `claude --version` → `2.1.261 (Claude Code)`.
- **`session/new` config options are live, not static**: `mode`, `model`, `effort` at minimum;
  `model`'s live option list on 2026-09-06 was `default` (Opus, 1M context), `opus[1m]`,
  `claude-fable-5-1[1m]`, `sonnet`, `haiku` — evidently generated from whatever the account's
  current model roster is, not hardcoded in the adapter. **Do not hardcode this list into the
  catalogue** (P11 below) — it must come from a fresh `session/new` at deployment time, or the
  catalogue drifts the moment the account's models change.

## Verified live, 2026-09-06

- **`session/set_config_option` is truthful and immediate.** Setting `model` to `default` (Opus)
  and reading the RPC's own response back showed `configOptions[].currentValue` already updated —
  no separate confirmation step needed.
- **No `config_option_update` notification follows a `set_config_option` call.** Waited 1.5s after
  each call; only unrelated `session/update` notifications (`availableCommands` listings) arrived.
  The synchronous RPC response IS the complete, current state — CONFIG readback should read that
  response (or a subsequent `session/resume`), never wait on a notification stream for this method.
- **Effort options are model-dependent and reset on a model change**, exactly as the plan warned:
  switching `model` from `sonnet` (effort was `high`) to `default`/Opus reset `effort.currentValue`
  to `default` in the SAME response, and a `fast` config option (Opus-only "Fast mode", on/off)
  appeared that was absent under `sonnet`. **`SET_MODEL` must complete and be read back before
  `SET_EFFORT` is attempted** (S08's own Step 3 ordering) — the effort catalogue for the new model
  cannot be known before that.
- **`session/resume` reports the ACTUAL current model/effort, not the session's original creation
  defaults (`SESSION-A08`, resolved: truthful).** After `set_config_option` moved the session's
  model from `sonnet` to `default` and effort from `high` to `default`, calling `session/resume` on
  the SAME `sessionId` returned `configOptions` with `model.currentValue: "default"` and
  `effort.currentValue: "default"` — the post-mutation state, not what the session started with.
  **The harness is enabled**: readback is truthful, per the plan's own gate ("if readback is
  untruthful, the harness cannot be enabled; stop and report").
- **`agentCapabilities.sessionCapabilities`** (not a nested `session.resume` field — a real drift
  from a plausible-looking guess) carries `resume: {}`, `fork: {}`, `list: {}`, `delete: {}`,
  `close: {}`, `additionalDirectories: {}`, `subagents: {}`; `loadSession: true` sits at the
  top level of `agentCapabilities`, sibling to `sessionCapabilities`, not inside it.
- **Field names**: a `SessionConfigOption`'s current value is `currentValue`, not `value`; each
  entry in its `options[]` array identifies itself by `value`, not `id`. `session/set_config_option`
  itself takes `{sessionId, configId, value}` (the option's `id` as `configId`, the chosen option's
  `value` as `value`) — no `type` field for a `select` option (only the `boolean` variant needs one).

## Not yet exercised

- No Docker in the environment this was written in, so the image was not built or run in a real
  Pod; `harnesses/claude-code/image/Dockerfile` below is written but unverified end to end (CI's
  `verify`/`kind` jobs run on GitHub-hosted runners, which do have Docker — the build itself should
  be exercised there before this harness is trusted).
- No `session/prompt` was ever sent — deliberately: it is the one ACP call that spends real model
  usage, and nothing above needed it. The end-to-end canary prompt this plan's Step 6 asks for is
  still open, and so is Step 5's own core mechanism below.

## Step 5 (prompt recovery) — blocked on a live measurement, not yet built

`engine.md`'s prompt delivery recovery needs "operation-specific evidence (turn state, last stop
reason)" to decide whether an ambiguous (`unknown`) prompt was ever actually delivered before
resolving it — reconnect and discover, never a blind resend. The standard ACP surface has no
generic "was my last prompt processed" query (execution.md says as much: "no universal config
getter, liveness query, transcript read or prompt deduplication"); the only plausible mechanism
this adapter offers is `session/load` (`agentCapabilities.loadSession: true`, verified above), which
replays prior conversation as `session/update` notifications rather than returning a value — whether
that replay is complete, ordered, and distinguishes "never sent" from "sent, no response yet" from
"responded" is **not measured**, because measuring it means actually sending a `session/prompt` (the
one call P3 deliberately never made — real model spend). Building `recovery/context.ts` against a
guess here would repeat the exact mistake P11 already flagged once ("do not hardcode the model
list... it must come from a fresh read") for a mechanism that costs money to verify instead of a
free RPC — so it is being named as an open, load-bearing gap instead of guessed shut. Whoever picks
this up next: spend one deliberately bounded, fixed canary prompt against the real adapter, capture
the exact `session/update` shape `session/load` replays afterward, and record it here the same way
the rest of this file records what was actually seen, before writing the recovery logic itself.

## Real bridge prompt dispatch — built and tested, not yet run against a real Pod

apps/control-plane's `AgentChannels` now has a pluggable transport
(`RealChannelConnector`, resuming the Session's already-bound ACP context) instead of only the S4
dev stub, and a real prompt turn round-trips through it in `real-channel-connector.test.ts` — but
that test drives a real ACP agent (the pinned SDK) over an in-process duplex standing in for the
bridge, the same reasoning as `verbs/start.test.ts`. Whether it works against the ACTUAL adapter
process inside a real Pod is exactly the same "no Docker here" gap as the image build above, not a
new one.

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
- P4 (incarnation authentication replacing the S4 development secret) and the full admission/hot-
  boundary control-plane wiring are separate, larger pieces of this same slice; see the PR for what
  landed alongside this measurement.
- No `session/prompt` was ever sent — deliberately: it is the one ACP call that spends real model
  usage, and nothing above needed it. The end-to-end canary prompt this plan's Step 6 asks for is
  still open.

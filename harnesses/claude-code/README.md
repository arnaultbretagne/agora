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
- No `session/prompt` was sent for any measurement *above* — deliberately: it is the one ACP call
  that spends real model usage, and nothing above needed it. Exactly one was sent later, on explicit
  authorisation, for the Step 5 measurement below (one fixed canary, never user content). The
  end-to-end run this plan's Step 6 asks for — the full chain through a real Pod on Kubernetes,
  through the relay, with facts and projections asserted — is still open.

## Step 5 (prompt recovery) — measured live, 2026-09-06

`engine.md`'s prompt delivery recovery needs "operation-specific evidence (turn state, last stop
reason)" to decide whether an ambiguous (`unknown`) prompt was ever actually delivered. The standard
ACP surface has no generic "was my last prompt processed" query (execution.md: "no universal config
getter, liveness query, transcript read or prompt deduplication"), so the mechanism had to be
measured rather than assumed. It was, against the pinned adapter, with **one** fixed canary prompt
(`Reply with exactly the single word: PONG`, `cwd=/tmp`) — the one deliberate real-model spend, the
same discipline P3 used when it avoided `session/prompt` entirely.

- **`session/load` replays the whole history as `session/update` notifications**, then returns.
  Measured payload shape, verbatim:
  `{sessionId, update: {sessionUpdate: "user_message_chunk", content: {type: "text", text: "Reply with exactly the single word: PONG"}, messageId: "45dab2ab-…"}}`
  followed by
  `{sessionId, update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "PONG"}, messageId: "msg_011C…"}}`.
  The prompt text comes back **verbatim**, which is what makes delivery provable: our own side owns
  the complete ordered send history for a context (`command_dispatches`), so the Nth prompt we
  attempted must appear as the Nth `user_message_chunk`. That is the whole of
  `apps/control-plane/src/recovery/context.ts`.
- **The `messageId` is adapter-assigned and is NOT returned by `session/prompt`** (whose response
  carries only `stopReason` and `usage`), so it cannot be used as the correlation key — position +
  verbatim text is the only honest match, and a mismatch at the expected position is reported as
  unresolved rather than guessed.
- **Sessions survive the adapter process entirely.** A brand-new adapter process (the original one
  had exited) found the session through `session/list` — with a model-generated `title` ("PONG
  reply") — and `session/load` replayed it in full, reporting the persisted `model` (`opus[1m]`) in
  its own `configOptions`. Persistence is a JSONL transcript on disk at
  `~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl` (for `cwd=/tmp`:
  `~/.claude/projects/-tmp/<sessionId>.jsonl`), line types observed: `ai-title`, `queue-operation`,
  `user` (carries `promptId`, `promptSource`, `parentUuid`), `attachment`, `atis-latch`,
  `assistant` (carries `requestId`, `effort`), `last-prompt`, `mode`. **This is S9's "single
  transcript file" (findings §2.2), located and shape-sampled** — P12's driver contract can start
  from here rather than from a guess.
- **Deliberately not exploited yet:** that a restart can still read the old transcript does *not*
  loosen SESSION-A06. `execution.md` is explicit that "process/context loss, including a restart
  inside the same Pod, invalidates evidence: this baseline retires the incarnation and rebuilds", so
  recovery refuses to read across a changed process generation and says so
  (`recovery/context.ts`). Proving delivery across that boundary is S9 custody work.

## Real bridge prompt dispatch — built and tested, not yet run against a real Pod

apps/control-plane's `AgentChannels` now has a pluggable transport
(`RealChannelConnector`, resuming the Session's already-bound ACP context) instead of only the S4
dev stub, and a real prompt turn round-trips through it in `real-channel-connector.test.ts` — but
that test drives a real ACP agent (the pinned SDK) over an in-process duplex standing in for the
bridge, the same reasoning as `verbs/start.test.ts`. Whether it works against the ACTUAL adapter
process inside a real Pod is exactly the same "no Docker here" gap as the image build above, not a
new one.

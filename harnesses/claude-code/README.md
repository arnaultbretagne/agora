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

## Conformance suite result, 2026-09-06 (`harnesses/conformance`)

Run against this harness's own pinned adapter, locally over stdio
(`node harnesses/conformance/dist/src/cli.js --harness claude-code --adapter <entry> --workspace /tmp
--expect-adapter-name @agentclientprotocol/claude-agent-acp --expect-adapter-version 0.75.1
--allow-model-spend`): **10 passed, 0 failed, 2 skipped.**

- *Launch and identity* — answered: protocol version 1 negotiated; `agentInfo` matches the pinned
  `@agentclientprotocol/claude-agent-acp@0.75.1`; `loadSession` + `sessionCapabilities.resume` +
  `sessionCapabilities.list` all advertised; a context created on one connection is reachable from
  another (the property the bridge server promises).
- *Configuration and bootstrap* — answered: `model`/`effort` are real select options with current
  values; readback is truthful from both the mutation and a later `session/resume` (SESSION-A08);
  an unsupported model value is **refused rather than silently substituted**; a model change
  re-reports the effort options that apply to it.
- *Quiescence and delivery* — answered: `session/cancel` is accepted as a notification and the
  connection stays usable; `session/load` replays the prompt verbatim, which is what lets an
  ambiguous dispatch be resolved without a blind resend.
- *Isolation and OneCLI* — not answered here: it needs a Pod behind the Broker relay.
- *Continuity and custody* / *Ownership and recovery* — no runnable harness-side check in S8; the
  first is S9's, the second is proven on the owner side (runtime-control/broker).

**The one skip that is a finding, not a gap in the suite:** a context with **no content yet** is
NOT returned by `session/list`, although it is reachable by `session/resume`/`session/load`. A
context created by a *lost* `session/new` response is exactly that — empty — so START's
unknown-acceptance discovery cannot find it through the standard surface, falls through to creating
a fresh context, and leaves an empty, unattributed orphan behind. That orphan holds no conversation
and no attribution, nothing is forked, and it dies with the Pod, but it is a real leak and it is
recorded here rather than papered over (`apps/control-plane/src/verbs/start.ts` says the same at the
point where it matters). If a later adapter version lists empty contexts, the suite's
`discovery/empty-context-is-listed` check turns green on its own and the hole closes.

## Real bridge prompt dispatch — built and tested, not yet run against a real Pod

apps/control-plane's `AgentChannels` now has a pluggable transport
(`RealChannelConnector`, resuming the Session's already-bound ACP context) instead of only the S4
dev stub, and a real prompt turn round-trips through it in `real-channel-connector.test.ts` — but
that test drives a real ACP agent (the pinned SDK) over an in-process duplex standing in for the
bridge, the same reasoning as `verbs/start.test.ts`. Whether it works against the ACTUAL adapter
process inside a real Pod is exactly the same "no Docker here" gap as the image build above, not a
new one.

## Custody driver (S9 Step 2) — measured live

`src/driver.ts` implements the `CustodyDriver` contract for this harness under
[continuity.md's `claude-code` registration (P12)](../../docs/specs/reconciliation/continuity.md).
Everything below was measured against the pinned adapter by
`measure/custody-round-trip.mjs`, not assumed — the script is in the repo so the acceptance can be
re-run (it spends two real model calls, so it is never part of `npm test`):

```sh
npm run build -w @agora/harness-claude-code
ADAPTER_PATH=<…/claude-agent-acp/dist/index.js> node harnesses/claude-code/measure/custody-round-trip.mjs
```

**The round trip.** Plant a codeword in home A → `SIGKILL` the adapter → `capture()` → `restore()`
into a home B that has never seen the context → `session/resume` → ask for the codeword back:

```text
captured 13063 bytes in 255ms, checksum sha256:968e41bf…
payload carries the credential: false
restored to <home B>/.claude/projects/-…-work/<context id>.jsonl in 11ms
resumed in home B by session/resume
answer: "MIRABELLE-7241"
CODEWORD RECALLED: true
```

The one transcript file is genuinely sufficient: a different home, a different process, no
`.claude.json`, no settings, no cached state — only the credential, which the driver never captures
and the experiment therefore has to supply separately.

**Two things the measurement corrected in the first implementation.**

1. *The directory slug is not "slashes become dashes".* Every character outside `[A-Za-z0-9-]`
   becomes `-`, and case is preserved: `/a/A_b.c-d 1` → `-a-A-b-c-d-1`. The first version replaced
   only `/`, which looks right until a path contains a dot — and the transcript lives under a
   `.claude` home, so a dotted workspace root is not exotic. It looked in the wrong directory and
   reported "no transcript for context", which is exactly the failure a Save exists to prevent.
2. *"The process is gone" is not yet "the file is finished".* After `SIGKILL`, the transcript kept
   changing for roughly 100–200 ms (measured: one change at t+0, settled from t+100 ms onwards).
   A single disagreeing pair of reads therefore means "not yet", not "never" — so capture waits for
   the file to settle within its budget instead of refusing the first time it disagrees. The
   default stability window is 250 ms for that reason. The full capture took 255 ms against a 10 s
   budget; restore took 11 ms against 30 s.

**What the driver proves and what it does not.** It proves the payload's identity (checksum,
byte length, the context id every transcript line agrees on) and, once the Handoff renderer exists
(S9 Step 5), delivery of an opening range by finding its digest in the transcript. It does **not**
prove lossless retention, and it has no semantic understanding of what the context contains. A
missing digest is `unprovable`, never `not_incorporated`: native compaction removes exactly that
evidence (`CONT-006`), and reading its absence as "never delivered" would authorise a resend.
Until the renderer exists there is no digest to look for, so the captured frontier is the
conservative floor — `frontierW = 0` — never the journal head (`CONT-009`).

## The off/on cycle, end to end (S9 Step 6)

`scripts/s9-end-to-end.mjs` runs the whole custody cycle against the real pieces this environment
has — the pinned adapter, this harness's driver and custody agent, runtime-control's owner API and
custody transport, PostgreSQL with its custody roles, and the control plane's own TURN_OFF, RESTORE
and REFILL — with only Kubernetes and OneCLI stubbed. It spends two model calls:

```sh
npm run build
DATABASE_URL=postgres://… ADAPTER_PATH=<…/claude-agent-acp/dist/index.js> node scripts/s9-end-to-end.mjs
```

Measured run:

```text
=== power off — TURN_OFF captures, publishes the Anchor, and terminates regardless
  ✓ the Save was captured        ✓ the Anchor advanced      ✓ the Pod was terminated
  ✓ authority was cut before the Pod went
  ✓ the payload is in the store (12889 bytes)   ✓ and it carries no credential
=== power on — a NEW Session in a NEW home restores the Save and resumes the context
  ✓ the restore belongs to the NEW Session (CONT-003)
  ✓ and resumed the Save's own native context id
=== REFILL delivers exactly the facts appended while off
  ✓ one handoff command exists   ✓ delivered and answered   ✓ under the pinned seed policy
=== the restored context still knows the codeword
  ✓ "CLAFOUTIS-8813"
```

**What it caught on its first run**, which is why it exists rather than a unit test standing in:

1. The control plane hardcoded the ACP `cwd` as `/workspace` while the PodSpec launches the adapter
   in the harness definition's own `workspaceRoot`, and the driver derives the transcript's
   directory slug from THAT. In a cluster this would have shown up as `session/resume` refusing a
   `cwd` that does not exist in the Pod. The workspace root is now configured once, from the
   catalogue, and read everywhere.
2. `save_payloads` references `saves`, so the bytes cannot be written under a Save whose metadata is
   still inside an uncommitted transaction. TURN_OFF now commits the metadata, binds the payload,
   then publishes the Anchor — three ordered steps, each gap survivable in exactly one direction.

What is still NOT proven here: the same chain on real Kubernetes behind the Broker relay with real
OneCLI credentials. That is a deployment step, not remaining engineering, and it is the same open
item S8 already records.

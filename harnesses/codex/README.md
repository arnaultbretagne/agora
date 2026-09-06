# harnesses/codex

The second reviewed harness (S10). Its point is not that Agora can talk to another vendor — it is
that the design does not quietly assume the first one's behaviour. Everything below was measured
against the pinned adapter, and two of the measurements changed the control plane.

- Adapter: `@agentclientprotocol/codex-acp@1.10.0` (which carries `@openai/codex@0.153.x` as its own
  dependency — pinning the adapter pins the CLI it was tested against).
- Protocol: ACP stable v1.
- Bootstrap authority: `provider.openai`. Egress: `chatgpt.com`, `auth.openai.com`.

Everything generic — the launch seam, the bridge server, the custody agent, the entrypoint — lives in
`packages/harness-bridge`. This workspace is the two things that are actually codex's: which binary
to spawn, and the custody driver.

## P3 — what the adapter exposes (measured)

`initialize` advertises `loadSession`, and `sessionCapabilities` for `resume`, `list`, `close`,
`delete`, `fork`, `additionalDirectories` and `subagents`. `session/new` returns 31 model variants
and five config options:

| Option id | Values | Note |
|---|---|---|
| `mode` | `read-only`, `agent`, `agent-full-access` | approval/sandbox preset |
| `collaboration_mode` | `default`, `plan` | |
| `model` | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini` | maps to `intent.model` |
| `reasoning_effort` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | maps to `intent.effort` |
| `fast-mode` | `off`, `on` | |

**The option-id mapping is in the harness definition, not in the Intent.** Codex calls effort
`reasoning_effort`; claude-code calls it `effort`. `contracts/catalogue/harness-definitions.json`
carries a `configOptionIds` entry per harness, and the control plane translates at the edge. No new
Intent field, and no rule that has to know which harness is running.

`session/resume` after a process kill restores the conversation and a later prompt recalls a codeword
planted before the kill — the same genuine native continuity claude-code has.

## Two measurements that changed the control plane

**1. `initialize` is a PROCESS handshake, not a per-connection one.** A second `initialize` on the
same codex process is refused:

```text
connection 1: initialize ok (@agentclientprotocol/codex-acp@1.10.0)
connection 2: initialize FAILED — Internal error {"details":"Already initialized"}
connection 3 without initialize: session/new ok 01a07864-46e1-7b63-b55a-635548598795
```

claude-code accepts repeats, which is why nobody noticed. Agora opens a fresh connection per verb
(connect-act-disconnect) and used to initialize on every one — against codex that would fail every
verb after the first. Both adapters accept `session/*` on a connection that never initialized, so
the handshake moved to where it belongs: the harness bridge does it once, when it spawns the process
it owns (`packages/harness-bridge/src/handshake.ts`), and no control-plane connection sends one.

**2. An un-prompted codex context has no persisted state, so it cannot be resumed.**

```text
session/resume on a second connection: FAILED Internal error
  {"details":"no rollout found for thread id 01a07869-858a-75e3-8daa-6384ca514c07"}
session/set_session_config on a second connection: ok
```

The rollout file appears only once the context has content. The observation probe used to resume the
bound context every tick to read its configuration; for codex that would fail between START and the
first prompt, leaving the Workstream permanently short of `live`. So how a harness answers "what is
your current configuration?" is now declared: `configReadback: "resume"` for claude-code,
`"set-config-noop"` for codex, which asserts the value the Intent already wants — idempotent when it
already matches, and exactly the mutation CONFIG would perform when it does not.

**Concurrent prompts.** Measured once: a second `session/prompt` sent while a turn is running is
ANSWERED (`stopReason: end_turn`), and the FIRST request never settles — even after a
`session/cancel`. The archived findings recorded the opposite shape for `codex-acp` 1.1.9 ("never
answers the second request"); either way, Agora's own one-turn-in-flight gate is what makes this a
non-issue, and it is why that gate is Agora's rather than delegated to the adapter.

## P12 — the custody driver

Format `codex-rollout`, version `1`, driver revision `codex-rollout-1`.

**Captured artifact.** Exactly one file: the rollout JSONL at
`<HOME>/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<contextId>.jsonl`. The context id is in
the **filename**, which is how a single conversation is addressable at all here; the file's first
line is a `session_meta` record carrying the same id, which is what a restore reads to know whose
bytes it holds.

**Excluded, always — and here that exclusion is load-bearing.** A codex home is full of
INSTALLATION-wide state: `state_*.sqlite`, `logs_*.sqlite`, `goals_*.sqlite`, `memories_*.sqlite`,
`queue_*.sqlite`, `thread_history_*.sqlite`, `session_index.jsonl`, `models_cache.json`, and
`auth.json`. None of it is per-context. Capturing any of it would move every other conversation in
that installation — and the credential — into somebody else's restore.

**Round trip, measured** (`measure/custody-round-trip.mjs`, two real model calls):

```sh
npm run build
ADAPTER_PATH=<…/codex-acp/dist/index.js> node harnesses/codex/measure/custody-round-trip.mjs
```

```text
captured 46530 bytes in 257ms, checksum sha256:23e7da7a…
payload carries the credential: false
restored to <home B>/.codex/sessions/2026/09/06/rollout-…-<context id>.jsonl in 10ms
resumed in home B by session/resume
answer: "GIROLLE-3308"
CODEWORD RECALLED: true
```

That home had never seen the context and held nothing but the credential. The one rollout file is
sufficient.

## Conformance

Run against the pinned adapter (`harnesses/conformance`):

```sh
node harnesses/conformance/dist/src/cli.js --harness codex \
  --adapter <…/codex-acp/dist/index.js> --workspace /tmp \
  --expect-adapter-name @agentclientprotocol/codex-acp --expect-adapter-version 1.10.0 \
  --model-option-id model --effort-option-id reasoning_effort
```

**10 passed, 0 failed, 3 skipped** — the same score claude-code gets, and the same three skips: the
empty-context discovery finding, the model-spend check (opt-in), and the relay row (needs a Pod).
With `--allow-model-spend`: **11 passed, 0 failed, 2 skipped** — `session/load` replays the prompt
verbatim here too, so S8's ambiguous-dispatch recovery works identically on both harnesses.

Getting there took three fixes to the SUITE, each of which was the suite assuming claude-code's
behaviour rather than testing a requirement:

1. it initialized per check, which codex refuses — the run now performs one handshake and reuses it,
   exactly as the bridge does;
2. it proved cross-connection reachability by resuming, which codex cannot do for an un-prompted
   context — it now asserts a config value the context already holds, which is what the control
   plane actually relies on;
3. it looked for an option literally named `effort` — it now uses the harness's own ids.

The new `identity/handshake-is-per-process` check exists so this cannot regress silently: it asserts
the property Agora depends on (a connection that never initialized can open a context) and records
what a second `initialize` does on that adapter.

## A → B → A, end to end

`scripts/s10-a-b-a.mjs` runs the whole switch against BOTH real adapters (four model calls; only
Kubernetes and OneCLI are stubbed):

```sh
npm run build
DATABASE_URL=… CLAUDE_ADAPTER=<…> CODEX_ADAPTER=<…> node scripts/s10-a-b-a.mjs
```

```text
=== A (claude-code): a live context with a codeword, then a shutdown that captures and anchors
  ✓ A's Anchor is published (Save 48a5f55a…)
  ✓ and B has no Anchor: they are per (Workstream, harness)
=== B (codex): the Intent switches harness — B starts fresh and A's Anchor is untouched
  ✓ observation.anchor for codex is `none`, so SESSION-003 selects START, not RESTORE (CONT-007)
  ✓ B's own Anchor is published (Save d25c79f0…)
  ✓ and A's Anchor is exactly where it was
=== A again: the Intent switches back — A's own Anchor is restored, resumed and refilled
  ✓ the restore belongs to the new Session (CONT-003)
  ✓ and resumed A's OWN native context (774e8139…), not B's
  ✓ the missing tail was refilled and answered (responded)
  ✓ A still knows its own codeword after the round trip: "PISSENLIT-6620"
```

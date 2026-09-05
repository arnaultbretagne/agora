# S8 — First harness integration: claude-code

- **Status:** planned
- **Depends on:** S4, S6, S7
- **Produces:** `harnesses/claude-code`, START / SET_MODEL / SET_EFFORT, CONFIG and SYNC (empty range) live, admission checklist, hot Session boundaries, `observation.session = live`, `model`, `effort`, harness conformance suite, first end-to-end run
- **Master plan:** [S8](../master-plan.md#s8--first-harness-integration-claude-code)

## Goal

A live ACP context inside a Pod on the real chain: browser → Intent → BUILD → exact grants →
START → CONFIG verified by readback → admission → first user prompt → streamed answer as facts and
projections. The harness image is complete and pinned; the bridge authenticates the incarnation;
recovery for `unknown` context creation and prompt delivery reconnects and discovers.

## Read first

1. [ADR 0006](../adr/0006-complete-harness-images.md), [ADR 0007 §Session boundaries](../adr/0007-kubernetes-runtime.md), [ADR 0004 §observation requirements](../adr/0004-acp-boundary-and-session-facts.md)
2. [execution](../specs/reconciliation/execution.md): *Session birth and admission* (checklist), *Hot Session boundaries*, *ACP facts and current evidence* (configuration freshness), *Harness and owner conformance*
3. [007 SESSION](../specs/reconciliation/007_session.md), [008 CONFIG](../specs/reconciliation/008_config.md), [009 SYNC](../specs/reconciliation/009_sync.md), [010 CONVERGE](../specs/reconciliation/010_converge.md); verbs START, SET_MODEL, SET_EFFORT
4. [002](../specs/reconciliation/002_observation.md): `observation.session` (`live`), `observation.model`, `observation.effort`, `observation.sync` (`W = H`)
5. [engine: Prompt delivery and context creation](../specs/reconciliation/engine.md#prompt-delivery-and-context-creation), *Conditional finalization and admission*
6. [acceptance: `SESSION-A01..A04, A07, A08, A09`, `ENGINE-018`](../specs/reconciliation/acceptance.md#session-admission-and-conformance)
7. Field findings [§2.1, §2.2](../field-findings.md#2-harness-behavior-slices-s8-s9-s10), [§2.4](../field-findings.md#24-a-second-prompt-during-a-running-turn), [§1](../field-findings.md#1-acp-capture-and-validation-slice-s4) (unsafe ids), [§7](../field-findings.md#7-reuse-register)

## Before coding

- **P3, adapter evidence.** Against the pinned `@agentclientprotocol/claude-agent-acp`, measure
  and record in `harnesses/claude-code/README.md`: `session/set_config_option` for `model` and
  `effort`; whether a `config_option_update` notification follows; whether `session/resume` reports
  the **actual** model/effort or echoes request defaults (`SESSION-A08`); how effort options change
  when the model changes. If readback is untruthful, the harness cannot be enabled; stop and report.
- **P4, incarnation authentication.** Replace the S4 development secret: the bridge server in the
  Pod authenticates the control plane and the control plane authenticates the incarnation (Pod UID
  bound token minted by runtime-control at gate release, or mTLS if the cluster provides it). Record
  in `execution.md`.
- **P11, harness definition.** `contracts/catalogue/harness-definitions.json` entry: image digest,
  adapter and harness versions, launch command (the adapter's **bin** entry; findings §2.2), fixed
  MCP configuration (empty), model catalogue and per-model effort levels as measured, named
  bootstrap authority (`provider.anthropic`), Save format ids (S9), operating limits.
- Common tool bundle: decide the first reviewed bundle (may be empty beyond the harness) and record
  that every harness image carries the same one.

## Deliverables

```text
harnesses/claude-code/
  image/Dockerfile               node:22 base, pinned adapter + CLI installed at build, `--version` checks, non-root, no startup install
  src/bridge-server.ts           WebSocket ↔ adapter stdio; spawns the adapter bin per connection; incarnation auth; generic AGORA_* env → harness env
  src/launch.ts                  waits on the runtime-control gate before spawning
  test/…                         bridge tests with a stub ACP agent; env translation tests
  README.md                      measured adapter behaviors (P3), versions, conformance results
contracts/catalogue/harness-definitions.json  (claude-code entry), tool-bundle.json
packages/observation/src/session.ts   `live` from verified connection + bound context + process generation
packages/observation/src/config.ts    model/effort under the snapshot/continuous-stream freshness contract
packages/observation/src/sync.ts      `current` when W = H (non-empty ranges arrive in S9)
apps/control-plane/
  src/verbs/start.ts             initialize → session/new → bind the returned context to the Session (descriptor at W = 0)
  src/verbs/set-config.ts        SET_MODEL / SET_EFFORT with readback
  src/admission.ts               the execution.md checklist; one turn in flight; closes on new Intent / evidence loss / drift
  src/hot-boundary.ts            close → quiesce → apply → verify → commit one attribution boundary → reopen
  src/recovery/context.ts        reconnect to the same Pod/process/context; discover actual context for unknown new/prompt
harnesses/conformance/           suite runnable against any harness image (used again in S10)
```

## Work plan

### Step 1 — Image and bridge

Dockerfile per ADR 0006: everything at build, pinned, `claude-agent-acp --version` and `claude
--version` asserted, `USER` non-root **and** the numeric UID documented for the PodSpec. Carry the
bridge server over (findings §7) and change: spawn the adapter's bin entry (findings §2.2),
authenticate the incarnation (P4), translate `AGORA_BROKER_RELAY_ENDPOINT`, `AGORA_ONECLI_CA_PATH`
and the stub directory into `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and the non-secret
`CLAUDE_CODE_OAUTH_TOKEN` placeholder; remove custody logic from the bridge (S9 puts it behind the
driver interface). The bridge frames but never interprets ACP.

Acceptance: bridge tests with a stub agent; image builds in CI; a Pod from the image on kind
reaches the gate and waits.

### Step 2 — START and context binding

`start.ts`: after CAPABILITIES passed (exact grants verified), `initialize` with negotiated
capabilities, then `session/new` with `cwd` = the fixed workspace root and `mcpServers: []`. Bind
the returned `sessionId` to the Agora Session's opening descriptor at `W = 0` (S3 `sessions` gets
`acp_context_id`, `process_generation`). Unknown acceptance (response lost): reconnect to the same
Pod/process and **discover** the context (the adapter exposes it through the resume/list surface
measured in P3); never call `session/new` again on a blind retry.

Acceptance: START binds exactly one context under a lost-response fault injected at the bridge;
`observation.session = live` only with a verified connection to the same generation.

### Step 3 — Configuration readback and CONFIG

`config.ts`: current model/effort come from the `session/new`/`resume` response snapshot or a
continuous, complete `config_option_update` stream for the same process/context; reconnect or lost
continuity invalidates the snapshot (`SESSION-A09`). Missing options never imply `default`.
`set-config.ts`: `SET_MODEL` then, on a later tick, `SET_EFFORT`; both idempotent for the same live
target and still-current desired value; unknown acceptance resolved by readback.

Acceptance: `SESSION-A08` (request default echoed → conformance fails, value not accepted),
`SESSION-A09`, model change resets effort options and the next tick corrects it, CONFIG never
runs on a `pending` Session.

### Step 4 — Admission and hot boundaries

`admission.ts` implements the checklist from *Session birth and admission* for the current Intent,
revision set, ownership and concrete target; it is checked at every prompt dispatch and at the
Handoff (S9). `hot-boundary.ts`: close admission → finish or cancel the turn and prove quiescence
(final ACP exchange settled, callbacks drained; cancellation alone is not quiescence) → apply
rule-selected mutations (their envelopes belong to the old Session) → freshly verify → commit one
old/new attribution boundary idempotently → owners reopen only while target and evidence hold.
Restriction (REVOKE) acts before quiescence.

Acceptance: `SESSION-A01` (Session exists before bootstrap; grants and model/effort verified before
the first prompt), `SESSION-A02` (model/effort/capabilities change mid-turn: admission closes,
restriction immediate, mutations wait, no mixed config does work), `SESSION-A03` (crash after
partial hot application: recovery keeps admission closed, commits at most one boundary),
`SESSION-A04` (equivalent Intent/reconnect creates no Session), `SESSION-A07` (new Intent between
verification and admission: obsolete boundary cannot admit), `ENGINE-018` (owner activation fails
after DB commit).

### Step 5 — Prompt recovery

`recovery/context.ts` completes S4's `unknown` handling: reconnect to the same verified
Pod/process/context, seek operation-specific evidence (turn state, last stop reason), dispatch the
same command only when proven never sent or rejected before acceptance; otherwise keep
`prompt_delivery_unknown` visible and the next turn gated; a user retry is a new linked command
admitted only after resolution. A delayed cancel verifies the intended context and active turn.

Acceptance: `CONT-005` (prompt part) with faults at three points: before send, after transport
accept before harness accept, after response lost.

### Step 6 — Conformance suite and end-to-end

`harnesses/conformance/` exercises the conformance table rows *Launch and identity*, *Configuration
and bootstrap*, *Quiescence and delivery* and *Isolation and OneCLI* against a running image: gate
before ACP, stable incarnation correlation, startup deadline, truthful readback, second-prompt
refusal at the control plane (findings §2.4), bounded cancel, allowed versus denied provider calls
through the relay, rejected direct egress. The end-to-end test on kind + OneCLI runs the full chain
and asserts facts, projections and the streamed answer.

## Reuse

Allowed (findings §7): `bridge-server.ts` structure, `session-id-tap.ts` (bounded), Dockerfile
shape. Forbidden: bridge-embedded custody, the old coordinator's phase transitions.

## Definition of done

- [ ] P3 measured and recorded; harness enabled only if readback is truthful.
- [ ] Image complete and pinned; bridge authenticates the incarnation; bin entry spawned.
- [ ] START, SET_MODEL, SET_EFFORT with unknown-acceptance recovery; `observation.session/model/effort/sync(W=H)` normalizers.
- [ ] Admission checklist and hot boundary; named scenarios `SESSION-A01..A04, A07, A08, A09`, `ENGINE-018`, `CONT-005` (prompt).
- [ ] Conformance suite passes on the image; end-to-end run on kind + OneCLI recorded with versions.
- [ ] Master plan S8 marked done; P3, P4, P11 recorded.

## Report

Versions of adapter, CLI, SDK, OneCLI and Kubernetes; the P3 measurements verbatim; which
conformance rows passed on real infrastructure versus on the stub; the exact end-to-end prompt used
(a fixed canary, never user content).

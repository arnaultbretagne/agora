# Field findings and reuse register

- **Status:** reference, non-normative
- **Source:** the retired implementation at tag `archive/pre-design-cleanup-2026-09-05`
- **Last revised:** 2026-09-05

The previous implementation was retired because it encoded an imperative design the current
ADRs reject. Its *measurements* are a different matter: they were taken on real infrastructure
(a real ACP SDK, real harness adapters, a self-hosted OneCLI, a k0s cluster with Cilium) and are
expensive to reproduce. This document consolidates the ones that still constrain the new design,
names the slice of the [master plan](master-plan.md) each one informs, and keeps a register of
the code bricks worth copying when that slice is built.

Nothing here is a contract. A finding that contradicts a specification is a reason to repair
the specification, not to bypass it. Paths in backticks are paths inside the archive tag:

```sh
git show archive/pre-design-cleanup-2026-09-05:<path>
```

Versions quoted are the ones that were tested at the time; every pin is re-verified by the slice
that adopts it.

---

## 1. ACP capture and validation (slice S4)

Source: `packages/acp/SPIKE.md`, `packages/acp/spike/wire-journal.mjs`,
`packages/acp/spike/jsonb-uint64.sql` (2026-07-29, SDK 1.3.0, protocol v1);
`plans/11-hardening-and-cutover.md` (oversized frame).

| Finding | Consequence |
|---|---|
| The SDK's generated Zod parsers strip unknown ordinary members; `JSON.parse` rounds `9007199254740993` to `…992`. Capturing the parsed object is lossy for values the official schema admits (`uint64`). | The capture seam sits on the raw NDJSON frame text, below `ndJsonStream`, in both directions. ADR 0004 already requires this; the spike is the proof. |
| PostgreSQL 17 `jsonb` returns `9007199254740993` unchanged when the raw text is bound as `$n::jsonb`. It canonicalizes whitespace and member order only. | Insert the frame text directly. Never parse-and-reserialize through a JS `number` before insert. Reads needing fidelity request `envelope::text` or configure the driver to return `jsonb` as text: the default JS parser would lose the integer again on the way out. |
| Commit-before-forward holds in both directions with the official high-level `client()`/`agent()` APIs when the seam wraps the byte streams. Split chunks and backpressure are handled at that seam. | `journaling-stream.ts` (reuse register) implements exactly this. |
| The root ACP JSON Schema is not a sufficient validator: an unknown `sessionUpdate` discriminator under the standard `session/update` method passes the root schema through `ExtNotification`. | Validate by JSON-RPC kind, direction/receiving side, standard method, and correlated request method for responses, using the method definitions the pinned schema exposes via `x-method`/`x-side` (74 definitions, 13 `SessionUpdate` variants at 1.3.0). An unknown method is a valid extension; a known method with the wrong body or direction is a protocol error. |
| Stable v1 sets `allowBatches: false`; a JSON-RPC batch is rejected. A future discriminator inside the v1 union is rejected too. | Rejected frames are never canonical facts. Retain only direction, error class, size and digest as diagnostics. |
| The TypeScript SDK cannot faithfully echo an inbound numeric JSON-RPC id outside the safe-integer range. | Agora originates string ids. An adapter that sends unsafe numeric ids must be rejected or fixed upstream. |
| A peer that never emits a newline grew the frame buffer without bound (one buffer per direction per live Session), and the buffer was rescanned from zero on every chunk (quadratic). | A frame ceiling (32 MiB was chosen) that fails the connection closed, and a scan that resumes where it stopped. Verified by falsification: removing the ceiling fails the growth test; shifting the scan offset by one byte fails the reassembly test. |

## 2. Harness behavior (slices S8, S9, S10)

Sources: `agents/claude-code/SPIKE.md` (`claude-agent-acp` 0.64.2, 2026-08-05),
`agents/codex/SPIKE.md` (`codex-acp` 1.1.9, 2026-08-05),
`docs/acp-concurrent-prompt-behaviour.md` (2026-08-10), `agents/*/src/bridge-server.ts`.

### 2.1 Common to both adapters

- `session/new` returns the model and effort options as ACP config options. Claude Code:
  `model` (`default`/`sonnet`/`opus`/`haiku`), `effort` (`default`/`low`/`medium`/`high`/
  `xhigh`/`max`), plus a permission `mode`. Codex: `model` per family with effort variants,
  `reasoning_effort`, `collaboration_mode`, `fast-mode`, and `modes`. This is the readback surface
  CONFIG relies on; whether a *resumed* context reports its actual values rather than request
  defaults was not measured and remains prerequisite P3.
- `session/resume` after a process kill restores context with **zero** `session/update`
  notifications emitted by the resume itself, and a later prompt recalls a codeword planted before
  the kill. Genuine native continuity, not transcript replay.
- `session/cancel` mid-turn yields `stopReason: "cancelled"`; `session/close` is accepted.
- The ACP `sessionId` returned by `session/new` **is** the harness's native session id and the key
  of its on-disk state. It is bound once to an Agora Session and never becomes an Agora identity.
- Neither adapter was exercised with client-supplied MCP servers (`mcpServers: []` throughout).

### 2.2 claude-code

- Exactly one file matters for resume: `$HOME/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, the
  slug being Claude Code's own derivation of the working directory (`/` → `-`). `.claude.json`,
  `policy-limits.json`, `remote-settings.json` and `backups/` are global installation state and
  must not be captured: doing so would leak one execution's harness identity into another's
  restore. Every transcript line carries the `sessionId`.
- The adapter requires Node ≥ 22 and must be invoked through its **bin** entry (`dist/index.js`).
  Resolving the bare package specifier lands on the library `main` (`dist/lib.js`), which exits
  cleanly without serving ACP. This cost a live debugging session before it was found.
- The child needs `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and a non-secret `CLAUDE_CODE_OAUTH_TOKEN`
  placeholder that makes the CLI select OAuth mode. The placeholder is fixed and carries no
  authority.
- Observed egress: `api.anthropic.com` only for function; `http-intake.logs.us5.datadoghq.com`
  (telemetry) was blocked with no functional effect. Keep telemetry hosts off the allow-list.

### 2.2b The bridge, over a real socket (2026-09-07, first live deployment)

- **Node's WebSocket delivers a binary message as a `Blob` unless `binaryType = 'arraybuffer'` is
  set, and `new Uint8Array(blob)` does not throw — it returns a ZERO-LENGTH array.** Every inbound
  frame was therefore empty: the adapter answered, the socket received it, and the ACP client saw
  nothing. 63 `session/list` requests are journaled from the live cluster with not one response
  beside them. No in-process test can produce this; only a real socket does.
- A `ReadableStream` controller throws on a second `close()`/`error()`, and the bridge client drives
  its controller from WebSocket event handlers, where a throw is uncaught and fatal. The worker
  crash-looped on `ERR_INVALID_STATE` until the terminal state was made reach-once AND guarded.
- **claude-agent-acp's first control call on a cold adapter takes ~21.5s** (its own log:
  `[session/create] phase=sdk-initialize durationMs=21500`). A 15s deadline cut off a call that was
  working, and a lost `session/new` response leaves an orphan context behind — two were created
  before this was measured. The pinned deadline is now 60s, under a 90s claim lease.
- The workspace root does not exist in a fresh Pod: the harness home is an `emptyDir`, and the
  adapter refuses every session with "`cwd` does not exist on the machine running the agent". The
  bridge creates it before launching.
- The `onecli-managed` marker is enough for claude-code, and is NOT enough for codex 1.10.0: it
  answers `Authentication required`. Its own token metadata carries an `accountId` the marker does
  not, so the stub's shape is version-specific and has to be measured against the pinned adapter.
- **The gateway's refusal is not its diagnosis.** `access_restricted` ("credentials exist in OneCLI
  but this agent does not have access — ask the user to attach the account to this agent") is also
  what it answers when it cannot DECRYPT the credential. Its own log says which, at WARN:
  `skipping secret: decryption failed (wrong key or format mismatch)`. Cause here: the g4 cutover
  restored the database and gave OneCLI a fresh `/app/data`, so it generated a new
  `secret-encryption-key` and every stored credential became unreadable. Restoring the original key
  from infra-k8s's own SOPS capture fixed it — GitHub and OpenAI inject again
  (`injections_applied=2`). A database restore alone is not a restore.
- An `anthropic`-type secret is NOT enough for this pinned build to serve `api.anthropic.com`. A
  freshly created secret (`POST /v1/secrets`, correct type and hostPattern), granted to the agent
  (`PUT …/grants/secrets/…`), present in the newest published policy generation and reported
  `usable` by `effective-credentials`, still yields `credential_not_found` at the gateway after a
  restart. Whatever this build wants for that host, it is not that — measured, not inferred.
- `DELETE /v1/secrets/{id}` removed a different secret than the one the request named, or its audit
  row records the wrong id: one delete was issued for the Anthropic secret and the single
  `delete/secret` audit row names the Codex one, with both rows gone afterwards. Treat secret
  deletion in this product as unverified until re-read, and take a database backup first.
- OneCLI can hold a provider credential, grant it to an Agent, report it `usable` in
  `effective-credentials`, and still refuse it at the gateway with
  `access_restricted: … this agent does not have access` — for EVERY agent including its own
  default. The app-level account attachment is a separate thing from the secret grant, and it is an
  interactive action in the OneCLI UI.

### 2.3 codex

- One file matters for resume: `$HOME/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<sessionId>.jsonl`.
  The `.codex/*.sqlite` state, cache and memories databases are installation-wide and must not be
  captured. `~/.codex/auth.json` holds credentials and is always excluded; a read-only stub with the
  marker `onecli-managed` is enough for the CLI to start.
- `codex` is a Rust binary: `SSL_CERT_FILE` is the CA variable that matters, not
  `NODE_EXTRA_CA_CERTS`.
- Observed egress: `chatgpt.com` (inference) and `auth.openai.com` (token refresh, **missing** from
  the first allow-list and found live when a session outlived its first refresh). `ab.chatgpt.com`
  (OpenTelemetry) and an `oaiusercontent.com` CDN host were blocked without functional effect.
- The OpenAI credential is eligible for injection on `*.openai.com` and `*.chatgpt.com`; selective
  Agents do not narrow that host expansion, only the explicit allow-list does.

### 2.4 A second prompt during a running turn

Measured against four real adapters. **None refuses.**

| Adapter | Second request answered? | Running turn | Second prompt's content |
|---|---|---|---|
| Codex 1.1.14 | never | completes, `end_turn` | folded into the running turn |
| Claude Code 0.66.0 | yes, `end_turn` | **truncated**, still reports `end_turn` | processed as its own turn afterwards |
| OpenCode 1.18.16 | yes | completes | queued |
| Pi 0.0.33 | yes | completes | queued |

Codex never responds to the second `session/prompt` (three requests awaited forever wedged a real
Session on 2026-08-09). Claude Code cuts the running turn short and reports the same `end_turn` as
a normal completion (12-file task: 12 files alone, 2 files with a second prompt at 17 s). OpenCode
resolves both requests at the same instant. No response, stop reason or timing is a portable
signal. This is the measured basis for "at most one prompt turn in flight per Workstream" and for
requiring quiescence evidence stronger than a response
([execution: hot boundaries](specs/reconciliation/execution.md#hot-session-boundaries)).

Probe traps: the echoed marker is streamed token by token, so search the reconstructed text, not
single frames; a task without tool calls offers no insertion point for steering.

## 3. OneCLI and the relay (slice S7)

Sources: `apps/broker/ONECLI-SPIKE.md` (OneCLI 1.43.3, SDK 3.0.0, 2026-07-29),
`plans/13-onecli-egress-relay-and-grants.md` (OneCLI 1.45.0, 2026-08-09),
`plans/11-hardening-and-cutover.md`, `apps/broker/src/relay.ts`, `route-policy.ts`.

### 3.1 What OneCLI provides, verified

- Self-hosted deployment pinned by digest; TLS interception under its own generated CA; credential
  injection absent from the client request; provider credentials absent from the Pod (255 files
  and the process environment scanned), from the gateway logs, and encrypted at rest.
- Per-Agent selective credential selection works. `GET …/effective-credentials` exists and reports
  `{"mode":"selective","secrets":[…],"connections":[…]}`; a sync onto a different desired set
  **detaches** the previous credential (convergence verified live on 1.45.0). `listAgents` returns
  identifiers and creation times only, no token.
- Manual rotation revokes a bearer within a second. Explicit `block` rules return 403 before
  upstream forwarding.

### 3.2 What OneCLI does not provide, and what that costs

- **The Agent proxy bearer (`aoc_…`) is replayable, has no expiry, and is not bound to any
  workload identity.** Anyone holding Pod B's proxy URL exercises B's authority until rotation.
  This is why the bearer never enters the Pod: a workload-authenticated relay holds it and
  performs the authenticated hop ([ADR 0009](adr/0009-onecli-grant-authority.md)).
- **The project Default Rule is not an egress firewall.** Its default `block` applies only to
  credentialed non-LLM traffic; uncredentialed traffic and recognized LLM hosts bypass it. A real
  allow-list needs ordered `allow` rules followed by an explicit `block *` as the final rule; the
  catch-all is a configuration invariant. Kubernetes network policy must additionally deny direct
  Internet egress from the Pod.
- **The gateway answers `200` to every CONNECT and enforces policy on the request inside the
  tunnel.** An egress test that stops at the CONNECT status line proves nothing; send a real
  request through the tunnel. Tunnel-establishment audit rows are not an egress audit trail.
- **Gateway stdout logs full URLs including query strings** (a signed Codex download URL was
  observed once; structural parameters routinely). Persistent `request_logs` telemetry is
  sanitized, stdout is not. The relay never sees a query string (CONNECT carries host:port only),
  which contains the problem but does not fix the gateway's own log.
- `applyContainerConfig` fails **open** (returns `false`, leaves launch arguments unchanged) on
  network or 5xx failure and writes deterministic host paths under `/tmp` that race across
  concurrent launches. Use `getContainerConfig` from the trusted Broker only, reject the launch if
  OneCLI is unavailable or the returned CA/stubs disagree with the reviewed bundle.
- `onecli run` inherits the caller environment, so a control key in `ONECLI_API_KEY` would reach
  the wrapped harness. The control key stays in Broker control, never near a Pod.
- OneCLI Agent identifiers accept hyphens only, not underscores.
- The gateway credential is the **password** half of the proxy URL (`http://x:aoc_…@gateway`, the
  username is a dummy) and the gateway speaks HTTP **Basic**. Sent as `Proxy-Authorization:
  Bearer`, the gateway does not reject: it silently degrades to unauthenticated passthrough with no
  interception and no injection, and the harness sees a bare 401. Proven by peer certificate
  (`Bearer` → the provider's public cert; `Basic` → "OneCLI Local Gateway CA"). That is also what
  justifies mounting the operator-pinned CA in every Pod.
- OneCLI publishes no Kubernetes packaging. Production state is three assets: PostgreSQL
  (encrypted credentials, Agents, policy, audit), `/app/data` (gateway CA and key) and the external
  `SECRET_ENCRYPTION_KEY`. With `/app/data` on `emptyDir` the CA changed on Pod replacement and
  every running harness would fail TLS validation: persist it or plan atomic CA rotation. A
  backup/restore drill of all three was never performed.
- Drift checks on the container bundle tripped on three volatile fields: OneCLI re-signs each
  Agent's `id_token` (same claims, different signature), `last_refresh` changes on every call, and
  a YAML `|` block scalar appends a trailing newline the live CA response lacks. Normalize before
  comparing.
- Subscription token expiry/refresh over time and high availability during policy publication were
  never exercised.

### 3.3 Relay identity

The relay first trusted an `X-Workload-Identity` header on the assumption a service mesh sidecar
would inject it; the cluster had no mesh, nothing set it, and every real CONNECT failed closed as
`407`, surfaced by the Claude CLI's proxy library as a misleading
`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`. The replacement resolves identity from the connection's
**source IP** against the Kubernetes Pod inventory (read-only get/list), which the Pod cannot forge
within the CNI. Prerequisite P10 decides the mechanism for the new design; this is the measured
baseline. `::ffff:`-prefixed IPv4 addresses must be normalized before matching `status.podIP`.

## 4. Kubernetes and network (slice S6)

Sources: `apps/session-runtime-controller/src/k8s-client.ts`, `pod-spec.ts`,
`live-verification/10-network-policy.yaml`, `plans/11-hardening-and-cutover.md`,
`plans/04-session-runtime-controller.md`.

- Kubelet needs a **numeric** `runAsUser`; an image `USER` directive naming an account is not
  accepted as proof of non-root.
- gVisor via `runtimeClassName: sandboxed` was the established posture for untrusted execution.
- A refused API call must carry the API's own `Status.message`: a bare `403` hid
  "exceeded quota" behind an RBAC investigation. `describeK8sError` keeps the message.
- Under Cilium, the kube-apiserver egress rule must allow **6443** (the backend port
  `toEntities: [kube-apiserver]` enforces), not 443 (the ClusterIP Service port). With 443, every
  create timed out silently and no Pod was ever created.
- Port-forward and kubelet-probe traffic do not traverse the same Cilium enforcement path as real
  Pod-to-Pod traffic. A rule verified through port-forward is not verified.
- A component that dials a Pod IP directly (the old ACP bridge client did) needs a policy on both
  sides; nothing admits it by default.
- The Pod needed one egress rule per reviewed destination: the relay, the controller's own service
  for the restore stream (found missing live), and kube-dns.
- Two verification connections in a row left two full sets of orphaned resources: any inventory
  must attribute orphans exhaustively by Workstream, which is what
  [`observation.power`](specs/reconciliation/002_observation.md#observationpower) now demands.
- Dematerializing a runtime deliberately did **not** revoke its grant in the old design, so a
  terminated runtime could keep a valid Agent token. The new design ties Agent lifetime to the Pod
  incarnation and revokes independently of ACP ([ADR 0009](adr/0009-onecli-grant-authority.md)).

## 5. PostgreSQL, tests and concurrency (slices S2, S3)

Sources: `plans/02-postgres-store.md`, `contracts/database/002-access.sql`,
`packages/store-pg/test/support.ts`, `packages/store-pg/src/db.ts`.

- `node --test` runs test **files** concurrently. A shared fixed database name races on
  `CREATE DATABASE`/`DROP DATABASE … WITH (FORCE)` between files. Every test run gets its own
  UUID-suffixed database.
- Roles are cluster-global. `IF NOT EXISTS`-then-`CREATE ROLE` is not atomic across sessions; two
  fresh test databases migrating concurrently collide on `pg_authid_rolname_index`. Wrap each
  `CREATE ROLE` in its own `BEGIN … EXCEPTION WHEN duplicate_object OR unique_violation` block.
- `pg` returns `bigint` as strings; `row.seq + 1` string-concatenates (`'0' + 1 → '01'`) instead of
  throwing. Only a test asserting exact numeric sequences caught it. Decide the parser once,
  globally.
- A concurrency test that acquires more clients than the pool `max` (default 10) before releasing
  any deadlocks. Raise `max` in test pools.
- Two concurrent "switch current" transactions both passed their own clear-previous step and both
  set their target, tripping a unique index instead of resolving to one winner. Lock the Workstream
  row (`SELECT … FOR UPDATE`) first, the same pattern the sequence allocator used. The engine
  contract now requires this serialization for authoring, birth and finalization.
- `SELECT … FOR UPDATE` requires the UPDATE privilege even when no UPDATE is ever issued.
- Reusing one placeholder both in an assignment and inside `CASE … IN (…)` raises
  `inconsistent types deduced for parameter` (42P08). Bind separate parameters.
- **The automated suite ran under a superuser role and missed five real privilege bugs** that only
  appeared live under the restricted application role (a column missing from a column-scoped
  `GRANT UPDATE`, among others). Test under the real roles; `asRole` makes denied SQL executable in
  tests.
- Idempotency keyed on `(grant, request_id)` alone rejected every legitimate retry that carried a
  fresh request id for the same target. Idempotency must be keyed on what identifies the operation.

## 6. Methodological lessons

These cost real hours and generalize beyond the component that taught them.

1. **A reproduction that does not travel the real client's path proves nothing.** Hand-written
   CONNECT probes bypassed the exact broken step while `curl` had been reporting
   `wrong version number` (TLS to a plaintext port) the whole time.
2. **A test double written to match our own implementation cannot catch our implementation being
   wrong.** The fake gateway accepted `Bearer` because that is what the relay sent; 50 tests were
   green against code that could never work. Fakes enforce what was verified against the real
   product.
3. **Verify by falsification.** Remove the ceiling, the growth test must fail; shift the scan
   offset by one byte, the reassembly test must fail.
4. **Assert exact values, not "no error".** Sequences, counts, hashes.
5. **A check against a field that does not exist reads `undefined` and passes.** The OneCLI policy
   field is `requireApproval`; a probe written against `approval` reported success.
6. **A spike that bypasses the component under construction does not validate it.** The harness
   spikes pointed `HTTPS_PROXY` straight at OneCLI and never exercised the relay. Scope spikes to
   the real seam or say loudly which seam they stand in for.
7. **Keep provenance in comments**: what was found, where, when. It is what stops the same trap
   being fallen into twice.
8. **Error paths carry the upstream detail.** `Problem.title` without `.detail`, or a status code
   without the API message, turns a self-explanatory refusal into an investigation.

---

## 7. Reuse register

Copy a brick only when its slice is built, with a header naming the archive path and what was
changed. Every brick is re-read against the current specifications before it lands; none of them
is a design input.

| Brick (archive path) | Keep | Adapt | Slice |
|---|---|---|---|
| `packages/acp/src/journaling-stream.ts`, `test/frame-bounds.test.ts` | Frame buffer with ceiling and incremental scan, commit-before-forward wrappers | Persist callback signature; lossless validation before persist | S4 |
| `packages/acp/spike/wire-journal.mjs` (validator derivation) | Method validators compiled from the pinned schema's `x-method`/`x-side`; the 13-variant assertion | Becomes a module with tests, not a spike | S4 |
| `packages/acp/src/classify.ts` | JSON-RPC kind classification | Operate on losslessly parsed values | S4 |
| `packages/store-pg/test/support.ts`, `src/db.ts` | Disposable UUID-named database per test, pool `max` 25, `asRole`, explicit `bigint` parser | Apply `contracts/db/schema.sql` instead of migrations | S2 (`packages/testkit`) |
| `contracts/database/002-access.sql` | NOLOGIN role per boundary, column-scoped `GRANT UPDATE`, race-safe `CREATE ROLE` | Roles redrawn per [ADR 0005](adr/0005-postgresql-durable-store.md) boundaries | S2 onward |
| `packages/store-pg/src/secret-guard.ts` | Write-path guard on non-envelope fields for known token shapes | Pattern list reviewed | S3 |
| `packages/store-pg/src/projections.ts`, `projector.ts` | Checkpoints, name-based UUID item identity, order-independent rebuild hash, `stableStringify` | Projector folds rewritten for the new fact kinds | S3, S4 |
| `scripts/run-schema-fixtures.mjs` | One valid and one invalid fixture per schema, stale fixture directories rejected | Paths | S2 |
| `apps/session-runtime-controller/src/k8s-client.ts` | Minimal REST client on the mounted ServiceAccount, `describeK8sError` | Add watch with `resourceVersion` and relist; the old client only polled | S6 |
| `apps/session-runtime-controller/src/pod-spec.ts`, `labels.ts` | Deterministic PodSpec from the reviewed definition only, numeric `runAsUser`, `runtimeClassName`, fixed relay/CA/stub mounts | Labels and identity per incarnation; no restore credential in the spec (custody transport moves to runtime-control) | S6 |
| `apps/session-runtime-controller/live-verification/*.yaml`, `apps/broker/live-verification/*.yaml` | Namespace, RBAC, NetworkPolicy shape, OneCLI deployment with PVCs for PostgreSQL and `/app/data` | Ports (6443), destinations, names | S6, S7 |
| `apps/broker/src/relay.ts`, `k8s-pod-lookup.ts` | Opaque CONNECT relay, Basic auth to the gateway, source-IP identity, no upstream socket before the decision | Reachability derived from fresh effective grants (ADR 0009), no independent allow policy | S7 |
| `apps/broker/src/onecli-real.ts` (grant sync, effective read, `listAgents`) | Raw REST calls verified on 1.45.0; convergent sync | Attached **and** effective inventories as a consistent pair; reservations and epochs | S7 |
| `apps/broker/src/route-policy.ts` host sets | Measured host lists per harness (`api.anthropic.com`; `chatgpt.com`, `auth.openai.com`) | Become catalogue files under review | S7 |
| `agents/*/src/bridge-server.ts` | WebSocket bridge spawning the adapter's **bin** entry per connection, generic `AGORA_*` env translated per harness | Incarnation authentication (P4); no custody logic in the bridge | S8 |
| `agents/claude-code/src/custody.ts`, `agents/codex/src/custody.ts` | The one-file-per-harness knowledge, exclusions, checksum on capture, session id read back from the payload | Driver interface from `packages/custody`; quiescent cut and workspace classification (P12) | S9 |
| `agents/*/src/session-id-tap.ts` | Learn the native session id from `session/new` responses and `session/resume` requests | Bounded buffers | S8 |
| `contracts/policies/handoff-seed-v1.md` | Inclusion table, byte budgets, deterministic truncation markers, no silent model summary | A starting draft for prerequisite P13, to be rewritten under the current rendering contract | S9 |
| `agents/*/image/Dockerfile` | Bake the adapter and harness at build, verify `--version` in CI, Node 22 base | Common tool bundle, digest pinning, non-root | S8 |

## 8. Deliberately not reused

`packages/domain` (session phases, command state machine), `packages/store-pg/src/{sessions,
commands,workstreams}.ts`, `apps/web/src/{orchestration,prompt-queue,idle-reaper,session-config,
projector-loop}.ts`, `apps/broker/src/{grant-service,onecli-agent-reaper,activations-repository}.ts`,
`apps/session-runtime-controller/src/reconciler.ts`, the SQL migrations, `packages/agent-registry`,
`packages/equipment-policy`, the `plans/` tree and the parked ADRs. They implement the persisted
lifecycle, per-Session Agents, grant TTLs and imperative commands that
[ADR 0003](adr/0003-reconciliation-over-state.md) and [ADR 0009](adr/0009-onecli-grant-authority.md)
replace. Their tests are likewise not a template, except for the testing discipline recorded in §6.

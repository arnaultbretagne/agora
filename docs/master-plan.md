# Agora implementation master plan

- **Status:** living roadmap, non-normative
- **Baseline:** the accepted [ADRs](adr/index.md) and [reconciliation specs](specs/reconciliation/README.md)
- **Last revised:** 2026-09-05

This plan sequences the implementation of the current design. It does not define behavior. Where
this document and a specification disagree, the specification wins and this document is wrong;
where a slice needs a contract the specification does not yet provide, the slice first extends the
owning specification (see [docs/AGENTS.md](AGENTS.md)), then implements. Proposed table, package
and API shapes below are starting points for the slice that owns them, not decisions.

Reading order: §1 target system, §2 technical foundations, §3 the slices in order, §4 the register
of prerequisites each slice must resolve, §5 milestones and risks. The measurements the retired
implementation left behind, and the code bricks worth copying per slice, are consolidated in
[field findings](field-findings.md).

---

## 1. Target system

### 1.1 Deployables and trust zones

[ADR 0001](adr/0001-unified-repository.md) splits the repository by responsibility and the runtime
by authority. The [owner table](specs/reconciliation/execution.md#owners-and-isolation) fixes five
authorities; four of them are Agora deployables, the fifth (OneCLI) is external.

| Deployable | Authority (execution.md) | Holds | Never holds |
|---|---|---|---|
| `apps/control-plane` | Product authorization, complete Intent, Workstream order, Session attribution, ACP Client, prompt admission, reconciliation workers | product DB roles (history, operational, projections, Save *metadata*), bridge client credentials | Kubernetes token, OneCLI control key, Save payload role, provider credentials |
| `apps/runtime-control` | Kubernetes workloads, live process evidence, controlled launch, isolation, custody transport, physical retirement inventory | namespace-scoped Kubernetes identity, custody payload *transport* role, its own operational records | product history write, OneCLI control key |
| `apps/broker` | Dedicated OneCLI Agent lifecycle, exact grant mutations, workload binding, opaque provider relay | OneCLI control key, Broker-private encrypted upstream authority, relay listener | product DB, Kubernetes token, provider TLS termination |
| `apps/web` | Browser shell and opaque relay of the product API | nothing | any data access |
| `harnesses/<harness_id>` | The reviewed image: pinned harness, ACP adapter, ACP bridge server, custody driver hooks, complete common tool bundle | scoped workload identity, bridge/relay endpoints, non-secret stubs | every credential and every control authority (hostile at runtime, ADR 0006) |

Workers inside the control plane never touch Kubernetes or OneCLI directly. They submit
*constrained owner requests* to runtime-control and broker through machine-readable contracts
([engine: effect ownership](specs/reconciliation/engine.md#effect-ownership-and-late-requests)).
Those two owners enforce epochs, reservations and fencing at their own boundary; that is the whole
reason they are separate processes with separate identities.

```text
 browser ──► apps/web ──► apps/control-plane ──┬──► apps/runtime-control ──► Kubernetes
                              │  (owner API)    │
                              │                 └──► apps/broker ──► OneCLI ──► providers
                              │                          ▲
                              │  ACP over bridge         │ CONNECT relay (opaque)
                              └────────────────► Pod (harness + ACP adapter + bridge server)
                                                          │
                              PostgreSQL ◄── custody transport (Save bytes) ◄── runtime-control
```

### 1.2 Reusable packages

Introduced only by the slice that needs them ([ADR 0001](adr/0001-unified-repository.md)); the
names are proposals. A package never depends on a deployable (`npm run check` enforces it).

| Package | Content | First slice |
|---|---|---|
| `packages/domain` | Identifiers, Intent shape and validation, the three taxonomies as closed types, the ordered rule tables as data, the `PASS/ACTION/HOLD/CONVERGED` grammar, the pure evaluation function | S1 |
| `packages/engine` | Workset, claims/leases, ticks (LISTEN/NOTIFY + polling), attempts, mutation epochs, conditional finalization, backoff and sweeps, all on PostgreSQL | S2, S5 |
| `packages/journal` | Workstream fact append with canonical sequence, Session birth with pinned cutoff `H`, fact-kind registry, Session reads as filtered views | S3 |
| `packages/projections` | Deterministic, versioned, checkpointed projectors from facts to readable items; rebuild | S3, S4 |
| `packages/acp` | Lossless capture seam, per-kind envelope validation against the pinned ACP schema, ACP Client wiring over the bridge, dispatch reservations and unknown-delivery bookkeeping | S4 |
| `packages/owner-requests` | The shared request/reservation/epoch protocol both owners implement and the control plane calls; typed clients generated from `contracts/api` | S5 |
| `packages/policy` | Reviewed catalogues (harness definitions, tool bundle, model/effort catalogues, capability→grant mappings), revision selection, the capability compiler, the exact grant comparison model | S7 |
| `packages/observation` | Normalizers producing `observation.*` from fresh owner reads, with source identity, incarnation, completeness and validity conditions | S6, S7, S8 |
| `packages/custody` | Save metadata, Anchors, invalidations, conditional publication, driver interface, payload-store client for the custody role | S9 |
| `packages/testkit` | Disposable PostgreSQL databases, controllable clock, fake owners (Kubernetes, OneCLI, harness) with injectable pauses/crashes/lost responses, interleaving runner | S2 onward |

### 1.3 Contracts

`contracts/` holds every boundary two deployables share. Each is introduced by its slice and
validated in CI (schema validity, fixture round-trips, dependency rules).

| Contract | Form | Owner slice |
|---|---|---|
| `contracts/db/schema.sql` | One file, sections per authority boundary, PostgreSQL roles per boundary; applied from scratch by `npm run db:reset` (no migrations before first release) | every slice adds its section |
| `contracts/api/control-plane.openapi.yaml` | Product API consumed by `apps/web`: Workstreams, Intents, commands, resumable feed | S2, S4, S12 |
| `contracts/api/runtime-control.openapi.yaml` | Owner API: inventories, create/retire requests, launch seam, process evidence, custody transport | S6 |
| `contracts/api/broker.openapi.yaml` | Owner API: Agent lifecycle, grant mutations, attached/effective inventories, binding | S7 |
| `contracts/schemas/*.schema.json` | Intent, fact kinds, owner request envelope, grant authorization model, Save metadata, opening descriptor, Handoff command | per slice |
| `contracts/catalogue/*` | Reviewed versioned files: harness definitions with pinned digests, common tool bundle, model/effort catalogues, capability→OneCLI mappings, rendering/seed policy revision | S7, S8, S9 |
| ACP | The pinned `@agentclientprotocol/sdk` stable v1 schema is itself the harness contract; Agora adds no schema of its own ([ADR 0004](adr/0004-acp-boundary-and-session-facts.md)) | S4 |

### 1.4 Durable records by authority boundary

[ADR 0005](adr/0005-postgresql-durable-store.md) keeps four meanings apart. The proposed grouping
below is what the schema sections and roles will follow; exact columns belong to each slice.

**Canonical history (append-only, product role read/append).**
`workstreams`; `workstream_intent_events` (`workstream_id`, `intent_seq`, complete Intent,
request key, author, selected revision set); `workstream_facts` (`workstream_id`, `seq`,
`session_id`, kind, payload, direction/causation for ACP envelopes); `sessions` (identity, pinned
cutoff `H`, Pod UID and provenance, opening descriptor fields as they are bound).

**Operational control (durable, not history).**
`workstream_reconciliation_work` (one row per Workstream: `intent_seq`, `work_generation`,
due time, claim token, lease expiry, backoff state, blocking cause); `mutation_epochs`;
`owner_attempts` (attempt key, epoch, target, payload digest, reservation status, dispatch and
recovery owners, unknown-acceptance state); `command_dispatches` (prompt/Handoff commands with the
same reservation discipline); `revision_publications` (affected Workstream enumeration for bounded
re-enqueue). Runtime-control and broker keep their own operational tables (retirement obligations,
Broker-private bindings) under their own roles; they are not product history.

**Projections (disposable).**
`projection_checkpoints`, `workstream_items`, `workstream_turns` and later views, each carrying
projector version and source fact references; dropped and rebuilt on projector change.

**Custody (opaque, separate roles).**
`saves` (metadata only, product-readable), `save_payloads` (bytes, custody role only),
`anchors` (one per Workstream/harness, monotonic frontier, conditional publication),
`save_invalidations` (append-only evidence).

---

## 2. Technical foundations

### 2.1 Toolchain

Node 22 LTS and TypeScript 7 in npm workspaces, native ES modules, `node:test`, no framework and
no bundler anywhere (the same posture the carried-over client already has). PostgreSQL 17 via `pg`.
Dependencies are pinned exactly; the ACP SDK and adapters are architectural pins reviewed on change.

### 2.2 Lossless ACP capture

ADR 0004 forbids passing an envelope through an IEEE-754 `number` before persistence. The seam is
therefore placed on the *raw framed text*, in both directions, below the SDK:

- incoming: the bridge framer yields one complete envelope as text; it is validated with a
  lossless parser (`lossless-json` or equivalent, integers kept as strings/bigints), then the
  text itself is sent to PostgreSQL as `jsonb` (PostgreSQL's `numeric` preserves every integer
  exactly; member order and whitespace have no ACP meaning). Only after commit is the text handed
  to the SDK for semantic handling;
- outgoing: the SDK serializes locally produced objects; the serialized text is captured,
  committed, then written to the transport.

The SDK is never allowed to replace the captured value. Projectors read `jsonb` and may use
ordinary numbers only for fields whose type the schema bounds.

### 2.3 Kubernetes

Runtime-control talks to the API server with a small in-house REST client over `fetch`
(watch with resourceVersion, relist on cursor loss, bounded sweeps), authenticated by its own
ServiceAccount, scoped to one namespace. Pods carry immutable labels for `workstream_id`, the
creation attempt key and the incarnation; the Pod UID is the concrete target for every later
request. Isolation is declared per Pod (non-root, no ServiceAccount token, resource limits) and
per namespace (default-deny NetworkPolicy; egress only to the bridge listener and the Broker
relay). Physical fencing for partitioned nodes is an open prerequisite (§4).

### 2.4 OneCLI

Broker uses the pinned `@onecli-sh/sdk`. Before S7 is accepted, the integration must demonstrate
what the engine assumes of an owner: exhaustive per-Agent inventories of attached *and* effective
grants, discoverability of an Agent whose creation response was lost, and either conditional
mutation/idempotency or a single serialized trusted writer with reservation before dispatch
([engine: effect ownership](specs/reconciliation/engine.md#effect-ownership-and-late-requests)).
No Agora-specific epoch parameter is assumed on the OneCLI side.

### 2.5 Harness images

One image per `harness_id`, pinned by digest, built from the repository: the harness and its
official ACP adapter (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`),
the ACP bridge server that authenticates the incarnation and frames envelopes, the custody driver
hooks, and the same complete tool bundle in every image. Nothing is installed at Pod start.

### 2.6 Testing strategy

| Level | What it proves | Tooling |
|---|---|---|
| Rule partition | Every rule table is mutually exclusive and exhaustive over its registered value domains | property-based enumeration in `packages/domain` |
| Persistence | Sequences, uniqueness, roles, conditional updates behave as the engine contract requires | real PostgreSQL, one disposable database per test |
| Interleavings | The `ENGINE-*`, `OFF-*` and `SESSION-A*` scenarios under injected pauses, crashes, lost responses and clock advances | `packages/testkit`: controllable clock, fake owners, scripted interleavings |
| Owner conformance | Real Kubernetes, real OneCLI and each real harness satisfy the [conformance table](specs/reconciliation/execution.md#harness-and-owner-conformance) | kind cluster and a OneCLI instance in CI, later |
| End to end | A browser creates a Workstream, an Intent is realized, a prompt runs through a real harness with exact grants, shutdown preserves a Save, a new Pod resumes it | kind + images, nightly |

A design scenario is not an executed test. Each slice lists which scenarios it executes and how.

### 2.7 Observability and safety

Structured logs carry actor, Workstream, Session, target, revision and outcome; never query
strings, headers, prompts, tool content, credentials or Save bytes. Metrics per boundary
(claims, ticks, attempts by state, HOLD causes, owner latency). Every deployable has a health
endpoint and a readiness that reflects its owner connections.

---

## 3. Slices

Each slice has an executable plan under [`docs/plans/`](plans/README.md), written for a development
agent: reading list, spec repairs to make first, ordered steps with acceptance, scenarios to run,
reuse allowed from the archive. Every slice follows the same shape and is one or a few pull requests:

1. **Spec alignment** — the owning specification is extended or repaired first if a needed
   contract is missing; open questions are named, not filled by inference.
2. **Contracts** — schema section, API, JSON schemas, catalogue files.
3. **Code** — packages and deployables, with the dependency rules and vocabulary checks green.
4. **Evidence** — the listed acceptance scenarios executed, the remaining limitations stated.

Definition of done: the slice's scenarios run in CI, the docs it touched are consistent, no
placeholder or silent fallback was introduced, and README/AGENTS point to what now exists.

### S0 — Repository scaffold (done)

Workspaces, checks, CI with PostgreSQL, `db:reset`, `apps/web` carried over behind a static server
with an opaque `/v1` relay. Pull request #35.

### S1 — Domain core and pure rule engine (done)

**Goal.** Make the taxonomies and the seven ordered rule tables executable as pure code, with the
partition property proved. Pull request #39.

**Sources.** [000](specs/reconciliation/000_taxonomy.md), [001](specs/reconciliation/001_intent.md),
[002](specs/reconciliation/002_observation.md), [003](specs/reconciliation/003_verbs.md),
[004](specs/reconciliation/004_power.md) to [010](specs/reconciliation/010_converge.md).

**Delivers.** `packages/domain`: identifiers; Intent type and validator (`power`, `harness`,
`capabilities`, `model`, `effort`, frozen `persona`); `observation.*` types including `∅`/`⊥`
for construction and the grant authorization sets; verbs and results; each rule table as data
with stable ids; `evaluate(intent, observationReader)` that walks the tables from POWER, acquires
fields lazily through the reader, returns the first non-PASS result and records which rule fired.
The exact grant comparison model (`A = D ∧ E = D`, inclusion under prerequisites, unknown entries
never equal) lives here as pure functions over a representation `packages/policy` will refine.

**Contracts.** `contracts/schemas/intent.schema.json`.

**Evidence.** For every table, an enumeration over the registered value domains asserting exactly
one row matches; ordering tests (`CAPS-001` before `CAPS-002`, model before effort); an
"incomplete rule set" guard. No scenario from the catalogue closes here; everything later
depends on it.

**Open before merge.** None; this slice uses only registered vocabulary.

### S2 — Intent authoring, workset and ticks (done)

**Goal.** The durable spine of [ADR 0003](adr/0003-reconciliation-over-state.md): complete Intents
are appended, one work row per Workstream is coalesced, workers claim due work, evaluate, and
finalize conditionally; nothing external is mutated yet. Pull request #40.

**Sources.** ADR 0003; [engine](specs/reconciliation/engine.md) sections *Intent authoring*,
*Work generations, claims and leases*, *Tick and acquisition*, *Retry budgets and fairness*,
*Conditional finalization* (POWER off convergence only).

**Delivers.** Schema section: `workstreams`, `workstream_intent_events`,
`workstream_reconciliation_work`, `revision_publications`. `packages/engine`: authoring
transaction (per-Workstream lock, request-key idempotency, increasing `intent_seq`, fresh
`work_generation`, empty `NOTIFY workstream_reconciliation`); listener plus polling; bounded
batch claims with database-time leases; renewal/release comparing claim and generation;
backoff with cap and jitter; conditional finalization; a fake observation source so POWER can be
exercised end to end (`POWER-001` converges an off Intent against an empty fake inventory).
`apps/control-plane` is born: product API for Workstreams and Intents, a worker process, health.
`apps/web` plumbing part 1: create/list/rename/delete Workstreams and submit `power on/off`
Intents (the legacy `api.ts` calls are replaced progressively; the allowlist entry stays until S12).

**Contracts.** `contracts/api/control-plane.openapi.yaml` (Workstreams, Intents),
schema section, a first authorization model (principal per request; product authorization per
Workstream is an open decision recorded in §4).

**Evidence.** `ENGINE-001`, `ENGINE-002`, `ENGINE-003`, `ENGINE-004`, `ENGINE-005`,
`ENGINE-010`, `ENGINE-015`, `ENGINE-016`, `ENGINE-017` (authoring side) as interleavings on real
PostgreSQL with `packages/testkit`'s clock and paused workers.

### S3 — Workstream journal, Sessions and projections framework (done)

**Goal.** One canonical ordered fact stream per Workstream, Sessions as filtered views, birth
that pins `H`, and a projector framework that is rebuildable by construction. Pull request #41.

**Sources.** [ADR 0002](adr/0002-workstream-session-model.md), ADR 0004 (facts and projections),
[execution: Session birth](specs/reconciliation/execution.md#session-birth-and-admission),
[continuity: opening descriptor](specs/reconciliation/continuity.md#opening-descriptor).

**Delivers.** Schema: `workstream_facts` with a per-Workstream sequence allocated under the
same lock as Intent authoring, `sessions`, fact-kind registry, `projection_checkpoints`.
`packages/journal`: append, Session birth as one idempotent operation (pin `H` to the head, open
the Session, record Pod UID/provenance; repeating cannot create a second Session or cutoff),
Session reads. `packages/projections`: projector interface (version, fold, checkpoint), rebuild
command, a first trivial projector (Session list with provenance).

**Evidence.** `CONT-001` (bootstrap facts never enter their own range), `CONT-002` (`W = H = 0`
on a fresh Workstream), idempotent birth under concurrent repetition, projector determinism
(rebuild equals incremental).

### S4 — ACP capture seam, bridge client, commands and feed (done)

**Goal.** Complete ACP envelopes become Session facts losslessly in both directions; prompts are
commands with reservations; readable items are projections served to the browser. Pull request #42.

**Sources.** ADR 0004; [execution: ACP facts and current evidence](specs/reconciliation/execution.md#acp-facts-and-current-evidence);
[engine: prompt delivery](specs/reconciliation/engine.md#prompt-delivery-and-context-creation).

**Delivers.** `packages/acp`: framer, lossless validation per message kind/direction/method,
commit-before-transport and commit-before-handling, safe diagnostics for invalid frames, the
ACP Client built on the pinned SDK over an authenticated WebSocket bridge, dispatch reservation
of a command before send, unknown-delivery (`prompt_delivery_unknown`) state and its
user-visible exposure, late-frame attribution. Schema: `command_dispatches`, ACP fact kinds.
Projectors: messages, thoughts, tool calls, plans, permission interactions, prompt turns.
Product API: submit prompt, cancel, resumable feed (SSE over fetch, as the client already
expects). `apps/web` plumbing part 2: conversation view on the new feed. A local development
harness process (no Kubernetes yet) lets this slice run end to end against a real adapter.

**Evidence.** Validation boundary items: lossless integers beyond 2^53 round-trip, unknown
members and `_meta` preserved, two identical envelopes are two facts, projector rebuild equals
live projection. `SESSION-A05` (old frame keeps its attribution), `CONT-005` (lost prompt
response gates the next turn, no blind resend).

**Open before merge.** Re-pin the ACP SDK version and confirm adapter support for
`session/set_config_option`, model/effort readback and `session/resume` (§4).

### S5 — Owner request protocol, epochs and attempt recovery (done)

**Goal.** The part of the engine that makes external effects safe, exercised entirely against
fake owners so its interleavings are cheap to run before any real Kubernetes or OneCLI exists.
Pull request #43.

**Sources.** [engine: effect ownership](specs/reconciliation/engine.md#effect-ownership-and-late-requests),
*Action recovery*, *Watches and recovery sweeps*, *Conditional finalization*.

**Delivers.** `packages/owner-requests`: request envelope (epoch, concrete or reserved target,
attempt key, payload digest), reservation before dispatch, takeover recording both owners,
unknown-acceptance retention, rejection of reused keys with different inputs, retirement of
targets surviving work-row deletion. `packages/engine`: mutation epochs, lease transfer that
settles the old owner's possible dispatches first, watches/sweeps abstraction, per-Workstream
retry budgets, verb execution as "submit one owner request, then emit the continuation tick".
`packages/testkit`: fake runtime-control and broker implementing the protocol with injectable
lost responses, delayed acceptance and crashes.

**Evidence.** `ENGINE-006`, `ENGINE-007`, `ENGINE-008`, `ENGINE-009`, `ENGINE-011`,
`ENGINE-012` (sweep path), `ENGINE-014`, `ENGINE-018`, all as interleavings on fake owners.

### S6 — Runtime control on Kubernetes (done)

**Goal.** The first real owner: Pods materialized from reviewed definitions, exhaustive
inventories with retirement obligations, the controlled launch seam, process evidence. Pull
request #44.

**Sources.** [ADR 0007](adr/0007-kubernetes-runtime.md), ADR 0006,
[execution: owners and isolation, shutdown and extinction](specs/reconciliation/execution.md),
[observation.power / construction / session](specs/reconciliation/002_observation.md).

**Delivers.** `apps/runtime-control` with its owner API: inventory (every Pod regardless of
phase, plus unresolved retirement obligations), create (BUILD's Kubernetes part, reserved
target discoverable by pre-recorded correlation), retire (TURN_OFF's Kubernetes part: bounded
grace, obligation kept until termination evidence or fencing), launch seam (gate the established
Pod, place restored bytes later in S9, start the pinned harness), process evidence (generation,
context binding), image evidence (admitted pinned spec and running container image ID under the
reviewed digest mapping). Watch plus relist plus sweep feeding the engine's wake sources.
`packages/observation`: `observation.power` (Kubernetes contribution), `observation.construction`
(Pod coherence, `⊥` cases), `observation.session` for `pending`/`openable`/`unusable`.
Manifests for a namespace with default-deny NetworkPolicy, ServiceAccounts and RBAC per
deployable. CI gains a kind cluster job.

**Evidence.** `OFF-003`, `OFF-005` (as far as fencing is specified), `OFF-006` (Kubernetes
side), `SESSION-A06`, `ENGINE-012` (watch path), startup deadline expiry observed as `unusable`,
force-deleted Pod retained as obligation.

**Open before merge.** Physical fencing mechanism and startup/shutdown deadlines (§4).

### S7 — Broker, OneCLI and exact capabilities (done)

**Goal.** The second real owner: one selective Agent per Pod incarnation, exact grant sets,
attached versus effective inventories, the CONNECT relay confined by effective grants. Pull
request #45.

**Sources.** [ADR 0009](adr/0009-onecli-grant-authority.md), [ADR 0010](adr/0010-capabilities-are-onecli-grants.md),
[001: capability compilation](specs/reconciliation/001_intent.md#capability-compilation),
[002: exact grant comparison](specs/reconciliation/002_observation.md#exact-grant-comparison),
[006 CAPABILITIES](specs/reconciliation/006_capabilities.md), verbs GRANT/REVOKE.

**Delivers.** `packages/policy`: reviewed catalogue files, revision selection shared by all
workers, the capability compiler (typed denial for unknown or unmappable capability, union
before difference, output bound to the policy revision and digest). `apps/broker`: Agent
lifecycle bound to a Pod UID, grant/ungrant with reservation and readback, attached/effective
inventories as a consistent pair (reacquire when they straddle a mutation), workload-authenticated
relay forwarding opaque CONNECT only to OneCLI with a deterministic reachability projection of
the fresh effective set, closure of routes and existing tunnels on restriction independent of
ACP. BUILD and TURN_OFF gain their Broker parts. `packages/observation`: `grants.attached`,
`grants.effective`, power/construction contributions from Agents and bindings.

**Evidence.** `AUTH-001` to `AUTH-009`, `OFF-004`, `OFF-007`, `SESSION-A10`, `ENGINE-013`,
`ENGINE-017` (cleanup side). Conformance of the real OneCLI against the owner obligations in §2.4.

**Open before merge.** Concrete capability→grant mappings for the first capabilities, OneCLI
inventory/idempotency capabilities, relay authentication of the incarnation (§4).

### S8 — First harness integration: claude-code (merged; live run done in S13)

**The open item S8, S9, S10 and S11 each recorded — "the run on real Kubernetes with real OneCLI
credentials" — is CLOSED (S13, 2026-09-07).** On the g4 cluster a Workstream reconciled
BUILD → GRANT → START → SET_MODEL → converged against a real harness Pod, was captured into a Save
on TURN_OFF (12 052 bytes, Anchor published), and on power-on was RESTORED from that Save into a new
Pod that resumed the same native context. What is still open is narrower and is not this
repository's: a provider ACCOUNT attachment inside OneCLI, and codex's version-specific auth stub —
both recorded under S13. Everything each of these four slices left "to be proved live" is proved,
except that a model's own answer needs that account.

**Status.** Steps 1-6 are implemented, tested and merged (pull request #46): the image builds and is
asserted in CI, START binds exactly one context with unknown-acceptance discovery,
observation.session/model/effort/sync are live, SET_MODEL/SET_EFFORT drive the real context, the
admission checklist gates every prompt dispatch, prompt delivery recovery resolves an ambiguous
dispatch against the harness's own `session/load` replay (mechanism measured, not assumed), the hot
Session boundary's database mechanism exists, and `harnesses/conformance` runs black-box against any
harness (10 passed / 0 failed / 2 skipped against the real adapter). **Not done:** the first
end-to-end run named in Evidence below — it needs the current code deployed on real Kubernetes with
real OneCLI credentials, which is a deployment decision (the cluster's running `agora-*` workloads
are the retired implementation's, not this codebase's) rather than remaining engineering. S8 is
therefore NOT marked done.

**Goal.** A live ACP context inside a Pod, its configuration read truthfully, the first user
prompt admitted through the full chain.

**Sources.** ADR 0006, [execution: harness and owner conformance](specs/reconciliation/execution.md#harness-and-owner-conformance),
[007 SESSION](specs/reconciliation/007_session.md) (START path), [008 CONFIG](specs/reconciliation/008_config.md),
[009 SYNC](specs/reconciliation/009_sync.md) (empty range only), [010 CONVERGE](specs/reconciliation/010_converge.md),
verbs START, SET_MODEL, SET_EFFORT.

**Delivers.** `harnesses/claude-code`: image with pinned harness, official ACP adapter, bridge
server, common tool bundle; catalogue definition with model/effort options and bootstrap
authority. Control plane: START (`session/new`, bind the actual returned context, never open a
second one on a lost response), CONFIG through `session/set_config_option` with fresh readback,
the admission checklist before the first user prompt, hot Session boundaries for model/effort
changes on a retained Pod, conditional finalization completing the attribution boundary.
`packages/observation`: `session = live`, `model`, `effort` under the snapshot/continuous-stream
freshness contract; `sync = current` for `W = H`. Harness conformance suite runnable against the
image.

**Evidence.** `SESSION-A01` to `SESSION-A04`, `SESSION-A07`, `SESSION-A08`, `SESSION-A09`,
`ENGINE-018`, plus the first end-to-end run: browser → Intent → Pod → exact grants → prompt →
streamed answer → facts and projections.

**Open before merge.** Resolved: adapter evidence for `set_config_option` and actual model/effort
readback after resume (P3, truthful — `harnesses/claude-code/README.md`); bridge authentication
material (P4, implemented and tested); START/CONFIG/admission and the real bridge prompt path
(`apps/control-plane`, all tested against a real ACP agent, not mocks at the ACP-message level);
Step 5's prompt delivery recovery, whose mechanism was measured live against the pinned adapter
(`session/load` replays the verbatim history — see the harness README's own Step 5 section) and
implemented in `apps/control-plane/src/recovery/context.ts`. Still genuinely open: the hot Session
boundary's own trigger — the database mechanism exists (`packages/journal`'s `commitHotBoundary`)
but nothing in S8's own rule tables currently invokes it (CONFIG/CAPABILITIES changes are already
handled live without ending the Session; S9's restore path looks like the first real trigger, not
S8's own scope); the actual end-to-end run, which needs the built image deployed on real Kubernetes
with real OneCLI credentials (CI's `harness-image` job now builds and asserts the image, but running
the full chain is a deployment step beyond it). The conformance suite itself exists
(`harnesses/conformance`, black-box over any harness's ACP surface) and was run against the real
pinned adapter: 10 passed, 0 failed, 2 skipped — the skips being the relay row (needs a Pod) and one
real finding, that a context with no content is not listed, so START cannot discover the orphan of a
lost `session/new` (recorded in the harness README and at the point in `verbs/start.ts` where it
matters).

### S9 — Native continuity: Saves, Anchors, restore and refill (merged; live run done in S13)

**Status.** Everything below is built, tested and merged. The one thing not done is the same one
S8 leaves open and for the same reason: the run on real Kubernetes with real OneCLI credentials,
which is a deployment decision rather than remaining engineering. In its place, the off/on cycle
was run end to end against the REAL adapter, driver, custody transport, owner API and database,
with only Kubernetes and OneCLI stubbed (`scripts/s9-end-to-end.mjs`): a codeword planted before
the shutdown, captured at a quiescent cut, its Anchor advanced, restored into a home that had never
seen the context, resumed, refilled with the facts appended while off — and recalled. S9 is
therefore NOT marked done.

That run paid for itself twice. It caught the control plane hardcoding `/workspace` while the
PodSpec launched the adapter in the harness definition's own root (the workspace root is now
configured once, from the catalogue, and read everywhere), and it caught `save_payloads`
referencing `saves` in the wrong commit order — bytes cannot be written under a Save that has not
committed yet, so TURN_OFF now commits the metadata, binds the payload, and publishes the Anchor as
three ordered steps whose every gap is survivable in exactly one direction.


**Goal.** Shutdown preserves eligible native context within a fixed budget; a new Pod restores,
resumes and refills exactly `(W, H]`; the opening Handoff follows a versioned seed policy.

**Sources.** [ADR 0008](adr/0008-saves-anchors-and-refill.md), [continuity](specs/reconciliation/continuity.md),
verbs TURN_OFF (capture part), RESTORE, REFILL, [observation.anchor / sync](specs/reconciliation/002_observation.md).

**Delivers.** Schema: `saves`, `save_payloads` (custody role), `anchors`, `save_invalidations`.
`packages/custody`: capture key bound to Pod/process/context and frontier, atomic visibility
after checksum, conditional Anchor publication with expected previous Anchor, compatibility
check against the observed harness definition, append-only invalidation, retention rules.
Runtime-control: custody transport (place and verify bytes before launch; the Pod never sees the
store). The claude-code custody driver: quiescent cut, format/version, native proof of the
exact opening input and lineage across supported compaction. Control plane: the opening
descriptor completed idempotently, the Handoff renderer under a versioned seed policy with
deterministic truncation, REFILL under the same reservation discipline as any prompt,
`observation.sync` from driver evidence only. Workspace dependency classification.

**Evidence.** `CONT-003` to `CONT-012`, `OFF-001`, `OFF-002`, `OFF-008`, A → A resume end to end.

**Open before merge.** Seed policy revision, driver/workspace mechanism, Save size and time
limits, retention values (§4). These are named prerequisites in the specs; S9 is where they are
written down and demonstrated.

### S10 — Second harness, catalogue publication and A → B → A (merged; live run done in S13 for claude-code)

**Status.** Built, tested and merged, with the same single item open as S8 and S9: the run on real
Kubernetes with real OneCLI credentials. A → B → A itself was run end to end against BOTH real
adapters (`scripts/s10-a-b-a.mjs`), and the conformance suite scores the same on codex as on
claude-code.

The second harness earned its place by breaking two assumptions that had looked like facts:

1. **`initialize` is a process-level handshake, not a per-connection one.** codex refuses a second
   one (`Already initialized`); claude-code tolerates repeats, which is why nobody noticed. Agora
   initialized on every verb's fresh connection. Both adapters accept `session/*` on a connection
   that never initialized, so the handshake moved to the harness bridge, which owns the process and
   now performs it exactly once.
2. **An un-prompted codex context has no persisted state and cannot be resumed.** The observation
   probe resumed the bound context every tick to read its configuration; for codex that fails
   between START and the first prompt, which would have left the Workstream permanently short of
   `live`. How a harness answers a configuration readback is now declared per harness, alongside
   what it calls the `model` and `effort` options — codex calls effort `reasoning_effort`, and that
   is a mapping in the reviewed definition, never a second Intent field.

The conformance suite needed three fixes of its own, each one the suite assuming claude-code's
behaviour rather than testing a requirement. A new check, `identity/handshake-is-per-process`,
exists so the first of those cannot regress silently.


**Goal.** Prove the design holds for more than one harness and that revision publication is a
first-class wake.

**Delivers.** `harnesses/codex` with its conformance evidence and custody driver; catalogue
revision publication with durable enumeration of affected Workstreams and bounded re-enqueue;
`CONSTRUCT-002` replacement on a re-pinned digest; per-harness Anchors.

**Evidence.** `CONT-007`, `SESSION-A11`, `ENGINE-014` (revision change mid-tick), image
upgrade replaces a live Pod after a bounded Save.

### S11 — Operations, retention and hardening (merged; deployment done in S13)

**Status.** Done and merged: the pinned settings and their falsification tests, retention and the
Workstream deletion pipeline, telemetry with an allow-list redaction test, `/v1/metrics` and
`/v1/readyz`, the Kustomize deployment, the runbook and the security review. Not done, and each for a
stated reason rather than an omission:

- the OneCLI backup/restore drill is written from the measured asset list but has not been performed
  — it is an action on the live cluster;
- provenance attestation and digest-pinned publication belong to whatever pushes images to a
  registry, which CI deliberately does not do yet (SBOMs are produced per image and kept as build
  artifacts);
- the security review's *deployment* rows are claims about manifests and code, checked by reading
  them; confirming them on a cluster is the same open item S8, S9 and S10 each record.

The settings work is the part worth naming: every timing the specs left open is now in one reviewed
file with a line of rationale each, read through a loader that carries NO defaults — a value that can
silently fall back to something in code is a value nobody has decided. The coherence rules between
settings are each proved by falsifying them, so a capture budget that could swallow the whole
shutdown window, or a lease that could be reclaimed under a live worker, fails a test rather than a
production incident.


**Delivers.** Pinned deployment settings (claim duration, renewal, evidence expiry, action and
startup/shutdown deadlines, retry caps, resynchronization bounds) with the conformance suite
proving them under the controllable clock; retention jobs for Saves and staging; break-glass
audit; metrics and dashboards; supply-chain review of every image (digest pinning, SBOM,
provenance); deployment packaging (Kustomize or Helm) per deployable; a security review pass
over trust boundaries and log redaction.

### S12 — Web plumbing completion (merged)

**Status.** Done and merged. `api.ts` is rewritten against the contract, the vocabulary allowlist is
empty for the first time, and the UI expresses the product in the design's own terms: an Intent
editor whose every value comes from the catalogue endpoint the server validates against, and a
status line that is DERIVED on each render rather than read from a stored phase — because no phase
exists.

The three things the specs insist must be visible now are: a blocking cause verbatim with its rule
id (a paraphrase is not actionable), an external restriction that says who can lift it rather than
claiming we are working on it, and an ambiguous delivery that outranks everything and closes the
composer — with no automatic resend, ever. Alongside them, the CONT-012 loss banner counts the facts
newer than the newest recovery point and says the distinction that matters: Agora keeps them, the
native context may not.

Two endpoints were added to serve it — `GET /v1/catalogue` and `GET /v1/workstreams/{id}/sessions`.
Their owning slices are closed, so they were added here rather than invented in the client, which is
the choice the plan asks for in the order it asks for it.

**Permissions round-trip, and the UI never reports a click as an outcome.** The pending list
published only opaque ids, which no operator could answer, so it now carries the options the agent
itself offered — and the control plane refuses an `optionId` outside that set rather than answering a
closed question with an invented value. Pressing one shows *sent*; only the journaled, projected
response frame turns it into an answer, quoted from the wire rather than from what this browser
believes it did.

**The accessibility pass found four real defects and fixed them:** a control claiming `role="button"`
that answered no key, menus that could be opened by keyboard and not closed, selector triggers with
no `aria-expanded`, and focus rings the shell never drew. What is deliberately NOT claimed is a
screen-reader pass — that needs a person with a screen reader, and correct markup is not evidence of
one.


**Delivers.** `api.ts` rewritten against `contracts/api/control-plane.openapi.yaml` (removes the
last vocabulary allowlist entry), Intent editor (harness, capabilities, model, effort),
unknown-delivery and HOLD causes surfaced to the operator, native-loss exposure display
(`CONT-012`), accessibility pass, browser boot test kept.

### S13 — First real deployment (merged; two provider-account items open)

**Status.** Deployed and running on the g4 cluster. `kubectl apply -k deploy/overlays/live` brings up
the control plane (API + worker), runtime-control, the Broker and the web surface against a CNPG
database of their own, with every image published by digest, SBOM'd and provenance-attested by the
`publish` workflow. `/v1/readyz` reaches its owners. A Workstream authored through the product API
reconciles all the way: **BUILD → GRANT → START → SET_MODEL → converged**, with a real harness Pod,
a real OneCLI grant, a real ACP context, and the work row finalized. A prompt travels the whole
path — product API, engine dispatch, ACP over the bridge, the adapter, the CLI, the Broker's relay,
OneCLI's TLS-intercepting gateway, the provider — and the answer comes back, is journaled,
projected, and served to the client.

**Nothing in this repository could be deployed before it, and almost nothing worked when it could.**
Every defect below was found by running it, in this order, each one hiding the next:

| What was wrong | What it cost |
|---|---|
| no Dockerfiles for three of four deployables; CI pushed nothing | nothing to deploy |
| kustomize load restrictions, duplicate namespace/ServiceAccount ids, an overlay `namespace:` that renamed a namespace OBJECT | `apply -k` aborted before producing an object |
| `args: ['api']`, a `MODE` env nothing reads, every Broker env name invented, the Broker's token switched off | both deployments would run both modes; the Broker would refuse every request or throw at boot |
| a bare `sha256:…` as an image reference | not a pullable reference at all |
| no `CLAUDE_CODE_OAUTH_TOKEN` / `SSL_CERT_FILE` / codex `auth.json` in the PodSpec | both adapters start and refuse — indistinguishable from a Pod that never scheduled |
| PodSecurity "restricted" (no `capabilities.drop`, no `seccompProfile`) | the API server refused the Pod outright |
| `activeDeadlineSeconds` set to the STARTUP deadline | every harness Pod killed after two minutes of healthy work |
| an empty `imageId` read as an image id | every Pod destroyed mid-pull, for ever |
| `NetworkPolicy` allowing neither runtime-control egress nor the real control-plane labels | the Pod could not reach its seam; the bridge WebSocket was dropped by the CNI |
| ENGINE-008 recovery never implemented: an `unknown` attempt was never re-asked | the first owner error wedged the Workstream permanently |
| a Session whose Pod was replaced never ended | `sessions_one_current_per_workstream` refused every later Session for ever |
| the engine never recorded the retirements the owner recorded | BUILD rebuilt into a retired incarnation, and every later operation on it was refused as stale |
| no deadline on any owner call, adapter call, or pool checkout; a hung scan cleared no flag | a silent worker with a claimed row, twice; then an exhausted pool that blocked every tick before its first query |
| a double close of the bridge socket threw from a WebSocket handler | the worker crash-looped |
| **every inbound bridge frame was empty** (`new Uint8Array(blob)` — Node delivers binary as a Blob) | the entire ACP path had never worked over a real socket: 63 requests journaled, zero responses |
| the workspace root did not exist | the adapter refused every session |
| `resolve.capabilityGrants` returned the empty set | no Pod ever received a credential — CAPS passed at "nothing desired" |
| a non-empty opening range with no Handoff was undecidable | a fresh Session on a Workstream with history could never converge |
| a 15s adapter timeout | cut off a call that legitimately took 21.5s on a cold adapter, orphaning contexts |

Two more were in the cluster rather than the code, and are fixed in `infra-k8s`: OneCLI's ingress
policy named only the retired implementation's Broker (a DROP, so the call hung rather than failed),
and the `agora-onecli-ca` ConfigMap still held the pre-cutover CA, so every provider call failed with
"Self-signed certificate detected" — a message that names neither the file nor OneCLI.

**Open, and both are OneCLI account state rather than code:** the Anthropic credential exists in
OneCLI and is granted to the Agent, but the gateway answers `access_restricted` for every agent
including its own default — the account is not attached at the app level, and attaching it is an
interactive action in the OneCLI UI. And codex's own CLI refuses the reviewed `auth.json` marker
stub with "Authentication required": its token carries an `accountId` the marker does not, so the
shape a stub needs is version-specific and has to be measured against the pinned adapter.

**Delivers.** Dockerfiles for control-plane, runtime-control and broker; a `publish` workflow with
SBOM and provenance attestation (closing S11's supply-chain item); `deploy/base/web.yaml`;
`deploy/overlays/live` with real digests and a CNPG cluster; and the twenty-odd corrections above,
each with a test that fails without it.

---

## 4. Prerequisite register

Items the specifications name as unresolved. Each is assigned to the slice that must settle it,
in the owning specification, before that slice claims acceptance. None may be filled by
inference in code.

| # | Prerequisite | Owning spec | Slice |
|---|---|---|---|
| P1 | Product authorization model (principals, per-Workstream rights, service delegation) | execution.md owners | S2 |
| P2 | Wire/storage schema for Intents, facts, commands, Sessions | ADR 0002/0004, engine.md | S2, S3, S4 |
| P3 | ACP SDK re-pin; adapter support for `set_config_option`, truthful model/effort readback after `session/resume`, embedded resource content in prompts | ADR 0004, execution.md ACP evidence | S4, S8 |
| P4 | Bridge authentication of the Pod incarnation; frame size limits; backpressure behavior | execution.md ACP evidence | S4, S8 |
| P5 | Owner request protocol shape shared by runtime-control and broker | engine.md effect ownership | S5 |
| P6 | Physical fencing mechanism for partitioned nodes; what counts as termination evidence | execution.md extinction | S6 |
| P7 | Startup, action, shutdown and preservation deadlines; claim/lease durations; retry caps; backoff bounds | engine.md retry budgets | S6, S11 |
| P8 | OneCLI capabilities: exhaustive attached/effective inventory, unknown-creation discovery, idempotency or serialized writer | ADR 0009, engine.md | S7 |
| P9 | Concrete capability→OneCLI grant mappings and the first reviewed capabilities, including model/provider access | ADR 0010, 001 | S7 |
| P10 | Relay incarnation authentication and the deterministic reachability projection | execution.md owners | S7 |
| P11 | Harness definitions: pinned digests, tool bundle content, model/effort catalogues, bootstrap authority | ADR 0006, execution.md conformance | S8 |
| P12 | Custody driver and workspace mechanism for claude-code; Save format/version; size and time limits | continuity.md | S9 |
| P13 | Seed/rendering policy revision: inclusion, order, encoding, truncation, resource access | continuity.md Handoff and seed policy | S9 |
| P14 | Retention values for Saves, staging and Workstream deletion | continuity.md storage | S9, S11 |
| P15 | Skills and selectable personas (explicitly out of scope until a taxonomy change) | 001 | not planned |

---

## 5. Milestones and risks

| Milestone | Slices | What can be shown |
|---|---|---|
| M1 — Intent loop | S1, S2 | An Intent is authored from the browser, coalesced, claimed, evaluated and converged (off) on PostgreSQL; concurrency scenarios green |
| M2 — Journal and ACP | S3, S4, S5 | Prompts to a local harness are captured losslessly, projected and streamed to the browser; owner protocol proved on fake owners |
| M3 — A Pod runs | S6, S7, S8 | Full chain on kind + OneCLI: Pod built, exact grants, live context, config verified, first admitted prompt |
| M4 — Continuity | S9 | Shutdown Save, new Pod restore, exact refill; loss exposure honest |
| M5 — Production shape | S10, S11, S12 | Two harnesses, revision publication, pinned settings, packaging, hardened UI |

**Risks worth naming now.**

- **Owner API gaps.** If OneCLI cannot enumerate effective grants or discover a lost creation,
  S7 must retain explicit uncertainty rather than promise recovery; the specs forbid the
  shortcut. Verify early (spike inside S5's fake-owner work, before S7).
- **Adapter readback.** If an adapter echoes request defaults instead of the actual resumed
  model, `SESSION-A08` fails and CONFIG cannot pass; the harness stays disabled until fixed.
- **Lossless capture versus SDK ergonomics.** Keeping the seam below the SDK constrains how the
  bridge is built; deciding it in S4 avoids a rewrite in S8.
- **Fencing.** Kubernetes offers no universal proof that a force-deleted Pod stopped; P6 may
  end as "off stays unrealized with diagnostics" for some infrastructures, which the design
  accepts but operators must know.
- **Scope creep in the rules.** Every domain addition means a new rule file inserted before
  CONVERGE and a registry change first; the vocabulary check and the partition tests are the
  guard rails.
